/**
 * Adapter from the app's `TreeRenderer` interface onto the real `TreeView`.
 *
 * The two were written against the same schema but different vocabularies, and
 * nothing forced them to agree: the app says `nodeClick(id, modifiers)` where
 * the renderer emits `click({ node, button, shift, … })`, `nodeHover` against
 * `hover`, `viewportChange` against `viewport`. While the app resolved to a
 * stub those names were never compared, so all four drifted unnoticed and
 * `renderer.on(...)` for a name nothing emits fails silently. `TreeView.on` now
 * throws on an unknown name, and this file is the one place the translation
 * happens.
 *
 * The other real difference is lifecycle. `TreeView.create` and `load` are
 * async; `mount`/`setGeometry` are not. State pushed before the view exists is
 * held here and applied on arrival, so callers never have to know.
 */

import type { NodeId, TreeGeometry } from "@schema/rpc";
import { isTauri } from "../rpc/tauri-transport";
import {
  TreeView,
  installUnsafeEvalPolyfill,
  type JewelRadius,
  type MasteryEffect,
  type NodePower as RendererNodePower,
  type TreeGeometry as RendererGeometry,
} from "@poe-planner/tree-renderer-pkg";

/**
 * Clicking an unallocated node that belongs to an ascendancy the build has not
 * selected is a class/ascendancy switch, not an allocation — PoB runs the
 * switch and only then allocates the node (`PassiveTreeView.lua:395-500`).
 * The renderer refuses to guess, because a cross-class switch can reset the
 * tree; it reports the target and the app drives `build.setClass`.
 */
export interface AscendancySelection {
  /** The clicked node, to allocate once the class change lands. */
  node: NodeId;
  /** PoB's `ascendClass.id`, which is what `TreeNode.ascendancy` carries. */
  ascendancy: string;
  /** The display name; it differs from the id for Warden (id `Raider`). */
  ascendancyName: string;
  /** The base class that owns the ascendancy, as PoB's 0-based class id. */
  classId: number;
  className: string;
  /** True when it belongs to the build's current class, which never prompts. */
  sameClass: boolean;
}

/** The build's class, as `BuildSummary` reports it. */
export interface RendererClass {
  className: string;
  /** Display name, or the literal "None" when unascended. */
  ascendClassName: string;
}

/**
 * Clicking a mastery does not allocate it — PoB opens a chooser and the point
 * is not spent until an effect is picked (`TreeTab.lua:1011`). The renderer
 * shows the chooser; the app commits the pick through `tree.setMastery`.
 */
export interface MasterySelection {
  node: NodeId;
  effect: number | null;
}

export interface TreeRendererEvents {
  nodeClick: (id: NodeId, modifiers: { shift: boolean; ctrl: boolean }) => void;
  masterySelect: (selection: MasterySelection) => void;
  nodeHover: (id: NodeId | null) => void;
  viewportChange: (v: { x: number; y: number; zoom: number }) => void;
  ascendancySelect: (selection: AscendancySelection) => void;
}

export interface TreeRenderer {
  /** Attach to a container. Idempotent. */
  mount(container: HTMLElement): void;
  setGeometry(geometry: TreeGeometry): void;
  setAllocated(nodes: readonly NodeId[]): void;
  /**
   * Which class and ascendancy the build is on. Without it the renderer cannot
   * tell one of your own ascendancy's nodes from a foreign one, and every
   * ascendancy click would read as a class switch.
   */
  setClass(cls: RendererClass | null): void;
  /** Search results: rings the matches, dims the rest. */
  setHighlight(nodes: readonly NodeId[]): void;
  /**
   * The route a click would take, shown while hovering an unallocated node.
   *
   * Distinct from {@link setHighlight}: PoB draws a previewed path with the
   * node's *path* frame art and the intermediate connectors lit, which is not
   * the same treatment as a search hit (PassiveTreeView.lua:877).
   */
  setPathPreview(nodes: readonly NodeId[] | null): void;
  /** Heatmap: node id → normalised 0..1 value. */
  setPower(power: ReadonlyMap<NodeId, number>): void;
  /** Jewel radius overlays, from `tree.jewels`. */
  setJewelRadii(list: readonly JewelRadius[]): void;
  /** Mastery id → chosen effect, from `BuildSummary.masterySelections`. */
  setMasterySelections(selections: Record<NodeId, number>): void;
  /** Refreshed `available` flags, from `tree.setMastery`'s result. */
  setMasteryEffects(table: Record<NodeId, MasteryEffect[]>): void;
  on<E extends keyof TreeRendererEvents>(
    event: E,
    handler: TreeRendererEvents[E],
  ): () => void;
  resize(): void;
  destroy(): void;
}

export interface CreateTreeRendererOptions {
  /** Path prefix for sprite sheets referenced by `TreeGeometry.sheets`. */
  assetBase?: string;
  devicePixelRatio?: number;
}

/** The app used to resolve to a placeholder. It no longer does. */
export const IS_STUB = false;

/**
 * Where the sheet paths in `TreeGeometry.sheets` are resolved against.
 *
 * Under the dev server a Vite middleware mounts Path of Building's `src` at
 * `/treedata`. The packaged app has no dev server, so the shell registers a
 * `treedata` URI scheme over the same directory — which Tauri exposes as
 * `http://treedata.localhost` on Windows and `treedata://localhost` elsewhere.
 *
 * The root is PoB's `src`, so paths arrive already qualified: `TreeData/3_29/
 * skills-3.jpg` for tree art, `Assets/ShadedOuterRing.png` for the jewel rings.
 * The name is now a little narrower than what it serves.
 */
function defaultAssetBase(): string {
  if (!isTauri()) return "/treedata";
  const windows =
    typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
  return windows ? "http://treedata.localhost" : "treedata://localhost";
}

export function createTreeRenderer(
  opts: CreateTreeRendererOptions = {},
): TreeRenderer {
  let view: TreeView | null = null;
  let destroyed = false;

  /**
   * The last value pushed on each channel — not a queue, and deliberately never
   * cleared.
   *
   * `TreeView.load` builds a new model, so every piece of build state set
   * before it is gone afterwards, and `TreeView` silently ignores a call made
   * while no model exists. Treating this as "state to replay after any load"
   * rather than "calls to flush once" is what makes the ordering irrelevant:
   * an import changes the tree version, which reloads geometry, and the
   * allocation arrives on a different tick to the geometry it belongs to.
   * Clearing these after the first flush left the tree drawn as if nothing
   * were allocated.
   */
  const pending: {
    geometry: TreeGeometry | null;
    allocated: readonly NodeId[] | null;
    cls: RendererClass | null;
    highlight: readonly NodeId[] | null;
    pathPreview: readonly NodeId[] | null;
    jewels: readonly JewelRadius[] | null;
    masterySelections: Record<NodeId, number> | null;
    power: ReadonlyMap<NodeId, number> | null;
  } = {
    geometry: null,
    allocated: null,
    cls: null,
    highlight: null,
    pathPreview: null,
    jewels: null,
    masterySelections: null,
    power: null,
  };

  const listeners: { [E in keyof TreeRendererEvents]: Set<TreeRendererEvents[E]> } = {
    nodeClick: new Set(),
    masterySelect: new Set(),
    nodeHover: new Set(),
    viewportChange: new Set(),
    ascendancySelect: new Set(),
  };

  const applyGeometry = async (v: TreeView, geometry: TreeGeometry) => {
    // The schema type and the renderer's own mirror describe the same payload;
    // the renderer's is the stricter of the two, so the cast is one-way only.
    await v.load(geometry as unknown as RendererGeometry, {
      baseUrl: opts.assetBase ?? defaultAssetBase(),
      // A sheet that fails to load is not fatal — the tree still draws — so
      // nothing else surfaces it. That silence is what let a whole class of
      // art go missing unnoticed: timeless-jewel node icons rendered as bare
      // frames for as long as they did because no sheet, and no error, ever
      // reached anyone. It costs one line to make the next one say so.
      onSheetError: (sheet, err) => {
        console.error(`tree art: sheet "${sheet}" failed to load`, err);
      },
    });
  };

  /** Push whatever arrived before the view existed, in dependency order. */
  const flush = async (v: TreeView) => {
    if (pending.geometry) {
      const g = pending.geometry;
      pending.geometry = null;
      await applyGeometry(v, g);
    }
    if (destroyed) return;
    if (pending.cls !== null) v.setClass(pending.cls);
    if (pending.allocated) v.setAllocated(pending.allocated);
    if (pending.highlight) v.setSearch(pending.highlight);
    if (pending.pathPreview) v.setPathPreview(pending.pathPreview);
    if (pending.jewels) v.setJewelRadii([...pending.jewels]);
    if (pending.masterySelections) v.setMasterySelections(pending.masterySelections);
    if (pending.power) applyPower(v, pending.power);
  };

  /**
   * The app hands over a normalised 0..1 map; the renderer wants the streaming
   * `NodePower` shape it also uses live. Only `perPoint` drives the colour, so
   * the rest is filled with zeroes rather than invented.
   */
  const applyPower = (v: TreeView, power: ReadonlyMap<NodeId, number>) => {
    if (power.size === 0) {
      v.clearPower();
      v.setPowerVisible(false);
      return;
    }
    const nodes: RendererNodePower[] = [];
    for (const [id, perPoint] of power) {
      nodes.push({ id, offence: 0, defence: 0, pathCost: 1, perPoint });
    }
    v.clearPower();
    v.expectPower(nodes.length);
    v.addPower(nodes, { done: nodes.length, total: nodes.length });
    v.finishPower();
    v.setPowerVisible(true, "perPoint");
  };

  const bind = (v: TreeView) => {
    v.on("click", ({ node, shift, ctrl }) => {
      for (const fn of listeners.nodeClick) fn(node.id, { shift, ctrl });
    });
    v.on("hover", (info) => {
      for (const fn of listeners.nodeHover) fn(info?.node.id ?? null);
    });
    v.on("viewport", ({ x, y, zoom }) => {
      for (const fn of listeners.viewportChange) fn({ x, y, zoom });
    });
    // The renderer's chooser reports the pick; committing it is the app's job,
    // because only the engine knows whether the effect is still free.
    v.on("mastery", (info) => {
      for (const fn of listeners.masterySelect) {
        fn({ node: info.node.id, effect: info.selected ?? null });
      }
    });
    v.on("ascendancySelect", (sel) => {
      // The renderer passes the whole node; the app only needs its id.
      const out: AscendancySelection = {
        node: sel.node.id,
        ascendancy: sel.ascendancy,
        ascendancyName: sel.ascendancyName,
        classId: sel.classId,
        className: sel.className,
        sameClass: sel.sameClass,
      };
      for (const fn of listeners.ascendancySelect) fn(out);
    });
  };

  return {
    mount(container) {
      if (view || destroyed) return;
      // The shell's CSP is `script-src 'self'`, which blocks the `new Function`
      // calls Pixi's default shader path uses. This must land before the first
      // renderer is constructed or Pixi refuses to start.
      void installUnsafeEvalPolyfill()
        .then(() => TreeView.create({ container }))
        .then(async (v) => {
          // `destroy()` can land while create is in flight.
          if (destroyed) {
            v.destroy();
            return;
          }
          view = v;
          // A blank canvas has several possible causes — geometry never
          // arrived, textures 404'd, the view never started — and none of them
          // log anything. Expose the view in dev so it can be interrogated.
          if (import.meta.env.DEV) {
            (globalThis as Record<string, unknown>)["__treeView"] = v;
          }
          bind(v);
          await flush(v);
        })
        .catch((err) => {
          console.error("tree renderer failed to start", err);
        });
    },

    setGeometry(geometry) {
      if (!view) {
        pending.geometry = geometry;
        return;
      }
      void applyGeometry(view, geometry).then(() => {
        // `load` rebuilds every layer and replaces the model, so *everything*
        // pushed beforehand has to be re-applied. `TreeView` silently drops a
        // call made before the model exists (`if (!this.model) return`), and an
        // import sets the class, allocation and jewels while the geometry
        // request for that same build is still in flight — so anything missing
        // from this list is a channel that works everywhere except right after
        // an import, which is the one case that matters.
        if (!view) return;
        if (pending.cls !== null) view.setClass(pending.cls);
        if (pending.allocated) view.setAllocated(pending.allocated);
        if (pending.masterySelections) view.setMasterySelections(pending.masterySelections);
        if (pending.jewels) view.setJewelRadii([...pending.jewels]);
        if (pending.highlight) view.setSearch(pending.highlight.length ? pending.highlight : null);
        if (pending.power) applyPower(view, pending.power);
      });
    },

    setAllocated(nodes) {
      pending.allocated = nodes;
      view?.setAllocated(nodes);
    },

    setClass(cls) {
      pending.cls = cls;
      view?.setClass(cls);
    },

    setHighlight(nodes) {
      pending.highlight = nodes;
      view?.setSearch(nodes.length ? nodes : null);
    },

    setPathPreview(nodes) {
      pending.pathPreview = nodes;
      view?.setPathPreview(nodes && nodes.length ? nodes : null);
    },

    setPower(power) {
      pending.power = power;
      if (view) applyPower(view, power);
    },

    setJewelRadii(list) {
      pending.jewels = list;
      view?.setJewelRadii([...list]);
    },

    setMasterySelections(selections) {
      pending.masterySelections = selections;
      view?.setMasterySelections(selections);
    },

    setMasteryEffects(table) {
      view?.setMasteryEffects(table);
    },

    on(event, handler) {
      listeners[event].add(handler as never);
      return () => listeners[event].delete(handler as never);
    },

    resize() {
      view?.resize();
    },

    destroy() {
      destroyed = true;
      view?.destroy();
      view = null;
      for (const set of Object.values(listeners)) set.clear();
    },
  };
}
