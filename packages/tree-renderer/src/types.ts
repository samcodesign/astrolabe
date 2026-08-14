/**
 * Local mirror of the parts of `schema/rpc.d.ts` this renderer consumes, plus
 * renderer-only types. The schema file is owned by another track and is NOT
 * edited here; if these drift, the schema wins.
 */

export type NodeId = number;

export interface Point {
  x: number;
  y: number;
}

/** A sub-rect of an atlas sheet, in sheet pixels. */
export interface SpriteRef {
  sheet: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Back-compat alias: `sprites` is still `Record<string, SpriteRef>`. */
export type SpriteRect = SpriteRef;

export type TreeNodeType =
  | 'normal'
  | 'notable'
  | 'keystone'
  | 'mastery'
  | 'socket'
  | 'classStart'
  /** Distinct from `ascendancy`: paths may start here but never pass through. */
  | 'ascendClassStart'
  | 'ascendancy';

/**
 * One option on a mastery node. A mastery counts as allocated only once an
 * effect is chosen, and each effect may be used on only one mastery at a time.
 */
export interface MasteryEffect {
  id: number;
  stats: string[];
  available: boolean;
}

export interface TreeNode extends Point {
  id: NodeId;
  name: string;
  type: TreeNodeType;
  stats: string[];
  ascendancy?: string;
  /** Hit radius in tree units, derived from the node's art width. */
  radius: number;
  /**
   * Graph neighbours (PoB's `node.linkedId`). Not derivable from `connectors`:
   * PoB draws no line when either end is a Mastery or ClassStart, so all 315
   * masteries have zero connectors yet are still reachable. Pathing must use
   * this.
   */
  linked: NodeId[];
  /** True once this node exists only because a cluster jewel created it. */
  synthetic?: boolean;

  /**
   * The node's own artwork, per allocation state. PoB ships a separate
   * desaturated sheet for the inactive variant rather than tinting, so these
   * can live on different sheets.
   */
  icon: { active?: SpriteRef; inactive?: SpriteRef };

  /** The ring drawn around the icon; this is what conveys state. */
  frame: { allocated?: SpriteRef; path?: SpriteRef; unallocated?: SpriteRef };

  /** Glow drawn over an allocated mastery or a tattooed node. */
  effect?: SpriteRef;

  /** Mastery nodes only: the options the chooser must offer. */
  masteryEffects?: MasteryEffect[];
}

export type ConnectorState = 'normal' | 'intermediate' | 'active';

export interface TreeConnector {
  from: NodeId;
  to: NodeId;
  verts: [Point, Point, Point, Point];
  uvs: [Point, Point, Point, Point];
  sheet: string;
  state: ConnectorState;
}

export interface TreeGroup {
  x: number;
  y: number;
  background: string;
  orbits: number[];
  /** Set on every group belonging to an ascendancy wheel. */
  ascendancy?: string;
  /**
   * The one group per ascendancy that carries the wheel backdrop and, in PoB,
   * the flavour text (`PassiveTreeView.lua:571`).
   */
  isAscendancyStart?: boolean;
}

/**
 * A base class and where its tree begins.
 *
 * `startNodeId` cannot be derived from the nodes: the `classStart` entries carry
 * GGG's internal names, and two of them ("SIX" for Shadow, "Seven" for Scion)
 * name no class at all.
 */
export interface BaseClass {
  /** PoB's 0-based class id: 0 Scion .. 6 Shadow. */
  id: number;
  name: string;
  startNodeId: NodeId;
}

/**
 * An ascendancy's identity and the flavour text PoB paints on its wheel.
 *
 * `flavourTextRect` is an offset from the *backdrop art's* top-left corner, not
 * from the group — see `flavourTextOffset` in `pob/nodeArt.ts` for the re-basing
 * PoB applies. The text keeps its leading spaces and embedded newlines.
 */
export interface Ascendancy {
  /**
   * PoB's `ascendClass.id`. This — not `name` — is what `TreeNode.ascendancy`
   * carries, and what `PassiveSpec.curAscendClassBaseName` is compared against
   * (`PassiveTreeView.lua:416`). The two differ in the live data: Warden's id
   * is still `Raider`.
   */
  id: string;
  name: string;
  /**
   * The base class that owns this ascendancy, as PoB's 0-based class id.
   * Clicking a foreign ascendancy node is a class change, and whether that
   * change can happen silently depends on whether the ascendancy belongs to
   * the current class (`PassiveTreeView.lua:425-437`) — so the renderer needs
   * the owning class without asking the engine.
   *
   * Absent on alternate/bloodline ascendancies: PoB files those under
   * `alternate_ascendancies`, which belongs to no single class.
   */
  classId?: number;
  className?: string;
  /**
   * The wheel's entrance, allocated by PoB's `SelectAscendClass`
   * (`PassiveSpec.lua:608-613`). Pathing may begin there but never routes
   * through it, so until it is allocated every node in the wheel is
   * unreachable and clicking one does nothing.
   */
  startNodeId?: NodeId;
  /**
   * Optional, as the schema has it: Scion's three ascendancies ship with no
   * flavour text at all, so a required field here is a lie the data disproves.
   */
  flavourText?: string;
  /** Six hex digits, no leading '#'. */
  flavourTextColour?: string;
  flavourTextRect?: Point;
  /** Bloodline ascendancies use larger art and a different re-basing constant. */
  alternate?: boolean;
}

/**
 * A large background illustration placed at tree coordinates: the class art in
 * the middle and the ascendancy backdrops.
 *
 * SCHEMA AMBIGUITY: `image` is a string with no stated namespace. The renderer
 * resolves it against `sprites` first, then `sheets` (a whole file), which
 * covers both readings.
 */
export interface ExtraImage {
  x: number;
  y: number;
  image: string;
}

export interface TreeGeometry {
  version: string;
  size: number;
  nodes: TreeNode[];
  connectors: TreeConnector[];
  groups: TreeGroup[];
  sprites: Record<string, SpriteRef>;
  sheets: Record<string, string>;
  extraImages: ExtraImage[];
  classes?: BaseClass[];
  ascendancies?: Ascendancy[];
}

export interface NodePower {
  id: NodeId;
  offence: number;
  defence: number;
  pathCost: number;
  perPoint: number;
}

/** Mastery node id → chosen effect id, from `BuildSummary.masterySelections`. */
export type MasterySelections = Record<NodeId, number>;

/**
 * The build's class, straight from `BuildSummary`.
 *
 * `ascendClassName` is `PassiveSpec.curAscendClassName`, i.e. the ascendancy's
 * *display* name ("Warden") and the literal string "None" when unascended —
 * not the id that `TreeNode.ascendancy` carries ("Raider"). The renderer
 * resolves one to the other through `geometry.ascendancies`.
 */
export interface BuildClass {
  className: string;
  ascendClassName: string;
}

// ---------------------------------------------------------------------------
// renderer-only

/**
 * Per-connector art for a given allocation state.
 *
 * SCHEMA GAP: `TreeConnector` carries exactly one `state` + one `uvs` set, but
 * the renderer is required to "swap per allocation state". Nodes got this right
 * in the latest revision (`icon.active`/`icon.inactive`, `frame.*`); connectors
 * did not. This side-channel lets the host supply the missing variants without
 * changing `rpc.d.ts`. When absent, the renderer tints the delivered art.
 */
export interface ConnectorVariant {
  sheet?: string;
  uvs: [Point, Point, Point, Point];
}

export type ConnectorVariantTable = Map<number, Partial<Record<ConnectorState, ConnectorVariant>>>;

/** How a node is currently allocated relative to the build. */
export type AllocState = 'unallocated' | 'path' | 'allocated';

/** How a node differs between two allocation sets in compare mode. */
export type CompareState = 'same' | 'added' | 'removed';

/**
 * One jewel radius overlay on a socket.
 *
 * An annulus, not a set of concentric circles. PoB draws a socketed jewel's
 * radius as a disc when `inner` is 0, and as a ring band when it is not —
 * Thread of Hope's "Variable" radii are exactly that, affecting only passives
 * *between* the two bounds (`PassiveTreeView.lua:1216-1233`). A plain list of
 * radii cannot express the difference.
 */
/** Why a mod line is coloured the way it is (`ItemTools.lua:364-376`). */
export type ModKind =
  | 'normal'
  | 'disabled'
  | 'unsupported'
  | 'fractured'
  | 'crafted'
  | 'mutated'
  | 'scourge'
  | 'custom'
  | 'crucible'
  | 'vestigial';

export interface JewelMod {
  /** Which block it belongs to; PoB separates the groups with a rule. */
  group: 'enchant' | 'scourge' | 'implicit' | 'explicit' | 'crucible';
  /** Already has the item's rolled values applied, not the "(15-20)" range. */
  line: string;
  kind: ModKind;
}

/**
 * The socketed jewel, as PoB's own tooltip presents it
 * (`ItemsTab:AddItemTooltip`, `ItemsTab.lua:4368-4660`).
 *
 * Only the fields a jewel fills — the rest of that function covers armour,
 * weapons and requirements, which a jewel never has.
 */
export interface JewelItem {
  /** `NORMAL` | `MAGIC` | `RARE` | `UNIQUE`, driving the name's colour. */
  rarity?: string;
  name: string;
  /** The base type, shown under the name. Uniques only; others fold it in. */
  base?: string;
  limit?: string;
  radiusLabel?: string;
  mods: JewelMod[];
  /**
   * A cluster jewel's notables (or its keystone) with their stats. These nodes
   * do not exist until the jewel is socketed, so the name alone cannot be
   * resolved on this side.
   */
  clusterNodes?: Array<{ name: string; stats: string[] }>;
  corrupted?: boolean;
}

/**
 * One decorative ring: the same artwork drawn twice, counter-rotated, so the
 * pair reads as a single ornate ring.
 */
export interface JewelRing {
  sprites: [string, string];
  /** Half-extent in tree units; the drawn box is twice this. */
  radius: number;
  /** Rotation in radians for each of the pair, in the same order. */
  rotation: [number, number];
  /** Tree-space centre. Absent means the socket's own position. */
  x?: number;
  y?: number;
}

export interface JewelRadius {
  nodeId: NodeId;
  /**
   * Outer bound, tree units. Absent when the socketed jewel has no radius —
   * a cluster jewel makes a subgraph instead, and a plain rare has none — but
   * the socket still gets its own art, so the entry is not dropped.
   */
  outer?: number;
  /** Inner bound; 0 for an ordinary disc-shaped radius. */
  inner?: number;
  /** CSS-ish hex, e.g. 0x7fd4ff. */
  colour?: number;
  label?: string;
  /**
   * The decorative rings to draw, from `tree.jewels`
   * (`PassiveTreeView.lua:1158-1204`).
   *
   * Fully resolved by the engine, so this is one loop with no jewel names in
   * it. The count and placement vary by jewel: a timeless jewel draws one
   * ornate ring at the socket, an ordinary one draws two concentric rings, and
   * Impossible Escape draws two per keystone it unlocks — centred on those
   * keystones, which is why a ring carries its own optional position.
   *
   * Absent or empty for a jewel with no art, which falls back to the plain
   * shader circle.
   */
  rings?: JewelRing[];
  /**
   * The socketed jewel itself, for the socket's tooltip. PoB shows the whole
   * item there (`PassiveTreeView.lua:1478-1484`), which is the only way to tell
   * which jewel is in which socket — and for a timeless jewel, the only way to
   * read the seed that decides what it conquers.
   */
  item?: JewelItem;
  /**
   * Sprite key for the socket itself when a jewel is in it.
   *
   * PoB does not draw the gem as a separate image — it swaps the socket's
   * overlay by the jewel's base type (`PassiveTreeView.lua:126-155`), so a
   * Cobalt reads blue, a Timeless reads Legion, a cluster reads purple.
   */
  socketArt?: string;
}

export interface HoverInfo {
  node: TreeNode;
  /** Screen-space (CSS px, relative to the canvas) centre of the node. */
  screen: Point;
  power?: NodePower;
  alloc: AllocState;
}

export interface ClickInfo {
  node: TreeNode;
  button: number;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
}

/**
 * Fired instead of `click` when a mastery is clicked. The renderer does not own
 * the chooser popup — it hands over the node, its options and the current
 * selection, and the app puts a UI in front of it.
 */
export interface MasteryClickInfo {
  node: TreeNode;
  effects: MasteryEffect[];
  /** Currently chosen effect id, or null when nothing is selected yet. */
  selected: number | null;
  /** Screen-space centre of the node, for anchoring the popup. */
  screen: Point;
}

/**
 * Fired instead of `click` when an unallocated node of some *other* ascendancy
 * is clicked. PoB treats that as a class/ascendancy switch rather than an
 * allocation (`PassiveTreeView.lua:395-500`), and the switch may reset the
 * tree — a decision the renderer has no standing to make. It hands over the
 * target and the app drives `build.setClass`, then allocates `node`.
 */
export interface AscendancySelection {
  node: TreeNode;
  /** `TreeNode.ascendancy` — PoB's `ascendClass.id`, e.g. `Raider`. */
  ascendancy: string;
  /** The display name, e.g. `Warden`. */
  ascendancyName: string;
  /** Owning base class, from `geometry.ascendancies`. */
  classId: number;
  className: string;
  /**
   * True when the target belongs to the build's current class. PoB switches
   * those silently and never prompts (`PassiveTreeView.lua:425-432`); only a
   * cross-class switch can reset the tree.
   */
  sameClass: boolean;
  /** Screen-space centre of the node, for anchoring a prompt. */
  screen: Point;
}

export interface TreeViewEvents {
  hover: HoverInfo | null;
  click: ClickInfo;
  mastery: MasteryClickInfo;
  ascendancySelect: AscendancySelection;
  /** Fires after the view transform settles or changes. */
  viewport: { zoom: number; level: number; x: number; y: number; scale: number };
  frame: { fps: number; drawnNodes: number; drawnConnectors: number; ms: number };
}
