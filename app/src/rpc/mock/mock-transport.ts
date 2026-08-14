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
  Methods,
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
  MOCK_TREE_VERSION,
  mockGeometry,
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
