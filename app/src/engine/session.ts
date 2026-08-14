/**
 * The single writer for app state.
 *
 * Owns the transport, the RPC client, the build, and the tree variants, and is
 * responsible for the two things that are easy to get wrong:
 *
 *   - the ~4.2 s boot plus ~5 s first tree load must be *narrated*, not hidden
 *     behind a frozen window. `host.busy` drives that.
 *   - if the host dies, whatever the user had must come back. The engine is
 *     stateful and a restarted process knows nothing, so recovery re-loads the
 *     last source and re-applies the active variant's allocation.
 */

import type {
  BuildSummary,
  CharacterPayload,
  DisplayStat,
  MasteryEffect,
  Methods,
  NodeId,
  NodePower,
} from "@schema/rpc";

import { fetchBuildCode, looksLikeBuildLink } from "../poe-api/build-link";
import { RpcClient } from "../rpc/client";
import { describeError, RpcTransportError, ClientErrorCode } from "../rpc/errors";
import { startPowerStream, type StreamHandle } from "../rpc/stream";
import type { HostState, Transport } from "../rpc/transport";
import { createStore, type Store } from "../state/store";
import {
  addSpec,
  createSpec,
  deleteSpec as deleteSpecPure,
  diffAllocation,
  duplicateSpec as duplicateSpecPure,
  emptySpecState,
  getActive,
  getCompare,
  isNoopDiff,
  parsePlan,
  renameSpec as renameSpecPure,
  serialisePlan,
  setActive as setActivePure,
  setCompare as setComparePure,
  updateAllocation,
  type SpecState,
} from "./specs";

export type HostInfo = Methods["host.info"]["result"];

/** The engine's "this would reset your tree" report, verbatim. */
export type ClassChangeConflict = Extract<
  Methods["build.setClass"]["result"],
  { conflict: unknown }
>["conflict"];

/**
 * Three outcomes, not two: a conflict is neither success nor failure. The
 * engine deliberately changes nothing and hands the decision back
 * (`build.lua:231-247`), so the caller must be able to tell it from an error —
 * one reopens as a prompt, the other as a banner.
 */
export type SetClassResult =
  | { kind: "applied" }
  | { kind: "conflict"; conflict: ClassChangeConflict }
  | { kind: "error"; message: string };

export type ConnectionPhase =
  | "idle"
  | "spawning"
  | "handshake"
  | "ready"
  | "recovering"
  | "failed";

export interface HeatmapState {
  running: boolean;
  metric: string;
  maxDepth: number;
  done: number;
  total: number;
  /** Best nodes so far, highest value per point first. */
  nodes: NodePower[];
  elapsedMs: number | null;
  error: string | null;
}

export interface Banner {
  kind: "info" | "warn" | "error" | "success";
  text: string;
  detail?: string;
}

export interface AppState {
  connection: ConnectionPhase;
  hostState: HostState;
  hostInfo: HostInfo | null;
  /** Set while the engine reports a long blocking operation. */
  busy: { what: string; elapsedMs: number } | null;
  /** stderr from the host, shown on the splash and in diagnostics. */
  log: string[];
  connectionError: string | null;

  build: BuildSummary | null;
  stats: DisplayStat[];
  /** True while a recompute is in flight, so the panel can dim rather than jump. */
  statsPending: boolean;
  specs: SpecState;

  importPending: boolean;
  importError: string | null;

  savePending: boolean;
  heatmap: HeatmapState | null;
  banner: Banner | null;
}

const initialState: AppState = {
  connection: "idle",
  hostState: { phase: "stopped" },
  hostInfo: null,
  busy: null,
  log: [],
  connectionError: null,
  build: null,
  stats: [],
  statsPending: false,
  specs: emptySpecState(),
  importPending: false,
  importError: null,
  savePending: false,
  heatmap: null,
  banner: null,
};

/** The last thing we loaded, replayed verbatim after a crash. */
type LoadSource =
  | { kind: "code"; code: string }
  | { kind: "xml"; xml: string }
  // `CharacterPayload`, as the schema types it. It arrives already decoded from
  // the GGG endpoints, so it is the caller's job to have shaped it — the engine
  // validates it again and answers -32602 if it is wrong.
  | { kind: "character"; character: CharacterPayload; label: string }
  | { kind: "empty" };

/** `host.busy` has no terminator in the schema, so it is cleared on a timer. */
const BUSY_IDLE_MS = 900;
const MAX_LOG_LINES = 200;

export class EngineSession {
  readonly store: Store<AppState>;
  readonly client: RpcClient;
  #transport: Transport;
  #busyTimer: ReturnType<typeof setTimeout> | undefined;
  #lastSource: LoadSource | null = null;
  /** True between `reloadEngine` and the replacement process reporting ready. */
  #reloading = false;
  #heatmap: StreamHandle | null = null;
  #connectPromise: Promise<void> | null = null;

  constructor(transport: Transport) {
    this.#transport = transport;
    this.store = createStore<AppState>(initialState);
    this.client = new RpcClient(transport);

    this.client.on("host.busy", (p) => this.#onBusy(p.what, p.elapsedMs));
    this.client.onStateChange((s) => this.#onHostState(s));
    transport.onStderr((line) => this.#log(line));
  }

  get state(): AppState {
    return this.store.getState();
  }

  #set(patch: Partial<AppState> | ((p: AppState) => Partial<AppState>)) {
    this.store.setState(patch);
  }

  #log(line: string) {
    this.#set((prev) => ({
      log: [...prev.log, line].slice(-MAX_LOG_LINES),
    }));
  }

  // -------------------------------------------------------------------------
  // lifecycle

  /** Start the host and complete the handshake. Safe to call more than once. */
  async connect(): Promise<void> {
    if (this.#connectPromise) return this.#connectPromise;
    this.#connectPromise = this.#connect().finally(() => {
      this.#connectPromise = null;
    });
    return this.#connectPromise;
  }

  async #connect(): Promise<void> {
    this.#set({ connection: "spawning", connectionError: null });
    try {
      await this.#transport.start();
    } catch (err) {
      this.#set({
        connection: "failed",
        connectionError: `The calculation engine could not be launched.\n${describeError(err)}`,
      });
      return;
    }

    this.#set({ connection: "handshake" });
    try {
      const info = await this.client.call("host.info", {});
      this.#set({ connection: "ready", hostInfo: info });
      this.#log(
        `engine ready — PoB ${info.pobVersion} (${info.pobCommit.slice(0, 7)}), booted in ${(
          info.bootMs / 1000
        ).toFixed(1)}s`,
      );
    } catch (err) {
      this.#set({
        connection: "failed",
        connectionError: describeError(err),
      });
    }
  }

  async disconnect(): Promise<void> {
    this.#heatmap?.cancel().catch(() => {});
    await this.#transport.stop();
    this.client.dispose();
  }

  #onBusy(what: string, elapsedMs: number) {
    this.#set({ busy: { what, elapsedMs } });
    if (this.#busyTimer) clearTimeout(this.#busyTimer);
    this.#busyTimer = setTimeout(() => {
      this.#set({ busy: null });
    }, BUSY_IDLE_MS);
  }

  #onHostState(s: HostState) {
    this.#set({ hostState: s });

    // A reload we asked for drives its own sequence, because the old process's
    // `exited` and the new one's `ready` are separate emissions with no
    // guaranteed order — reacting to them here raced the restore and rejected
    // its handshake with "the engine stopped unexpectedly".
    if (this.#reloading) return;

    if (s.phase === "exited") {
      this.#log(`engine host exited (code ${s.code ?? "unknown"})`);
      if (s.willRestart) {
        this.#set({
          connection: "recovering",
          statsPending: false,
          banner: {
            kind: "warn",
            text: "The calculation engine crashed. Restarting and restoring your build…",
            detail: s.stderrTail || undefined,
          },
        });
      } else {
        this.#set({
          connection: "failed",
          connectionError:
            "The calculation engine keeps crashing. Check the diagnostics log.",
        });
      }
      return;
    }

    if (s.phase === "failed") {
      this.#set({ connection: "failed", connectionError: s.reason });
      return;
    }

    if (s.phase === "ready" && this.state.connection === "recovering") {
      void this.#recover();
    }
  }

  /**
   * Restart the engine deliberately and restore the build behind it.
   *
   * Used after a game-data update: the host loaded Path of Building's Lua and
   * tree data at boot, so files swapped underneath it change nothing until it
   * restarts. Entering `recovering` first is what makes `#onHostState` run
   * `#recover` when the new process reports ready — the same path a crash
   * takes, so the build is reloaded and the active variant re-applied by code
   * that is already exercised rather than a second copy of it.
   */
  async reloadEngine(reason: string): Promise<void> {
    // The supervisor's restart is a deliberate stop followed by a spawn, and a
    // stop reports `exited` with `willRestart: false` — which `#onHostState`
    // rightly reads as the engine dying for good. This flag is what separates
    // "we asked for this" from "it fell over", so the exit is not turned into a
    // failure before the replacement process has even started.
    this.#reloading = true;
    this.#set({
      connection: "recovering",
      statsPending: false,
      banner: { kind: "info", text: reason },
    });
    try {
      await this.#transport.restart();
      await this.#waitForHost();
    } catch (err) {
      this.#set({
        connection: "failed",
        connectionError: `Could not restart the engine: ${describeError(err)}`,
      });
      throw err;
    } finally {
      this.#reloading = false;
    }
    // Same restore a crash gets: reload the last source, re-apply the variant.
    await this.#recover();
  }

  /**
   * Poll until the replacement process answers.
   *
   * The engine takes ~3 s to load Path of Building, and a call made before then
   * is rejected by the transport rather than queued — so this is a probe, not a
   * wait on a promise that does not exist.
   */
  async #waitForHost(timeoutMs = 30_000): Promise<void> {
    const started = Date.now();
    let last: unknown;
    while (Date.now() - started < timeoutMs) {
      try {
        await this.client.call("host.info", {});
        return;
      } catch (err) {
        last = err;
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    throw last ?? new Error("the calculation engine did not come back");
  }

  /** Re-handshake, reload the last source, and re-apply the active variant. */
  async #recover(): Promise<void> {
    try {
      const info = await this.client.call("host.info", {});
      this.#set({ hostInfo: info });

      const source = this.#lastSource;
      if (!source) {
        this.#set({
          connection: "ready",
          banner: { kind: "success", text: "Calculation engine restarted." },
        });
        return;
      }

      await this.#loadRaw(source);

      // The reloaded build sits at whatever the source describes; push the
      // active variant's allocation back on top of it.
      const active = getActive(this.state.specs);
      if (active) await this.#applyAllocation(active.allocated);

      this.#set({
        connection: "ready",
        banner: {
          kind: "success",
          text: "Calculation engine restarted and your build was restored.",
        },
      });
    } catch (err) {
      this.#set({
        connection: "failed",
        connectionError: `Recovery failed: ${describeError(err)}`,
      });
    }
  }

  // -------------------------------------------------------------------------
  // build loading

  async loadCode(code: string): Promise<boolean> {
    return this.#load({ kind: "code", code: code.trim() });
  }

  /**
   * Import whatever the user pasted: a build code, or a link to one.
   *
   * PoB's import field takes either (`ImportTab.lua:573-640`), and for a geared
   * build the link is the reliable one — the code is long enough that hand
   * copying it truncates, which fails to inflate with nothing useful to say.
   */
  async loadCodeOrLink(input: string): Promise<boolean> {
    const trimmed = input.trim();
    if (!looksLikeBuildLink(trimmed)) return this.loadCode(trimmed);

    this.#set({ importPending: true, importError: null });
    let code: string;
    try {
      code = await fetchBuildCode(trimmed);
    } catch (err) {
      this.#set({ importPending: false, importError: describeError(err) });
      return false;
    }
    return this.loadCode(code);
  }

  async loadXml(xml: string): Promise<boolean> {
    return this.#load({ kind: "xml", xml });
  }

  async loadCharacter(character: CharacterPayload, label: string): Promise<boolean> {
    return this.#load({ kind: "character", character, label });
  }

  async loadEmpty(): Promise<boolean> {
    return this.#load({ kind: "empty" });
  }

  async #load(source: LoadSource): Promise<boolean> {
    this.#set({ importPending: true, importError: null });
    try {
      const summary = await this.#loadRaw(source);
      this.#lastSource = source;

      // A freshly loaded build becomes the first variant.
      const spec = createSpec({
        title: "Imported tree",
        treeVersion: summary.treeVersion,
        allocated: summary.allocated,
        pointsUsed: summary.pointsUsed,
      });
      const specs = addSpec(emptySpecState(), spec);

      this.#set({ specs, importPending: false, heatmap: null });
      await this.refreshStats();
      return true;
    } catch (err) {
      this.#set({
        importPending: false,
        importError: describeError(err),
      });
      return false;
    }
  }

  async #loadRaw(source: LoadSource): Promise<BuildSummary> {
    const params: Methods["build.load"]["params"] =
      source.kind === "code"
        ? { code: source.code }
        : source.kind === "xml"
          ? { xml: source.xml }
          : source.kind === "character"
            ? { character: source.character }
            : { empty: true };

    const summary = await this.client.call("build.load", params);
    this.#set({ build: summary });
    return summary;
  }

  // -------------------------------------------------------------------------
  // stats

  /**
   * Recompute the stat panel. A recompute is ~78 ms, so this runs on every
   * edit rather than behind a button.
   */
  async refreshStats(): Promise<void> {
    if (this.state.connection !== "ready") return;
    const compare = getCompare(this.state.specs);
    this.#set({ statsPending: true });
    try {
      const params: Methods["stats.get"]["params"] = compare
        ? { compareTo: compare.allocated }
        : {};
      const { stats } = await this.client.call("stats.get", params);
      this.#set({ stats, statsPending: false });
    } catch (err) {
      this.#set({
        statsPending: false,
        banner: { kind: "error", text: describeError(err) },
      });
    }
  }

  // -------------------------------------------------------------------------
  // tree edits

  async allocate(nodes: NodeId[], path?: NodeId[]): Promise<void> {
    if (!nodes.length) return;
    this.#set({ statsPending: true });
    try {
      const res = await this.client.call("tree.allocate", path ? { nodes, path } : { nodes });
      this.#afterTreeEdit(res.summary, res.stats);
    } catch (err) {
      this.#set({ statsPending: false, banner: { kind: "error", text: describeError(err) } });
    }
  }

  /**
   * Choose (or clear) a mastery's effect.
   *
   * A mastery is not allocated by clicking it: PoB opens a chooser and only
   * spends the point once an effect is picked (`TreeTab.lua:992-1009`). The
   * engine answers with the refreshed availability for *every* mastery, not
   * just this one, because taking an effect here can remove it from another
   * mastery's list — each effect may be used only once across the tree.
   */
  async setMastery(
    node: NodeId,
    effect: number | null,
  ): Promise<Record<NodeId, MasteryEffect[]> | null> {
    this.#set({ statsPending: true });
    try {
      const res = await this.client.call("tree.setMastery", { node, effect });
      this.#afterTreeEdit(res.summary, res.stats);
      return res.masteryEffects ?? null;
    } catch (err) {
      this.#set({ statsPending: false, banner: { kind: "error", text: describeError(err) } });
      return null;
    }
  }

  /**
   * Node ids matching a search, using PoB's own matcher.
   *
   * `tree.search` runs `DoesNodeMatchSearchParams` (PassiveTreeView.lua:1323)
   * inside the engine rather than filtering names here, so quoted phrases and
   * stat-text matching behave exactly as they do in PoB.
   */
  async search(query: string): Promise<NodeId[]> {
    if (!query.trim()) return [];
    try {
      const res = await this.client.call("tree.search", { query });
      return res.matches;
    } catch {
      return [];
    }
  }

  /** Jewel radius overlays for the current tree (`tree.jewels`). */
  async jewelRadii(): Promise<Methods["tree.jewels"]["result"] | null> {
    try {
      return await this.client.call("tree.jewels", {});
    } catch {
      // Not fatal: the tree renders without the overlays.
      return null;
    }
  }

  async deallocate(nodes: NodeId[]): Promise<void> {
    if (!nodes.length) return;
    this.#set({ statsPending: true });
    try {
      const res = await this.client.call("tree.deallocate", { nodes });
      this.#afterTreeEdit(res.summary, res.stats);
      if (res.orphaned.length) {
        this.#set({
          banner: {
            kind: "info",
            text: `${res.orphaned.length} node${res.orphaned.length === 1 ? "" : "s"} became unreachable and were removed.`,
          },
        });
      }
    } catch (err) {
      this.#set({ statsPending: false, banner: { kind: "error", text: describeError(err) } });
    }
  }

  // -------------------------------------------------------------------------
  // class and ascendancy

  /**
   * Change base class and/or ascendancy.
   *
   * With `onConflict` unset the engine refuses to make a destructive change on
   * its own: if the new class would reset the tree it mutates nothing and
   * returns a `conflict` for the user to answer. That is not an error, so it
   * raises no banner — the caller reopens it as a prompt and calls back.
   */
  async setClass(params: Methods["build.setClass"]["params"]): Promise<SetClassResult> {
    this.#set({ statsPending: true });
    try {
      const res = await this.client.call("build.setClass", params);
      if (res.conflict) {
        this.#set({ statsPending: false });
        return { kind: "conflict", conflict: res.conflict };
      }
      this.#afterTreeEdit(res.summary, res.stats);
      return { kind: "applied" };
    } catch (err) {
      const message = describeError(err);
      this.#set({ statsPending: false, banner: { kind: "error", text: message } });
      return { kind: "error", message };
    }
  }

  /**
   * The whole "clicked a node of another ascendancy" interaction.
   *
   * PoB switches first and allocates the clicked node second — its
   * `allocateClickedAscendancy` runs inside every branch of the switch
   * (`PassiveTreeView.lua:449-491`), including both answers to the prompt. So
   * the allocation waits on the class change here too, and is skipped entirely
   * when the switch did not happen.
   */
  async selectAscendancy(
    target: { node: NodeId; ascendancy: string; className: string },
    onConflict?: "connect" | "reset",
  ): Promise<SetClassResult> {
    // `ascendancy` is PoB's ascendClass *id*, the form node data uses. The
    // engine's `ascendNameMap` is keyed by id and display name alike
    // (`PassiveTree.lua:170-174`), and the id is the one that cannot be
    // ambiguous between classes.
    const res = await this.setClass({
      className: target.className,
      ascendClassName: target.ascendancy,
      ...(onConflict ? { onConflict } : {}),
    });
    if (res.kind !== "applied") return res;

    // Selecting an ascendancy already allocates its start node; the clicked
    // node is a separate allocation, unless a reset-and-reconnect happened to
    // bring it along.
    if (!this.state.build?.allocated.includes(target.node)) {
      await this.allocate([target.node]);
    }
    return res;
  }

  #afterTreeEdit(summary: BuildSummary, stats: DisplayStat[]) {
    const active = getActive(this.state.specs);
    this.#set((prev) => ({
      build: summary,
      stats,
      statsPending: false,
      specs: active
        ? updateAllocation(prev.specs, active.id, summary.allocated, summary.pointsUsed)
        : prev.specs,
    }));
    // A compare column needs deltas, which only `stats.get` returns.
    if (getCompare(this.state.specs)) void this.refreshStats();
  }

  /** Drive the engine's allocation to exactly `target`. */
  async #applyAllocation(target: NodeId[]): Promise<BuildSummary | null> {
    const current = this.state.build?.allocated ?? [];
    const diff = diffAllocation(current, target);
    if (isNoopDiff(diff)) return this.state.build;

    let summary = this.state.build;
    // Remove first: allocating before deallocating can blow the point budget.
    if (diff.remove.length) {
      const res = await this.client.call("tree.deallocate", { nodes: diff.remove });
      summary = res.summary;
    }
    if (diff.add.length) {
      const res = await this.client.call("tree.allocate", { nodes: diff.add });
      summary = res.summary;
    }
    if (summary) this.#set({ build: summary });
    return summary;
  }

  // -------------------------------------------------------------------------
  // tree variants

  async selectSpec(id: string): Promise<void> {
    const next = setActivePure(this.state.specs, id);
    if (next === this.state.specs) return;
    const target = next.specs.find((s) => s.id === id);
    if (!target) return;

    this.#set({ specs: next, statsPending: true });
    try {
      await this.#applyAllocation(target.allocated);
      await this.refreshStats();
    } catch (err) {
      this.#set({ statsPending: false, banner: { kind: "error", text: describeError(err) } });
    }
  }

  newSpec(opts: { fromCurrent?: boolean } = {}): void {
    const build = this.state.build;
    const spec = createSpec({
      title: opts.fromCurrent ? "Tree" : "Blank tree",
      treeVersion: build?.treeVersion ?? this.state.hostInfo?.treeVersions[0] ?? "unknown",
      allocated: opts.fromCurrent ? (build?.allocated ?? []) : [],
      pointsUsed: opts.fromCurrent ? (build?.pointsUsed ?? 0) : 0,
    });
    this.#set((prev) => ({ specs: addSpec(prev.specs, spec) }));
  }

  duplicateSpec(id: string): void {
    this.#set((prev) => ({ specs: duplicateSpecPure(prev.specs, id) }));
    const active = getActive(this.state.specs);
    if (active) void this.selectSpec(active.id);
  }

  deleteSpec(id: string): void {
    const before = this.state.specs;
    const after = deleteSpecPure(before, id);
    if (after === before) {
      this.#set({
        banner: { kind: "info", text: "A build needs at least one tree variant." },
      });
      return;
    }
    this.#set({ specs: after });
    if (before.activeId === id && after.activeId) {
      void this.selectSpec(after.activeId);
    } else if (before.compareId === id) {
      void this.refreshStats();
    }
  }

  renameSpec(id: string, title: string): void {
    this.#set((prev) => ({ specs: renameSpecPure(prev.specs, id, title) }));
  }

  setCompare(id: string | null): void {
    const next = setComparePure(this.state.specs, id);
    if (next === this.state.specs) return;
    this.#set({ specs: next });
    void this.refreshStats();
  }

  // -------------------------------------------------------------------------
  // heatmap

  startHeatmap(metric: string, maxDepth = 3): void {
    if (this.state.connection !== "ready") return;
    this.#heatmap?.cancel().catch(() => {});
    this.#set({
      heatmap: {
        running: true,
        metric,
        maxDepth,
        done: 0,
        total: 0,
        nodes: [],
        elapsedMs: null,
        error: null,
      },
    });

    // Batches arrive ordered by path distance, so the useful nodes land in the
    // first couple of seconds; the list is kept sorted and capped.
    this.#heatmap = startPowerStream(
      this.client,
      { metric, maxDepth },
      {
        onBatch: (nodes, progress) => {
          this.#set((prev) => {
            if (!prev.heatmap) return {};
            const merged = [...prev.heatmap.nodes, ...nodes]
              .sort((a, b) => b.perPoint - a.perPoint)
              .slice(0, 200);
            return {
              heatmap: { ...prev.heatmap, ...progress, nodes: merged },
            };
          });
        },
        onDone: ({ elapsedMs }) => {
          this.#set((prev) =>
            prev.heatmap
              ? { heatmap: { ...prev.heatmap, running: false, elapsedMs } }
              : {},
          );
          this.#heatmap = null;
        },
        onError: (err) => {
          const cancelled =
            err instanceof RpcTransportError && err.code === ClientErrorCode.CANCELLED;
          this.#set((prev) =>
            prev.heatmap
              ? {
                  heatmap: {
                    ...prev.heatmap,
                    running: false,
                    error: cancelled ? null : describeError(err),
                  },
                }
              : {},
          );
          this.#heatmap = null;
        },
      },
    );
  }

  cancelHeatmap(): void {
    this.#heatmap?.cancel().catch(() => {});
  }

  // -------------------------------------------------------------------------
  // save / load

  async exportBuild(as: "xml" | "code"): Promise<string> {
    const { data } = await this.client.call("build.save", { as });
    return data;
  }

  /** The full plan document: the build plus every variant. */
  async serialisePlan(): Promise<string> {
    const xml = await this.exportBuild("xml");
    const build = this.state.build;
    return serialisePlan(xml, this.state.specs, {
      name: build?.name,
      className: build?.ascendClassName || build?.className,
      level: build?.level,
    });
  }

  async openPlan(text: string): Promise<boolean> {
    this.#set({ importPending: true, importError: null });
    try {
      const plan = parsePlan(text);
      const summary = await this.#loadRaw({ kind: "xml", xml: plan.buildXml });
      this.#lastSource = { kind: "xml", xml: plan.buildXml };

      let specs: SpecState =
        plan.specs.length > 0
          ? {
              specs: plan.specs,
              activeId: plan.activeId ?? plan.specs[0]!.id,
              compareId: plan.compareId,
            }
          : addSpec(
              emptySpecState(),
              createSpec({
                title: "Imported tree",
                treeVersion: summary.treeVersion,
                allocated: summary.allocated,
                pointsUsed: summary.pointsUsed,
              }),
            );
      // Guard against a hand-edited file naming a variant that is not there.
      if (!specs.specs.some((s) => s.id === specs.activeId)) {
        specs = { ...specs, activeId: specs.specs[0]!.id };
      }

      this.#set({ specs, importPending: false, heatmap: null });
      const active = getActive(specs);
      if (active) await this.#applyAllocation(active.allocated);
      await this.refreshStats();
      return true;
    } catch (err) {
      this.#set({ importPending: false, importError: describeError(err) });
      return false;
    }
  }

  dismissBanner(): void {
    this.#set({ banner: null });
  }

  setBanner(banner: Banner | null): void {
    this.#set({ banner });
  }
}
