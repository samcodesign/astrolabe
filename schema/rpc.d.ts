/**
 * The contract between the frontend and the engine host.
 *
 * The host is a long-lived process embedding LuaJIT with Path of Building's
 * calculation engine. Requests and responses are newline-delimited JSON over
 * stdio (JSON-RPC 2.0 framing).
 *
 * Measured costs that shape this API (release build, 2237-node 3.13 tree):
 *   - boot:                    ~4.2 s   → one long-lived process, never per-request
 *   - build.load:              ~5.0 s first time for a tree version, then fast
 *   - full recompute:          ~78 ms   → fine per edit
 *   - one node evaluation:     ~9 ms    → a whole-tree heatmap is ~18 s
 *
 * That last number is why `tree.power` streams and is ordered by path distance
 * rather than returning one array.
 */

// ---------------------------------------------------------------------------
// framing

export interface Request<M extends keyof Methods = keyof Methods> {
  jsonrpc: "2.0";
  id: number;
  method: M;
  params: Methods[M]["params"];
}

export interface Response<M extends keyof Methods = keyof Methods> {
  jsonrpc: "2.0";
  id: number;
  result?: Methods[M]["result"];
  error?: RpcError;
}

/** Unsolicited progress, correlated to a request by `id`. */
export interface Notification<M extends keyof Notifications = keyof Notifications> {
  jsonrpc: "2.0";
  method: M;
  params: Notifications[M];
}

export interface RpcError {
  code: number;
  message: string;
  /** Lua traceback when the engine raised, for diagnosis. */
  data?: string;
}

// ---------------------------------------------------------------------------
// domain types

export type NodeId = number;
export type Affix = "prefix" | "suffix";

export interface Point {
  x: number;
  y: number;
}

/**
 * A passive node, already resolved to cartesian coordinates.
 * PoB stores nodes in polar form (group origin + orbit + orbitIndex); the host
 * resolves that once via CalcOrbitAngles so the frontend never does orbit math.
 */
/** A sub-rect of an atlas sheet, in sheet pixels. */
export interface SpriteRef {
  sheet: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * One option on a mastery node.
 *
 * Masteries are not allocated like other nodes: clicking one opens a chooser
 * and you pick exactly one effect. A mastery counts as allocated only once an
 * effect is selected (PassiveSpec.lua:283).
 */
export interface MasteryEffect {
  id: number;
  stats: string[];
  /**
   * False when this effect is already selected on a *different* mastery node.
   * Each effect can be used only once across the whole tree — PoB filters the
   * chooser on exactly this (TreeTab.lua:1019).
   */
  available: boolean;
}

export interface TreeNode extends Point {
  id: NodeId;
  name: string;
  /**
   * `classStart` and `ascendClassStart` are kept distinct because pathing
   * depends on it: a path may start from either but never pass *through* one
   * (`PassiveSpec.lua:926`). Collapsing them into `ascendancy` loses that.
   */
  type:
    | "normal"
    | "notable"
    | "keystone"
    | "mastery"
    | "socket"
    | "classStart"
    | "ascendClassStart"
    | "ascendancy";
  stats: string[];
  ascendancy?: string;
  /** Hit radius in tree units, derived from the node's art width. */
  radius: number;

  /**
   * Neighbours in the passive graph — PoB's `node.linkedId`.
   *
   * This is NOT derivable from `connectors`. PoB records a link for every pair
   * but refuses to draw one when either end is a Mastery or a ClassStart
   * (`PassiveTree.lua:610-613`), so all 315 masteries have zero connectors
   * while still being reachable. Path-finding must use this; deriving
   * adjacency from the drawn lines leaves every mastery unreachable.
   */
  linked: NodeId[];
  /** True once this node exists only because a cluster jewel created it. */
  synthetic?: boolean;

  /**
   * The node's own artwork, per allocation state. PoB resolves this as
   * `spriteMap[node.icon][spriteType]`, where the sprite type varies by both
   * node kind and whether it is allocated — hence two refs, not one.
   * Nodes DO have icons; a tree drawn without these is not recognisable.
   */
  icon: { active?: SpriteRef; inactive?: SpriteRef };

  /** The ring/frame drawn around the icon, which is what shows state. */
  frame: { allocated?: SpriteRef; path?: SpriteRef; unallocated?: SpriteRef };

  /** Glow drawn over an allocated mastery or a tattooed node. */
  effect?: SpriteRef;

  /** Mastery nodes only: the options the chooser must offer. */
  masteryEffects?: MasteryEffect[];
}

/**
 * A link between two nodes, as a quad with independent UVs per corner.
 * Orbit arcs are curved, so this cannot be expressed as a line — the renderer
 * builds a mesh from `verts` and `uvs` directly.
 */
export interface TreeConnector {
  from: NodeId;
  to: NodeId;
  /** Four corners, tree-space, clockwise from top-left. */
  verts: [Point, Point, Point, Point];
  /**
   * Texture coordinates, normalised 0..1 *within the sprite's sub-rect* —
   * not within the whole sheet. Map them through `sprites[sheet]` to get
   * absolute sheet pixels.
   */
  uvs: [Point, Point, Point, Point];
  /** Key into `sprites`, not a raw sheet filename. */
  sheet: string;
  /**
   * Which allocation state these vertices are for.
   *
   * The three states have *different geometry*, not just different art: PoB's
   * `BuildArc` recomputes the quad per state because the art has different
   * dimensions. So one link yields up to three entries here, and a renderer
   * must pick the matching entry rather than re-tinting one mesh.
   */
  state: "normal" | "intermediate" | "active";
}

export interface TreeGeometry {
  version: string;
  /** Bounding box side length; PoB derives scale from this. */
  size: number;
  nodes: TreeNode[];
  connectors: TreeConnector[];
  groups: Array<{
    x: number;
    y: number;
    /**
     * Sprite key for this group's backdrop.
     *
     * Draw it CENTRED on (x, y) with a half-extent of `sprite.w * 1.33` tree
     * units — so the full drawn size is `w * 2 * 1.33`. That is what PoB's
     * `DrawAsset` does (`PassiveTreeView.lua:1276`), and getting it wrong
     * leaves the backdrop misaligned against nodes whose positions come from
     * orbit maths.
     */
    background: string;
    orbits: number[];
    /** Set on ascendancy groups; the wheel is drawn only on the start group. */
    ascendancy?: string;
    isAscendancyStart?: boolean;
  }>;

  /**
   * The seven base classes, in class-id order (0 Scion .. 6 Shadow).
   *
   * `startNodeId` is not derivable client-side: the `classStart` nodes carry
   * GGG's internal names, two of which ("SIX", "Seven") name no class at all.
   * PoB resolves it at load (PassiveTree.lua:525) and every class switch
   * allocates it (PassiveSpec.lua:578).
   */
  classes: Array<{
    id: number;
    name: string;
    startNodeId: NodeId;
  }>;

  /**
   * Ascendancy metadata, for the wheel backdrop and its flavour text.
   * From `tree.classes[].ascendancies[]` and `tree.alternate_ascendancies`.
   */
  ascendancies: Array<{
    id: string;
    name: string;
    /**
     * The wheel's entrance, allocated by `SelectAscendClass`
     * (PassiveSpec.lua:608-613). Pathing may begin there but never routes
     * through it, so until it is allocated the whole wheel is unreachable.
     */
    startNodeId?: NodeId;
    /**
     * The base class that owns this ascendancy. Needed to tell a same-class
     * switch (always allowed, silent) from a cross-class one, which may reset
     * the tree and must prompt. Absent on alternate/bloodline ascendancies,
     * which belong to no single class.
     *
     * PoB's own class id, which is 0-based and starts at Scion — the key of
     * `tree.classes` after `PassiveTree.lua:95-101` shifts it, and the value
     * `spec.curClassId` holds. 0 Scion, 1 Marauder, 2 Ranger, 3 Witch,
     * 4 Duelist, 5 Templar, 6 Shadow.
     */
    classId?: number;
    className?: string;
    flavourText?: string;
    /** Six hex digits, no leading `#`. */
    flavourTextColour?: string;
    /**
     * Where the text sits inside the wheel art, in the art's own pixel space.
     * PoB converts it to tree space by subtracting the art's half-size:
     * 650 for a normal ascendancy (1300x1300 art), 744/706 for an alternate
     * (1488x1412) — see PassiveTreeView.lua:604-607. Then it draws LEFT-aligned
     * at font size `52 * scale` in FONTIN ITALIC, only at zoom >= 2.5.
     */
    flavourTextRect?: { x: number; y: number };
    /** Alternate ascendancies use the larger art and different offsets. */
    alternate?: boolean;
  }>;
  /** Sprite atlas: key → sheet and sub-rect. */
  sprites: Record<string, SpriteRef>;
  /** Sheet filename → path under the vendored TreeData directory. */
  sheets: Record<string, string>;
  /**
   * Large background illustrations placed at tree coordinates — the class art
   * in the middle of the tree and the ascendancy backdrops. These come from the
   * `extraImages` table in sprites.lua, not from tree.lua, and without them the
   * tree reads as a bare graph rather than the game's tree.
   */
  extraImages: Array<{ x: number; y: number; image: string }>;
}

export interface BuildSummary {
  name: string;
  className: string;
  ascendClassName: string;
  level: number;
  treeVersion: string;
  allocated: NodeId[];
  pointsUsed: number;
  pointsTotal: number;
  ascendancyPointsUsed: number;
  /** Id of the tree spec these numbers describe. */
  activeSpec: SpecId;
  /**
   * Mastery node id → chosen effect id. Serialised by PoB as
   * `masteryEffects="{nodeId,effectId},..."` (PassiveSpec.lua:191-204).
   */
  masterySelections: Record<NodeId, number>;
}

export type SpecId = string;

/** A tree variant. Maps to one `<Spec>` in PoB's saved build. */
export interface SpecSummary {
  id: SpecId;
  title: string;
  treeVersion: string;
  allocated: NodeId[];
  pointsUsed: number;
}

/**
 * A character fetched from the official API.
 *
 * `items` and `passives` are the verbatim responses from `get-items` and
 * `get-passive-skills`; PoB's own importer (ImportTab:ImportPassiveTreeAndJewels
 * and ImportItemsAndSkills) consumes exactly those shapes.
 */
export interface CharacterPayload {
  source: "pathofexile.com";
  account: string;
  character: string;
  realm?: "pc" | "xbox" | "sony";
  items: unknown;
  passives: unknown;
}

/** One row of the stat panel, defined by PoB's own BuildDisplayStats. */
export interface DisplayStat {
  key: string;
  label: string;
  value: number | string | null;
  /** PoB's format spec, e.g. "%.2f" or a percentage flag. */
  format?: string;
  colour?: string;
  /** Present when comparing: value minus the baseline. */
  delta?: number;
}

export interface NodePower {
  id: NodeId;
  /** Stat gain if this node (and its path) were allocated. */
  offence: number;
  defence: number;
  /** Points that must be spent to reach it. */
  pathCost: number;
  /** The headline number: gain per point spent. */
  perPoint: number;
}

// ---------------------------------------------------------------------------
// methods

export interface Methods {
  /** Handshake; returns versions so the frontend can refuse a mismatch. */
  "host.info": {
    params: Record<string, never>;
    result: {
      hostVersion: string;
      pobVersion: string;
      pobCommit: string;
      treeVersions: string[];
      bootMs: number;
    };
  };

  /** Replace the current build. Exactly one source must be set. */
  "build.load": {
    params: {
      /** A PoB share code (base64 + deflate). */
      code?: string;
      /** Raw PoB XML. */
      xml?: string;
      /** A character fetched from the official API. */
      character?: CharacterPayload;
      /** Start from nothing. */
      empty?: boolean;
    };
    result: BuildSummary;
  };

  "build.summary": { params: Record<string, never>; result: BuildSummary };

  /** Serialise the current build back out. */
  "build.save": {
    params: { as: "xml" | "code" };
    result: { data: string };
  };

  "stats.get": {
    params: {
      /** Omit for the full set defined by BuildDisplayStats. */
      keys?: string[];
      /** Also return each stat's delta against this allocation. */
      compareTo?: NodeId[];
    };
    result: { stats: DisplayStat[] };
  };

  /**
   * Full tree geometry for the build's current version.
   * Must be re-fetched after any jewel change: cluster jewels synthesise nodes,
   * orbits and connectors at runtime, so the tree is not static data.
   */
  "tree.geometry": {
    params: { version?: string };
    result: TreeGeometry;
  };

  "tree.allocate": {
    params: { nodes: NodeId[]; /** Follow this exact route rather than the shortest. */ path?: NodeId[] };
    result: { summary: BuildSummary; stats: DisplayStat[] };
  };

  "tree.deallocate": {
    params: { nodes: NodeId[] };
    result: { summary: BuildSummary; stats: DisplayStat[]; /** Nodes orphaned by this. */ orphaned: NodeId[] };
  };

  /**
   * Choose (or clear, with `effect: null`) the effect on a mastery node.
   *
   * A mastery only counts as allocated once an effect is chosen, and an effect
   * may be selected on only one mastery at a time — so the result restates the
   * availability of every mastery effect on the tree, since picking one here
   * can remove it from the chooser elsewhere.
   */
  "tree.setMastery": {
    params: { node: NodeId; effect: number | null };
    result: {
      summary: BuildSummary;
      stats: DisplayStat[];
      /** Node id → its effects with refreshed `available` flags. */
      masteryEffects: Record<NodeId, MasteryEffect[]>;
    };
  };

  /** Shortest route from the allocated tree to a node, via PoB's BFS. */
  "tree.path": {
    params: { to: NodeId };
    result: { path: NodeId[]; cost: number };
  };

  "tree.search": {
    params: {
      /** Quoted phrases match exactly, as in PoB's DoesNodeMatchSearchParams. */
      query: string;
    };
    result: { matches: NodeId[] };
  };

  // -- tree variants --------------------------------------------------------
  // PoB stores several <Spec> elements per build. Without these the frontend
  // has to fake variants by diffing allocations through allocate/deallocate,
  // which costs two round trips per switch and means build.save only ever
  // serialises the active one.

  "spec.list": { params: Record<string, never>; result: { specs: SpecSummary[]; active: SpecId } };

  "spec.create": {
    params: { title?: string; treeVersion?: string; copyFrom?: SpecId };
    result: { spec: SpecSummary };
  };

  "spec.activate": { params: { id: SpecId }; result: { summary: BuildSummary; stats: DisplayStat[] } };
  "spec.rename": { params: { id: SpecId; title: string }; result: { spec: SpecSummary } };
  "spec.delete": { params: { id: SpecId }; result: { specs: SpecSummary[]; active: SpecId } };

  // -- character --------------------------------------------------------------

  "build.setLevel": { params: { level: number }; result: { summary: BuildSummary; stats: DisplayStat[] } };

  /**
   * Change base class and/or ascendancy.
   *
   * Switching to a class your tree does not reach is destructive: PoB either
   * resets the tree or routes a path to the new class start, and it *asks*
   * rather than choosing (`PassiveTreeView.lua:473-491`). So does this: with
   * `onConflict` unset or `"ask"`, a conflicting call changes nothing and
   * returns `conflict` instead. Show the message, then call again with the
   * user's choice.
   *
   * Same-class ascendancy switches never conflict.
   */
  "build.setClass": {
    params: {
      className: string;
      ascendClassName?: string;
      onConflict?: "ask" | "connect" | "reset";
    };
    result:
      | { summary: BuildSummary; stats: DisplayStat[]; conflict?: undefined }
      | {
          conflict: {
            kind: "classChange";
            className: string;
            message: string;
            /** `connect` keeps the tree and paths to the new start. */
            options: Array<"connect" | "reset">;
          };
        };
  };

  /**
   * Value-per-point heatmap. Results stream back as `tree.power.progress`
   * notifications ordered by path distance, because a whole-tree pass is ~18 s
   * while the nodes within a few points are ~1-3 s and are what matters.
   */
  "tree.power": {
    params: {
      /** Which stat to rank by. */
      metric: "offence" | "defence" | string;
      /** Stop past this path cost. Default 3. */
      maxDepth?: number;
    };
    result: { requested: number };
  };

  /**
   * Jewel radius overlays for the tree (`PassiveTreeView.lua:1206-1247`).
   *
   * PoB draws two different things and both need data:
   *   - `sockets[]` — one entry per real jewel socket. When a socketed jewel
   *     has a radius, it carries `inner`/`outer`/`colour`/`label` plus `art`.
   *     Timeless jewels each have their own ring artwork, so `art` names it
   *     ("eternal" for Elegant Hubris, "karui" for Lethal Pride, …) rather
   *     than leaving the client to parse the jewel name.
   *   - `options[]` — every radius a jewel *could* have, in its own colour,
   *     which PoB shows while hovering a socket.
   *
   * A jewel with no radius is reported without those fields. That is the
   * common case and it is correct: cluster jewels create subgraphs instead of
   * a radius, and plain rare jewels have none. `inner` is non-zero only for
   * the "Variable" annuli that Thread of Hope uses.
   */
  "tree.jewels": {
    params: Record<string, never>;
    result: {
      sockets: Array<{
        node: NodeId;
        allocated: boolean;
        title?: string;
        inner?: number;
        outer?: number;
        /** Six hex digits, no leading `#`. */
        colour?: string;
        label?: string;
        art?: string;
        /**
         * The decorative rings to draw for this jewel, in draw order
         * (`PassiveTreeView.lua:1158-1204`).
         *
         * A list because the count and placement genuinely vary: a timeless
         * jewel draws one ring, an ordinary one draws two concentric rings, and
         * Impossible Escape draws two per keystone it unlocks, centred on those
         * keystones rather than on the socket.
         */
        rings?: Array<{
          /**
           * The two sprite keys for one ring. PoB draws the same artwork twice,
           * counter-rotated, so the pair reads as one ornate ring.
           */
          sprites: [string, string];
          /** Half-extent in tree units; the drawn box is twice this. */
          radius: number;
          /** Rotation in radians for each of the pair, in the same order. */
          rotation: [number, number];
          /** Tree-space centre. Absent means the socket's own position. */
          x?: number;
          y?: number;
        }>;
        /**
         * Sprite key for the socket when a jewel is slotted. PoB swaps the
         * socket's overlay by base type rather than drawing the gem
         * separately (`PassiveTreeView.lua:126-155`). Present whenever a
         * jewel is socketed, including ones with no radius.
         */
        socketArt?: string;
        /** The socketed jewel's name, for tooltips. */
        jewel?: string;
        /**
         * The socketed jewel as PoB's own tooltip presents it
         * (`ItemsTab:AddItemTooltip`, `ItemsTab.lua:4368-4660`), which is what
         * PoB shows for a socket instead of the socket's own name
         * (`PassiveTreeView.lua:1478-1484`).
         *
         * Only the fields a jewel fills. For a timeless jewel this carries the
         * seed line — "Commissioned 137300 coins to commemorate Caspiro" — and
         * that line is the only way to tell two otherwise identical jewels
         * apart, since it decides which passives get conquered.
         */
        item?: {
          /** `NORMAL` | `MAGIC` | `RARE` | `UNIQUE`. */
          rarity?: string;
          name: string;
          /** Base type, shown beneath the name. Uniques only. */
          base?: string;
          limit?: string;
          radiusLabel?: string;
          mods: Array<{
            group: "enchant" | "scourge" | "implicit" | "explicit" | "crucible";
            /** Rolled values already applied, not the "(15-20)" range. */
            line: string;
            /**
             * Why PoB colours the line the way it does
             * (`ItemTools.lua:364-376`). A closed set: the engine tests these
             * flags in this order and falls back to `normal`.
             */
            kind:
              | "normal"
              | "disabled"
              | "unsupported"
              | "fractured"
              | "crafted"
              | "mutated"
              | "scourge"
              | "custom"
              | "crucible"
              | "vestigial";
          }>;
          /** A cluster jewel's notables (or keystone) and their stats. */
          clusterNodes?: Array<{ name: string; stats: string[] }>;
          corrupted?: boolean;
        };
      }>;
      options: Array<{ inner: number; outer: number; colour?: string; label?: string }>;
    };
  };

  "tree.powerCancel": { params: { id?: number }; result: Record<string, never> };
  "tree.optimiseCancel": { params: { id?: number }; result: Record<string, never> };

  /**
   * "Best N points I can spend." Beam search over allocation states, scored
   * with the misc calculator. Expensive; streams like tree.power.
   *
   * `beamWidth` is how many candidate branches survive each round, 1..8,
   * default 1 — which is plain greedy.
   *
   * Widening it is currently NOT known to help. Measured on the 3.13 sample
   * build, width 4 over an 8-point budget cost 3.4x the time (19.1s vs 5.7s)
   * for an identical answer: marginal passive values are near-additive, so
   * greedy is already at or near optimal. It should only pay off where value is
   * non-additive — keystones, conversion thresholds, cluster jewels. Treat the
   * default as the supported path and the width as an experiment.
   *
   * `tree.optimise.done` carries the best *complete* branch found. Cancelling
   * mid-search answers with the best branch so far rather than nothing.
   */
  "tree.optimise": {
    params: { budget: number; metric: string; beamWidth?: number };
    result: { requested: number };
  };
}

// ---------------------------------------------------------------------------
// notifications

export interface Notifications {
  "tree.power.progress": {
    id: number;
    done: number;
    total: number;
    /** Highest first. */
    nodes: NodePower[];
  };
  "tree.power.done": { id: number; total: number; elapsedMs: number };

  "tree.optimise.progress": {
    id: number;
    best: { nodes: NodeId[]; gain: number; pointsUsed: number };
    explored: number;
  };
  "tree.optimise.done": { id: number; best: { nodes: NodeId[]; gain: number } };

  /**
   * Long blocking work, e.g. first load of a tree version (~5 s).
   *
   * Always terminated by `host.idle` carrying the same `token`, so the frontend
   * never has to guess with a timeout. Emitted repeatedly while the work runs.
   */
  "host.busy": { token: string; what: string; elapsedMs: number };
  "host.idle": { token: string; elapsedMs: number };
}
