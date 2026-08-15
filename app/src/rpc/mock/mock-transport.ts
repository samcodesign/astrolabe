/**
 * An in-process fake of the engine host.
 *
 * It exists for two reasons: Track 1's `serve` mode is not finished, and the
 * app has to be runnable in a plain browser (`npm run dev`) where no sidecar
 * exists at all. It reproduces the *timings* from the schema header, because
 * the startup and heatmap UX is entirely about those numbers:
 *
 *   boot 4.2 s, first tree load 5 s, recompute 78 ms, heatmap ~18 s.
 *
 * Set `speed: "instant"` in tests.
 *
 * `tree.geometry` is the one response that is not synthesised. The renderer
 * needs real sprite rects, connector UVs and 2,872 nodes to draw anything at
 * all, and a plausible-looking fake produced a blank canvas that looked exactly
 * like a broken renderer. In a browser it serves the recorded engine export
 * from `/fixtures`; under Node (tests) that fetch has no server, so it falls
 * back to the synthetic tree, which is all the tests need.
 */

import type {
  BuildSummary,
  DisplayStat,
  Item,
  Methods,
  ConfigState,
  CustomModBlock,
  ItemsState,
  MainSkillSelection,
  SkillsState,
  NodeId,
  NodePower,
} from "@schema/rpc";
import {
  adjacencyFromNodes,
  pathToNode,
  type TreeNode,
} from "@poe-planner/tree-renderer-pkg";
import { Emitter, type HostState, type Transport } from "../transport";
import {
  applyMainSkill,
  applyConfigSetEdit,
  applySkillEdit,
  applyCustomModEdit,
  applyItemEdit,
  applySkillSetEdit,
  MOCK_TREE_VERSION,
  mockConfigSchema,
  mockConfigState,
  mockCustomMods,
  mockGemCatalogue,
  mockGeometry,
  mockItems,
  mockMainSkill,
  mockModPool,
  mockModSources,
  mockSkills,
  mockValidateMods,
  mockStatDeltas,
  mockStats,
  mockSummary,
} from "./fixtures";

export interface MockTransportOptions {
  /** "real" reproduces measured latencies; "instant" removes all of them. */
  speed?: "real" | "instant";
  /** Fail the next N `build.load` calls, to exercise error surfaces. */
  failLoads?: number;
  /** Crash the host this many ms after `start()` resolves. */
  crashAfterMs?: number;
}

const REAL = {
  boot: 4_200,
  treeLoad: 5_000,
  recompute: 78,
  heatmapTotal: 18_000,
  batch: 400,
};

/**
 * The recorded `tree.geometry` export, fetched once. Falls back to the
 * synthetic tree when there is nothing to fetch it from.
 */
let geometryPromise: Promise<Methods["tree.geometry"]["result"]> | null = null;

function realGeometry(): Promise<Methods["tree.geometry"]["result"]> {
  geometryPromise ??= (async () => {
    if (typeof fetch !== "function" || typeof window === "undefined") {
      return mockGeometry();
    }
    try {
      const res = await fetch("/fixtures/geometry-3_29.json");
      if (!res.ok) return mockGeometry();
      return (await res.json()) as Methods["tree.geometry"]["result"];
    } catch {
      return mockGeometry();
    }
  })();
  return geometryPromise;
}

/**
 * A real route to `to`, over the same geometry `tree.geometry` served.
 *
 * The previous stand-in returned four ids from the synthetic tree. Against real
 * geometry none of them exist, so the hover preview highlighted nothing and
 * looked exactly like a renderer that had stopped working. Using the ported PoB
 * pathing keeps the mock's answers inside the tree it handed out.
 */
async function realPath(to: NodeId, allocated: readonly NodeId[]): Promise<NodeId[] | null> {
  const geometry = await realGeometry();
  // The schema's TreeNode and the renderer's mirror describe the same payload;
  // the renderer's is the stricter of the two.
  const nodes = geometry.nodes as unknown as TreeNode[];
  adjacency ??= adjacencyFromNodes(nodes);
  const found = pathToNode(to, nodes, adjacency, new Set(allocated));
  return found ? found.path : null;
}

/** Built once from the served geometry; the mock never mutates the tree. */
let adjacency: ReturnType<typeof adjacencyFromNodes> | null = null;

/** Where a class's tree begins, from the geometry's own `classes` table. */
async function classStartNode(className: string): Promise<NodeId | null> {
  const geometry = await realGeometry();
  const found = geometry.classes?.find((c) => c.name === className);
  return found ? found.startNodeId : null;
}

export class MockTransport implements Transport {
  #messages = new Emitter<unknown>();
  #states = new Emitter<HostState>();
  #stderr = new Emitter<string>();
  #state: HostState = { phase: "stopped" };
  #opts: Required<Pick<MockTransportOptions, "speed">> & MockTransportOptions;
  #summary: BuildSummary = mockSummary();
  #baseline: DisplayStat[] = mockStats();
  #mainSkill: MainSkillSelection = mockMainSkill();
  #config: ConfigState = mockConfigState();
  #skills: SkillsState = mockSkills();
  #customMods: CustomModBlock[] = mockCustomMods();
  #items: ItemsState = mockItems();
  #loadedVersions = new Set<string>();
  #timers = new Set<ReturnType<typeof setTimeout>>();
  #powerCancelled = false;
  #attempt = 0;

  constructor(opts: MockTransportOptions = {}) {
    this.#opts = { speed: "real", ...opts };
  }

  get state(): HostState {
    return this.#state;
  }

  onMessage(cb: (m: unknown) => void) {
    return this.#messages.on(cb);
  }
  onState(cb: (s: HostState) => void) {
    return this.#states.on(cb);
  }
  onStderr(cb: (l: string) => void) {
    return this.#stderr.on(cb);
  }

  async start(): Promise<void> {
    this.#attempt++;
    this.#setState({ phase: "starting", attempt: this.#attempt });
    // The host prints boot progress on stderr; the splash mirrors it.
    this.#later(this.#ms(300), () =>
      // Shape of the real line, without a real path — this is demo output and
      // should not carry anyone's home directory.
      this.#stderr.emit("Path of Building: <app data>/PathOfBuilding"),
    );
    this.#later(this.#ms(REAL.boot * 0.8), () =>
      this.#stderr.emit("loading modules..."),
    );
    await this.#sleep(this.#ms(REAL.boot));
    this.#stderr.emit(`engine booted in ${(REAL.boot / 1000).toFixed(2)}s`);
    this.#setState({ phase: "ready" });

    if (this.#opts.crashAfterMs !== undefined) {
      this.#later(this.#opts.crashAfterMs, () => this.simulateCrash());
    }
  }

  async stop(): Promise<void> {
    for (const t of this.#timers) clearTimeout(t);
    this.#timers.clear();
    this.#setState({ phase: "stopped" });
  }

  /** No separate process to cycle, so a fresh start is the whole of it. */
  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  /** Test/demo hook: pretend the process died. */
  simulateCrash(willRestart = true): void {
    for (const t of this.#timers) clearTimeout(t);
    this.#timers.clear();
    this.#stderr.emit("lua: attempt to index a nil value (field 'actor')");
    this.#setState({
      phase: "exited",
      code: 101,
      stderrTail: "lua: attempt to index a nil value (field 'actor')",
      willRestart,
    });
  }

  async send(frame: string): Promise<void> {
    if (this.#state.phase !== "ready") {
      throw new Error("mock host is not ready");
    }
    let req: { id: number; method: keyof Methods; params: Record<string, unknown> };
    try {
      req = JSON.parse(frame);
    } catch {
      return;
    }
    void this.#handle(req);
  }

  // -------------------------------------------------------------------------

  async #handle(req: {
    id: number;
    method: keyof Methods;
    params: Record<string, unknown>;
  }): Promise<void> {
    const { id, method, params } = req;
    const ok = (result: unknown) =>
      this.#messages.emit({ jsonrpc: "2.0", id, result });
    const fail = (code: number, message: string, data?: string) =>
      this.#messages.emit({ jsonrpc: "2.0", id, error: { code, message, data } });

    switch (method) {
      case "host.info":
        await this.#sleep(this.#ms(5));
        return ok({
          hostVersion: "0.1.0-mock",
          pobVersion: "2.42.0",
          pobCommit: "0000000",
          treeVersions: ["3_13", "3_18", "3_21", "3_25"],
          bootMs: REAL.boot,
        } satisfies Methods["host.info"]["result"]);

      case "build.load": {
        if (this.#opts.failLoads && this.#opts.failLoads > 0) {
          this.#opts.failLoads--;
          await this.#sleep(this.#ms(200));
          return fail(
            -32000,
            "could not decode build: the share code is not valid base64",
            "stack traceback:\n\tCommon.lua:412: in function 'base64Decode'",
          );
        }
        const cold = !this.#loadedVersions.has(MOCK_TREE_VERSION);
        if (cold) {
          // The 5 s first-load. This is what `host.busy` exists for.
          await this.#busy(`loading passive tree ${MOCK_TREE_VERSION}`, this.#ms(REAL.treeLoad));
          this.#loadedVersions.add(MOCK_TREE_VERSION);
        }
        const src = params["code"]
          ? "code"
          : params["xml"]
            ? "xml"
            : params["character"]
              ? "character"
              : "empty";
        // A new build is not an empty allocation set: `SelectClass` allocates
        // the class's start node (PassiveSpec.lua:578), and that node is the
        // only thing pathing can start from. Without it every hover preview
        // correctly finds no route, which reads as a broken preview.
        const startNode = await classStartNode("Scion");
        this.#summary = mockSummary(
          src === "empty"
            ? {
                name: "New Build",
                className: "Scion",
                ascendClassName: "None",
                level: 1,
                allocated: startNode === null ? [] : [startNode],
                pointsUsed: 0,
                pointsTotal: 123,
                ascendancyPointsUsed: 0,
              }
            : src === "character"
              ? {
                  // The real engine names the build from the nested character
                  // object, falling back to the payload's `character` field —
                  // the character name (api/build.lua `characterData`). There is
                  // no top-level `name` in `CharacterPayload`.
                  name: String(
                    (params["character"] as { character?: string })?.character ??
                      "Imported Character",
                  ),
                }
              : {},
        );
        this.#baseline = src === "empty" ? mockStats(0.05) : mockStats();
        return ok(this.#summary);
      }

      case "build.summary":
        return ok(this.#summary);

      case "skills.mainSelection":
        return ok(this.#mainSkill);

      case "skills.list":
        return ok(this.#skills);

      case "skills.gemCatalogue":
        return ok({ gems: mockGemCatalogue() });

      // Every skills mutation answers with the same shape, so the mock applies
      // the edit to its own copy and replies once.
      case "skills.newSet":
      case "skills.activateSet":
      case "skills.deleteSet":
      case "skills.renameSet": {
        await this.#sleep(this.#ms(REAL.recompute));
        const { skills, createdSet } = applySkillSetEdit(this.#skills, method, params);
        this.#skills = skills;
        if (method === "skills.renameSet") return ok({ skills });
        const res: Record<string, unknown> = {
          summary: this.#summary,
          stats: this.#baseline,
          skills,
          mainSkill: this.#mainSkill,
        };
        if (createdSet != null) res["createdSet"] = createdSet;
        return ok(res);
      }

      case "skills.addGroup":
      case "skills.setGroup":
      case "skills.deleteGroup":
      case "skills.setGem":
      case "skills.deleteGem":
      case "skills.setImbuedSupport":
      case "skills.reorderGem": {
        await this.#sleep(this.#ms(REAL.recompute));
        const { skills, addedGroup } = applySkillEdit(this.#skills, method, params);
        this.#skills = skills;
        const res: Record<string, unknown> = {
          summary: this.#summary,
          stats: this.#baseline,
          skills: this.#skills,
          mainSkill: this.#mainSkill,
        };
        if (addedGroup != null) res["addedGroup"] = addedGroup;
        return ok(res);
      }

      case "config.newSet":
      case "config.activateSet":
      case "config.deleteSet":
      case "config.renameSet": {
        await this.#sleep(this.#ms(REAL.recompute));
        const { config, createdSet } = applyConfigSetEdit(this.#config, method, params);
        this.#config = config;
        if (method === "config.renameSet") return ok({ config });
        const res: Record<string, unknown> = {
          summary: this.#summary,
          stats: this.#baseline,
          config,
        };
        if (createdSet != null) res["createdSet"] = createdSet;
        return ok(res);
      }

      case "config.customMods":
        return ok({ blocks: this.#customMods });

      case "config.validateMods":
        return ok({ lines: mockValidateMods(String(params["text"] ?? "")) });

      case "config.addCustomMod":
      case "config.setCustomMod":
      case "config.deleteCustomMod": {
        await this.#sleep(this.#ms(REAL.recompute));
        const { blocks, addedBlock } = applyCustomModEdit(this.#customMods, method, params);
        this.#customMods = blocks;
        const res: Record<string, unknown> = {
          summary: this.#summary,
          stats: this.#baseline,
          config: this.#config,
          customMods: { blocks },
        };
        if (addedBlock != null) res["addedBlock"] = addedBlock;
        return ok(res);
      }

      case "config.schema":
        return ok({ sections: mockConfigSchema() });

      case "config.state":
        return ok(this.#config);

      case "config.set": {
        await this.#sleep(this.#ms(REAL.recompute));
        const values = (params["values"] ?? {}) as Record<string, string | number | boolean>;
        const clear = (params["clear"] ?? []) as string[];
        const next = { ...this.#config.values, ...values };
        for (const v of clear) delete next[v];
        this.#config = { ...this.#config, values: next };
        return ok({ summary: this.#summary, stats: this.#baseline, config: this.#config });
      }

      // A comparison costs a full recalculation in the real engine, so the
      // mock charges the same — the debounce and the "one at a time" chain in
      // the session only get exercised if this is slow enough to overlap.
      case "stats.compare": {
        await this.#sleep(this.#ms(REAL.recompute));
        const change = params["change"] as Record<string, unknown> | undefined;
        if (!change || typeof change["kind"] !== "string") {
          return fail(-32602, "stats.compare needs a change object");
        }
        // Reject exactly what the engine rejects. A mock that accepts a
        // malformed change lets a client ship code that only fails against the
        // real sidecar — which is the one place it is expensive to find out.
        const kind = change["kind"] as string;
        const needs: Record<string, string[]> = {
          item: ["slot"],
          gem: ["group", "gem", "gemId"],
          gemEnabled: ["group", "gem"],
          gemQuality: ["group", "gem", "value"],
          gemLevel: ["group", "gem", "value"],
          gemCount: ["group", "gem", "value"],
          config: ["var"],
        };
        const required = needs[kind];
        if (!required) return fail(-32602, `cannot compare a change of kind ${kind}`);
        for (const field of required) {
          if (change[field] === undefined) {
            return fail(-32602, `a ${kind} comparison needs ${field}`);
          }
        }
        if (kind === "config" && change["value"] === undefined && change["clear"] !== true) {
          return fail(-32602, "a config comparison needs a value, or clear");
        }
        if (kind === "item") {
          const slot = this.#items.slots.find((s) => s.name === change["slot"]);
          if (!slot) return fail(-32602, `no such slot: ${change["slot"]}`);
          const wanted = change["item"];
          if (wanted !== undefined && wanted !== false
            && !this.#items.items.some((i) => i.id === wanted)) {
            return fail(-32602, `no such item: ${wanted}`);
          }
          // Replacing an item with itself is a no-op — except for a flask,
          // which toggles. Reproducing that here is what lets the UI's
          // "already equipped" case be exercised without the sidecar.
          const item = this.#items.items.find((i) => i.id === wanted);
          if (item && slot.itemId === item.id && item.type !== "Flask") {
            return ok({ stats: [] });
          }
        }
        // Stable per change, so re-hovering the same row is not a new answer.
        const seed = [...JSON.stringify(change)].reduce((a, c) => a + c.charCodeAt(0), 0);
        return ok({ stats: mockStatDeltas(seed) });
      }

      case "items.list":
        return ok(this.#items);

      case "items.slotsFor": {
        const item = this.#items.items.find((i) => i.id === params["item"]);
        if (!item) return fail(-32602, `no such item: ${params["item"]}`);
        // A crude stand-in for PoB's `IsItemValidForSlot`. It only has to be
        // *no more permissive* than the engine — the real rules (quiver needs a
        // bow, wand pairs with wand) are answered by the sidecar, and a mock
        // that allowed more would let a bad UI through.
        const slots = this.#items.slots
          .filter((s) => s.shown && !s.nodeId)
          .filter((s) => {
            if (item.type === "Jewel") return false;
            if (item.type === "Flask") return s.name.startsWith("Flask");
            if (item.type === "Ring") return s.name.startsWith("Ring");
            return s.name === item.type || s.label === item.type;
          })
          .map((s) => s.name);
        return ok({ slots });
      }

      case "items.modSources": {
        const item = this.#items.items.find((i) => i.id === params["item"]);
        if (!item) return fail(-32602, `no such item: ${params["item"]}`);
        return ok({ sources: mockModSources(item) });
      }

      case "items.modPool": {
        const item = this.#items.items.find((i) => i.id === params["item"]);
        if (!item) return fail(-32602, `no such item: ${params["item"]}`);
        const source = params["source"] as string;
        if (!mockModSources(item).some((s) => s.id === source)) {
          return fail(-32602, `no such mod source: ${source}`);
        }
        const mods = mockModPool(item, source, params["search"] as string | undefined);
        return ok({ mods, total: mods.length });
      }


      case "items.paste":
      case "items.equip":
      case "items.delete":
      case "items.setModRange":
      case "items.setVariant":
      case "items.newSet":
      case "items.activateSet":
      case "items.renameSet":
      case "items.deleteSet":
      case "items.addMod":
      case "items.removeMod":
      case "items.optimiseSockets":
      case "items.setWeaponSwap": {
        // Reject exactly what the engine rejects. A mock that is easier than
        // the sidecar is how a client ships code that only fails against the
        // real thing — it has already happened twice on this project.
        if (method === "items.paste") {
          const text = params["text"];
          if (typeof text !== "string" || !text.trim()) {
            return fail(-32602, "items.paste needs the item text");
          }
          if (!/^\s*Rarity:/i.test(text)) {
            return fail(-32602, "that does not look like an item");
          }
        }
        if (method === "items.equip") {
          const slot = this.#items.slots.find((s) => s.name === params["slot"]);
          if (!slot) return fail(-32602, `no such slot: ${params["slot"]}`);
          const wanted = params["item"];
          if (wanted !== false && wanted != null) {
            const item = this.#items.items.find((i) => i.id === wanted);
            if (!item) return fail(-32602, `cannot equip unknown item: ${wanted}`);
            const legal = slot.name === item.type
              || (item.type === "Flask" && slot.name.startsWith("Flask"))
              || (item.type === "Ring" && slot.name.startsWith("Ring"))
              || (item.type === "Jewel" && slot.nodeId != null);
            if (!legal) {
              return fail(-32602, `${item.title ?? item.name} cannot go in ${slot.name}`);
            }
          }
        }
        if (method === "items.delete" || method === "items.setModRange" || method === "items.setVariant") {
          if (!this.#items.items.some((i) => i.id === params["item"])) {
            return fail(-32602, `no such item: ${params["item"]}`);
          }
        }
        if (method === "items.activateSet" || method === "items.renameSet" || method === "items.deleteSet") {
          if (!this.#items.sets.some((s) => s.id === params["id"])) {
            return fail(-32602, `no such item set: ${params["id"]}`);
          }
          if (method === "items.deleteSet" && this.#items.sets.length <= 1) {
            return fail(-32602, "a build must keep at least one item set");
          }
        }
        if (method === "items.setWeaponSwap" && typeof params["enabled"] !== "boolean") {
          return fail(-32602, "enabled must be true or false");
        }
        if (method === "items.addMod") {
          const item = this.#items.items.find((i) => i.id === params["item"]);
          if (!item) return fail(-32602, `no such item: ${params["item"]}`);
          if (params["source"] === "CUSTOM") {
            const text = params["text"];
            if (typeof text !== "string" || !text.trim()) {
              return fail(-32602, "a custom modifier needs some text");
            }
          } else {
            const pool = mockModPool(item, params["source"] as string);
            if (!pool.some((m) => m.index === params["index"])) {
              return fail(-32602, `no modifier ${params["index"]} in ${params["source"]}`);
            }
          }
        }
        if (method === "items.removeMod") {
          const item = this.#items.items.find((i) => i.id === params["item"]);
          const list = item?.mods?.[params["list"] as keyof NonNullable<Item["mods"]>];
          if (!list?.some((m) => m.index === params["index"])) {
            return fail(-32602, `no such modifier ${params["index"]}`);
          }
        }
        if (method === "items.optimiseSockets") {
          const slot = this.#items.slots.find((s) => s.name === params["slot"]);
          if (!slot) return fail(-32602, `no such slot: ${params["slot"]}`);
          const worn = this.#items.items.find((i) => i.id === slot.itemId);
          if (!worn) return fail(-32602, `nothing is equipped in ${slot.name}`);
          // The engine refuses a base with no sockets at all, and so must this.
          if (!worn.sockets || worn.sockets.length === 0) {
            return fail(-32602, `${worn.title ?? worn.baseName} has no sockets`);
          }
        }

        await this.#sleep(this.#ms(REAL.recompute));
        const next = applyItemEdit(this.#items, method, params);
        const { createdSet, ...state } = next;
        this.#items = state;
        return ok({
          summary: this.#summary,
          stats: this.#baseline,
          items: this.#items,
          ...(createdSet !== undefined ? { createdSet } : {}),
          // Optimising re-resolves the socket groups, so the engine answers
          // with those too.
          ...(method === "items.optimiseSockets" ? { skills: this.#skills } : {}),
        });
      }

      case "build.setMainSkill": {
        await this.#sleep(this.#ms(REAL.recompute));
        this.#mainSkill = applyMainSkill(this.#mainSkill, params);
        // Both slices read `build.mainSocketGroup` in the engine, so they
        // cannot disagree there; the mock has to keep them in step by hand or
        // a skill-set switch remembers the wrong group.
        this.#skills = { ...this.#skills, mainGroup: this.#mainSkill.groupIndex };
        return ok({
          summary: this.#summary,
          stats: this.#baseline,
          mainSkill: this.#mainSkill,
        });
      }

      case "build.save":
        await this.#sleep(this.#ms(40));
        return ok({
          data:
            params["as"] === "code"
              ? "eNrtWk1v2zgQvfdXCD4XsiRbjg-2gTZpsQtsgSDpYo-FLNGxUElUSSqO99fvkPqwKFGyLNlpsm2AILY0nHnzhpwZ0lp82IeB8YgpiwhezhzTnhkYe8SP8MNy9vXus7mYfVi9WcQ4WMy-mB6JCX3vaR8"
              : '<?xml version="1.0" encoding="UTF-8"?>\n<PathOfBuilding>\n  <Build level="92" targetVersion="3_0" className="Shadow" ascendClassName="Trickster"/>\n</PathOfBuilding>',
        });

      case "stats.get": {
        await this.#sleep(this.#ms(REAL.recompute));
        const keys = params["keys"] as string[] | undefined;
        const compareTo = params["compareTo"] as number[] | undefined;
        let stats = this.#baseline;
        if (compareTo) {
          // Pretend the comparison allocation is slightly worse on offence and
          // better on defence, scaled by how different the two sets are.
          const other = mockStats(0.92);
          const byKey = new Map(other.map((s) => [s.key, s]));
          stats = stats.map((s) => {
            const o = byKey.get(s.key);
            if (typeof s.value !== "number" || typeof o?.value !== "number") return s;
            return { ...s, delta: Number((s.value - o.value).toFixed(2)) };
          });
        }
        if (keys?.length) {
          const want = new Set(keys);
          stats = stats.filter((s) => want.has(s.key));
        }
        return ok({ stats });
      }

      case "tree.geometry":
        await this.#busy("building tree geometry", this.#ms(600));
        return ok(await realGeometry());

      case "tree.allocate": {
        await this.#sleep(this.#ms(REAL.recompute));
        const nodes = (params["nodes"] as number[]) ?? [];
        const set = new Set([...this.#summary.allocated, ...nodes]);
        this.#summary = {
          ...this.#summary,
          allocated: [...set],
          pointsUsed: Math.min(set.size, this.#summary.pointsTotal),
        };
        return ok({ summary: this.#summary, stats: this.#baseline });
      }

      case "tree.deallocate": {
        await this.#sleep(this.#ms(REAL.recompute));
        const nodes = new Set((params["nodes"] as number[]) ?? []);
        const kept = this.#summary.allocated.filter((n) => !nodes.has(n));
        this.#summary = { ...this.#summary, allocated: kept, pointsUsed: kept.length };
        return ok({ summary: this.#summary, stats: this.#baseline, orphaned: [] });
      }

      case "build.setClass": {
        await this.#sleep(this.#ms(REAL.recompute));
        const className = String(params["className"] ?? "");
        const ascendClassName = params["ascendClassName"] as string | undefined;
        const onConflict = params["onConflict"] as string | undefined;
        // The engine only asks when a *base class* change would throw the tree
        // away; same-class ascendancy switches never conflict. The mock has no
        // tree topology, so it stands in "connected" with "nothing allocated".
        const changesClass = className !== this.#summary.className;
        const destructive = changesClass && this.#summary.allocated.length > 0;
        if (destructive && (onConflict === undefined || onConflict === "ask")) {
          return ok({
            conflict: {
              kind: "classChange",
              className,
              message:
                `Changing class to ${className} will reset your passive tree.\n` +
                `This can be avoided by connecting one of the ${className} ` +
                `starting nodes to your tree.`,
              options: ["connect", "reset"],
            },
          });
        }
        // "reset" throws the tree away; "connect" keeps it and routes to the
        // new start. Either way the ascendancy's own start node is allocated.
        const allocated =
          destructive && onConflict === "reset" ? [] : this.#summary.allocated;
        this.#summary = {
          ...this.#summary,
          className,
          ascendClassName: ascendClassName ?? this.#summary.ascendClassName,
          allocated,
          pointsUsed: allocated.length,
        };
        return ok({ summary: this.#summary, stats: this.#baseline });
      }

      case "tree.path": {
        await this.#sleep(this.#ms(12));
        const to = Number(params["to"]);
        const path = await realPath(to, this.#summary.allocated);
        if (!path) {
          return fail(-32602, `node ${to} cannot be reached from the current tree`);
        }
        return ok({ path, cost: path.length });
      }

      case "tree.search": {
        await this.#sleep(this.#ms(20));
        const q = String(params["query"] ?? "").toLowerCase();
        const matches = mockGeometry()
          .nodes.filter((n) => n.name.toLowerCase().includes(q))
          .map((n) => n.id);
        return ok({ matches });
      }

      case "tree.power": {
        this.#powerCancelled = false;
        const maxDepth = Number(params["maxDepth"] ?? 3);
        const total = Math.min(2237, 300 * maxDepth);
        ok({ requested: total });
        void this.#streamPower(id, total, String(params["metric"] ?? "offence"));
        return;
      }

      case "tree.powerCancel":
        this.#powerCancelled = true;
        return ok({});

      case "tree.optimise":
        return ok({ requested: Number(params["budget"] ?? 0) });

      default:
        return fail(-32601, `method not found: ${String(method)}`);
    }
  }

  /**
   * Streams ordered by path distance: the first batches (the near nodes that
   * actually matter) land in ~1-3 s, the tail takes the rest of the ~18 s.
   */
  async #streamPower(id: number, total: number, metric: string): Promise<void> {
    const started = Date.now();
    const batchCount = Math.max(1, Math.round(total / 40));
    const perBatch = Math.ceil(total / batchCount);
    const geometry = mockGeometry().nodes;
    let done = 0;

    for (let b = 0; b < batchCount; b++) {
      if (this.#powerCancelled || this.#state.phase !== "ready") return;
      await this.#sleep(this.#ms(REAL.heatmapTotal / batchCount));
      const nodes: NodePower[] = [];
      for (let i = 0; i < perBatch && done < total; i++, done++) {
        const node = geometry[done % geometry.length]!;
        // Value falls off with path distance, which is the whole point of the
        // distance ordering: the good stuff arrives first.
        const falloff = 1 / (1 + done / 60);
        const offence = Math.round(42_000 * falloff * (0.4 + ((done * 37) % 100) / 100));
        const defence = Math.round(9_000 * falloff * (0.4 + ((done * 53) % 100) / 100));
        const pathCost = 1 + Math.floor(done / Math.max(1, total / 6));
        const value = metric === "defence" ? defence : offence;
        nodes.push({
          id: node.id,
          offence,
          defence,
          pathCost,
          perPoint: Number((value / pathCost).toFixed(1)),
        });
      }
      nodes.sort((a, b2) => b2.perPoint - a.perPoint);
      this.#messages.emit({
        jsonrpc: "2.0",
        method: "tree.power.progress",
        params: { id, done, total, nodes },
      });
    }
    if (this.#powerCancelled) return;
    this.#messages.emit({
      jsonrpc: "2.0",
      method: "tree.power.done",
      params: { id, total, elapsedMs: Date.now() - started },
    });
  }

  /** Emits `host.busy` on a ticker for the duration of a blocking operation. */
  async #busy(what: string, ms: number): Promise<void> {
    const started = Date.now();
    const tick = () => {
      this.#messages.emit({
        jsonrpc: "2.0",
        method: "host.busy",
        params: { what, elapsedMs: Date.now() - started },
      });
    };
    tick();
    const interval = setInterval(tick, 250);
    try {
      await this.#sleep(ms);
    } finally {
      clearInterval(interval);
    }
  }

  #setState(s: HostState): void {
    this.#state = s;
    this.#states.emit(s);
  }

  #ms(real: number): number {
    return this.#opts.speed === "instant" ? 0 : real;
  }

  #later(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.#timers.delete(t);
      fn();
    }, ms);
    this.#timers.add(t);
  }

  #sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((res) => this.#later(ms, res));
  }
}
