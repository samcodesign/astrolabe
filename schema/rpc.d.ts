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

/**
 * One line of a "what would this change do?" comparison.
 *
 * A delta rather than a value, so it carries no baseline of its own — pair it
 * with the stat panel if you need the absolute. `better` is the engine's call,
 * not the sign: some stats improve by going down (`lowerIsBetter`), and only
 * PoB's own stat definitions know which.
 */
export interface StatDelta {
  key: string;
  label: string;
  delta: number | string | null;
  /** PoB's format spec, e.g. "%.2f". */
  format?: string;
  better: boolean;
  /** Relative change, for the stats where a ratio is meaningful. */
  percent?: number | string | null;
}

/** A 1-based entry in one of the main-skill dropdowns. */
export interface SkillOption {
  index: number;
  label: string;
}

/**
 * The state of PoB's main-skill selector (`Modules/Build.lua:1549-1647`).
 *
 * Optional fields are absent when the control does not apply to the selected
 * skill, which is how PoB itself decides what to draw — it does not show an
 * empty part selector for a single-part skill, it shows none.
 */
export interface MainSkillSelection {
  groups: SkillOption[];
  /** 1-based index into `groups`. */
  groupIndex: number;
  /** No socket groups at all — a build that has no gems yet. Nothing else is set. */
  empty: boolean;

  /** The active skills within the selected group. */
  skill?: {
    options: SkillOption[];
    index: number;
    /** False when there is only one, matching PoB's disabled dropdown. */
    enabled: boolean;
  };

  /** Only for skills with more than one part. */
  part?: { options: SkillOption[]; index: number };

  /** Only for skills with stages. */
  stageCount?: number;
  /** Only for mines. May be absent-but-applicable: unset means "as configured". */
  mineCount?: number | null;

  /** Only for minion skills. */
  minion?: {
    /** `itemSet` for skills like Animate Guardian, where the "minion" is a set of items. */
    kind: "minion" | "itemSet";
    options: Array<{ id: string | number; label: string }>;
    id?: string | number | null;
    enabled: boolean;
    /** Set when the list is empty for a reason worth showing, e.g. no spectres. */
    note?: string;
  };

  /** The minion's own skills, when one is selected. */
  minionSkill?: { options: SkillOption[]; index: number; enabled: boolean };
}

/**
 * One gem in a socket group.
 *
 * `nameSpec` is what the build stored; `name` and everything below it only
 * appear once the engine resolved the gem (`SkillsTab.lua:1134-1207`). An
 * unresolved gem keeps its `nameSpec` and carries `error` rather than
 * disappearing.
 */
export interface GemInstance {
  index: number;
  nameSpec: string;
  gemId?: string;
  level: number;
  quality: number;
  enabled: boolean;
  /** PoB's two "apply outside this group" flags. */
  enableGlobal1: boolean;
  enableGlobal2: boolean;
  count: number;
  support: boolean;

  name?: string;
  maxLevel?: number;
  tags?: string;
  /** Socket colour the gem wants: R/G/B for str/dex/int. */
  colour?: "R" | "G" | "B";
  reqLevel?: number;
  reqStr?: number;
  reqDex?: number;
  reqInt?: number;
  /** Whether its socket is the right colour, when the group is slotted. */
  matchesSocket?: boolean;
  error?: string;

  /**
   * Vaal gems grant two effects, each independently toggleable via
   * `enableGlobal1`/`enableGlobal2` (`SkillsTab.lua:1021-1030`). Present only
   * when there is something to toggle; `name` is the checkbox label.
   */
  globalEffects?: Array<{ index: 1 | 2; name: string }>;

  /**
   * Whether `count` applies. It scales the skill's DPS by a scalar — totems,
   * mines, shotgunning projectiles — and means nothing on a plain support, so
   * PoB hides it there (`SkillsTab.lua:983-994`).
   */
  showCount?: boolean;
}

export interface SocketGroup {
  index: number;
  /** The user's own name for the group; often empty. */
  label: string;
  /** What PoB displays: `label`, or the group's active skills joined. */
  displayLabel: string;
  /** Item slot this group is socketed in, if any. */
  slot?: string;
  enabled: boolean;
  /**
   * False when the group sits in the weapon set that is not currently active,
   * which makes it inert however `enabled` looks (`CalcSetup.lua:1504`).
   */
  slotEnabled: boolean;
  includeInFullDPS: boolean;
  count: number;
  mainActiveSkill: number;
  /** Granted by an item rather than the user; not editable. */
  fromItem: boolean;
  /**
   * A support imbued into this group's item slot, by name.
   *
   * Applies to everything in the slot as if socketed, without taking a socket.
   * Only present when one is set, and only meaningful for a group with a slot.
   */
  imbuedSupport?: string;
  gems: GemInstance[];
}

/**
 * A gem that can be socketed.
 *
 * Note the names: `data.gems` stores most supports *without* the " Support"
 * suffix the game shows — "Added Lightning Damage", not "Added Lightning Damage
 * Support". Only ones colliding with an active skill keep it. Use `support`,
 * not the name, to tell them apart.
 */
export interface GemCatalogueEntry {
  id: string;
  name: string;
  support: boolean;
  /** Awakened, or tagged Exceptional. PoB can filter the list on this. */
  exceptional: boolean;
  legacy: boolean;
  colour?: "R" | "G" | "B";
  tags: string;
  maxLevel?: number;
}

/**
 * What every skills mutation returns.
 *
 * The refreshed `skills` and `mainSkill` ship with the new stats because a gem
 * change can alter both — adding an active skill changes what the main-skill
 * selector offers, and deleting a group can move its index.
 */
/**
 * One line of an item's text.
 *
 * PoB keeps six separate lists rather than one — buff, enchant, scourge,
 * implicit, explicit, crucible — and the split is meaningful: they render
 * differently and they serialise in that order (`ItemsTab.lua:1344-1372`).
 */
export interface ItemMod {
  /** 1-based within its own list. */
  index: number;
  /** May contain newlines; cluster jewel enchantments are multi-line. */
  line: string;
  crafted?: boolean;
  fractured?: boolean;
  scourge?: boolean;
  /** Leftover text the engine recognised but could not turn into modifiers. */
  unparsed?: string;
  /**
   * Where the roll sits in its range, 0..1. Present only for lines that
   * actually carry a `(min-max)` — the engine applies PoB's own test, so a
   * line without this has no slider to move.
   */
  range?: number;
  rangeMin?: number;
  rangeMax?: number;
}

/** A socket, and which link group it belongs to. Same group = linked. */
export interface ItemSocket {
  index: number;
  /** "R" | "G" | "B" — strength, dexterity, intelligence. */
  colour?: string;
  group: number;
}

/**
 * A unique's variant choices.
 *
 * `options` is the shared list of names; `axes` is which *independent*
 * selections the item offers. Up to six (`variant`, `variantAlt`…`variantAlt5`)
 * — Watcher's Eye uses several at once, so one selector is not enough.
 */
export interface ItemVariants {
  options: Array<{ index: number; name: string }>;
  axes: Array<{ key: string; selected: number }>;
}

export interface Item {
  id: number;
  /** PoB's combined display name. Prefer `title` + `baseName` when rendering. */
  name: string;
  rarity: "NORMAL" | "MAGIC" | "RARE" | "UNIQUE" | "RELIC";
  baseName: string;
  /** Set for rares and uniques, where the name and the base are separate lines. */
  title?: string;
  namePrefix?: string;
  nameSuffix?: string;
  type?: string;
  subType?: string;
  itemLevel?: number;
  quality?: number;
  league?: string;
  talismanTier?: number;
  catalyst?: number;
  catalystQuality?: number;
  corrupted: boolean;
  mirrored: boolean;
  requires?: { level?: number; str?: number; dex?: number; int?: number };
  /** Base defences, which live on the item rather than in its mod list. */
  defences?: {
    armour?: number;
    evasion?: number;
    energyShield?: number;
    ward?: number;
  };
  influences?: string[];
  sockets?: ItemSocket[];
  mods?: {
    buff?: ItemMod[];
    enchant?: ItemMod[];
    scourge?: ItemMod[];
    implicit?: ItemMod[];
    explicit?: ItemMod[];
    crucible?: ItemMod[];
  };
  variants?: ItemVariants;
  /** The text PoB would write out; what `items.paste` round-trips. */
  raw?: string;
}

/**
 * A place an item can go.
 *
 * Jewel sockets are slots too, but they only exist while their tree node is
 * allocated, so this list is per-build and changes as the tree does.
 */
export interface ItemSlot {
  name: string;
  label: string;
  /** Present for jewel sockets, which store into the tree spec, not the set. */
  nodeId?: NodeId;
  weaponSet?: number;
  /** The equipped item, if any. */
  itemId?: number;
  /** Abyssal and jewel sockets come and go with their parent. */
  shown: boolean;
}

export interface ItemsState {
  slots: ItemSlot[];
  /**
   * Every item the build knows about, equipped or not. An item is a value and
   * a slot is a reference — equipping repoints a slot rather than moving
   * anything, so two sets can share one item.
   */
  items: Item[];
  sets: Array<{ id: number; title: string; useSecondWeaponSet: boolean }>;
  activeSet: number;
  useSecondWeaponSet: boolean;
}

/** One candidate in a crafting pool, or one row of the mod browser. */
export interface ModCandidate {
  /** 1-based within the pool as returned. Pass it back to `items.addMod`. */
  index: number;
  /** The mod's text, one entry per line. Ranges are unresolved: `(11-28)%`. */
  lines: string[];
  /** How to show it — the affix name, the essence, or just the lines. */
  label: string;
  /**
   * Whether the calculator can actually use this mod.
   *
   * A mod that reads fine and does nothing is the failure a user cannot see, so
   * it is stated rather than left to be discovered.
   */
  supported: boolean;
  /** "crafted" lands as a crafted line; "custom" as a plain explicit one. */
  kind: "crafted" | "custom";
  affixType?: string;
  level?: number;
  source?: string;
}

export interface ItemsResult {
  summary: BuildSummary;
  stats: DisplayStat[];
  items: ItemsState;
}

export interface SkillsResult {
  summary: BuildSummary;
  stats: DisplayStat[];
  skills: SkillsState;
  mainSkill: MainSkillSelection;
}

/**
 * One line of custom mod text, with the engine's verdict.
 *
 * PoB reports none of this — `BuildModList` drops bad lines silently
 * (`ConfigTab.lua:1106-1129`) and the only feedback is the colour of the text.
 * The reasons are distinguishable and worth distinguishing: a typo and a mod
 * the engine knows but has not implemented need different words.
 */
export interface CustomModLine {
  /** 1-based, counting blank lines, so it matches what the user sees. */
  line: number;
  text: string;
  ok: boolean;
  reason?: "unrecognised" | "partial" | "unsupported" | "unparsed";
  /** For `partial`: the text the parser could not account for. */
  leftover?: string;
}

/** A named, individually-enableable group of custom mod text. */
export interface CustomModBlock {
  index: number;
  title: string;
  enabled: boolean;
  text: string;
  /** Blank lines are omitted — they are not errors. */
  lines: CustomModLine[];
}

/** What a config mutation returns. */
export interface ConfigResult {
  summary: BuildSummary;
  stats: DisplayStat[];
  config: ConfigState;
}

/** What a custom-mod mutation returns; carries the refreshed blocks. */
export interface CustomModResult extends ConfigResult {
  customMods: { blocks: CustomModBlock[] };
}

export interface SkillsState {
  groups: SocketGroup[];
  /** Item slots a group can be assigned to (`SkillsTab.lua:13-27`). */
  slots: string[];
  sets: Array<{ id: number; title: string }>;
  activeSet: number;
  /** Which group the stat panel reports; mirrors `MainSkillSelection.groupIndex`. */
  mainGroup: number;
}

/**
 * A configuration option, as declared in `Modules/ConfigOptions.lua`.
 *
 * The types map onto PoB's controls (`ConfigTab.lua:265-311`): `check` is a
 * checkbox, `list` a dropdown, `text` a free string, and the four numeric kinds
 * differ only in what they accept — `count` is non-negative, `integer` and
 * `countAllowZero` allow zero and negatives, `float` allows decimals.
 */
export interface ConfigOption {
  var: string;
  type: "check" | "count" | "integer" | "countAllowZero" | "float" | "list" | "text";
  label: string;
  tooltip?: string;
  /** Present for `list`. `value` is what `config.set` takes back. */
  list?: Array<{ value: string | number | boolean; label: string }>;
  default?: string | number | boolean;
  min?: number;
  step?: "any";
  /**
   * What the calculator uses when the option is left unset
   * (`ConfigTab.lua:1090-1092`). A hint, never a value — render it as such.
   * Fourteen options declare one: melee distance 15, projectile distance 40,
   * withered stacks 15, and so on.
   */
  placeholder?: number | string;
}

export interface ConfigSection {
  name: string;
  options: ConfigOption[];
}

/**
 * Current option values and — crucially — which options apply to this build.
 *
 * `shown` is decided by the engine, not the client. PoB's predicates (`ifCond`,
 * `ifSkillData`, `ifNode`, `ifOption`, …) are answered from live calculator
 * state, so evaluating them anywhere else means reimplementing the calculator
 * and getting it quietly wrong. A var absent from `shown` does not apply right
 * now; render the schema filtered through this.
 */
export interface ConfigState {
  values: Record<string, string | number | boolean>;
  /**
   * Live per-set placeholders. Usually the declared one, but PoB recomputes
   * some at runtime — enemy level follows the character's
   * (`ConfigTab.lua:1062-1072`) — so prefer this over `ConfigOption.placeholder`.
   */
  placeholders: Record<string, number | string>;
  shown: Record<string, true>;
  /**
   * The subset of `shown` that is only visible because the user set it and the
   * option no longer applies to this build. PoB reddens the label and says
   * "conditional with missing source and is invalid" (`ConfigTab.lua:718-719`).
   * This is how you find a stale toggle still moving your numbers.
   */
  invalid: Record<string, true>;
  /** Set to something other than the default — PoB draws a blue border. */
  modified: Record<string, true>;
  sets: Array<{ id: number; title: string }>;
  activeSet: number;
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
   * What a change would do, without doing it.
   *
   * The build is edited, calculated and edited back inside one call — PoB's
   * calculator has no override channel for gems or config, so there is no way
   * to ask it a hypothetical. That makes this **non-reentrant**: never have two
   * in flight, and never issue one while a `tree.power` or `tree.optimise` job
   * is running.
   *
   * Costs a full calculation (~10ms for gems, more for config, which has to
   * rebuild the mod list). Debounce it behind a hover.
   */
  "stats.compare": {
    params: {
      change:
        /** Hold `gemId` in this slot instead. `gem` may be one past the end, to ask what adding it is worth. */
        | { kind: "gem"; group: number; gem: number; gemId: string }
        /** Flip this gem's enabled state. */
        | { kind: "gemEnabled"; group: number; gem: number }
        | { kind: "gemQuality"; group: number; gem: number; value: number }
        | { kind: "gemLevel"; group: number; gem: number; value: number }
        | { kind: "gemCount"; group: number; gem: number; value: number }
        /** Set this option, or `clear` it back to unset — which is not the same as its default. */
        | { kind: "config"; var: string; value?: unknown; clear?: boolean }
        /**
         * Equip `item` in `slot`, or omit `item` to ask what emptying the slot
         * would do.
         *
         * The only kind that does **not** mutate the build: `calcs.initEnv`
         * takes an item-shaped override, so this cannot corrupt anything. It is
         * still serialised with the rest, since the engine is single-threaded.
         *
         * A flask or tincture is *toggled* rather than swapped, so asking about
         * one already in its slot is meaningful — it answers "what if I stopped
         * using this?".
         */
        | { kind: "item"; slot: string; item?: number | false };
    };
    result: {
      stats: StatDelta[];
      /** Present only when the main skill has a minion and something changed for it. */
      minion?: StatDelta[];
    };
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

  // -- main skill -------------------------------------------------------------

  /**
   * Which skill the stats describe.
   *
   * A build's stat panel reports exactly one skill, chosen by
   * `build.mainSocketGroup` and the group's own `mainActiveSkill`. This is the
   * projection of PoB's selector sidebar (`Modules/Build.lua:1549-1647`).
   *
   * PoB decides per-skill which controls apply at all — a part selector only
   * for multi-part skills, `stageCount` only for skills that have stages, a
   * minion picker only for minion skills — so every optional field here is
   * absent rather than empty when it does not apply. Render what you are given.
   */
  "skills.mainSelection": { params: Record<string, never>; result: MainSkillSelection };

  /**
   * Change the reported skill. Every field is optional; a call sets the ones it
   * names, applied in PoB's own order — group, then skill, then the per-skill
   * settings, because each resolves against the one before it.
   *
   * The reply carries a fresh `mainSkill` because a change can alter which
   * controls exist, not just their values.
   */
  "build.setMainSkill": {
    params: {
      /** 1-based index into `MainSkillSelection.groups`. */
      group?: number;
      /** 1-based index into `MainSkillSelection.skill.options`. */
      skill?: number;
      /** 1-based index into `MainSkillSelection.part.options`. */
      part?: number;
      stageCount?: number;
      mineCount?: number;
      /** A minion id (string) or an item set id (number) — whichever `minion.kind` said. */
      minion?: string | number;
      /** 1-based index into `MainSkillSelection.minionSkill.options`. */
      minionSkill?: number;
    };
    result: { summary: BuildSummary; stats: DisplayStat[]; mainSkill: MainSkillSelection };
  };

  // -- skills and gems --------------------------------------------------------

  /** Every socket group with its gems, plus the slots a group can be assigned to. */
  "skills.list": { params: Record<string, never>; result: SkillsState };

  /**
   * Every socketable gem. ~1,500 entries, fixed for a game-data version, sorted
   * by name — fetch once and match against it client-side, as PoB's own
   * `GemSelectControl` does.
   */
  "skills.gemCatalogue": {
    /** Legacy gems are hidden by default, as in PoB. */
    params: {
      showLegacy?: boolean;
      /**
       * Only gems that may be *imbued* into an item slot: supports that are
       * neither exceptional nor awakened, and that do not themselves grant an
       * active skill (`GemSelectControl.lua:117-124`). A much narrower set than
       * "every support".
       */
      imbued?: boolean;
    };
    result: { gems: GemCatalogueEntry[] };
  };

  /** Append an empty socket group. `addedGroup` is its 1-based index. */
  "skills.addGroup": {
    params: { label?: string; slot?: string };
    result: SkillsResult & { addedGroup: number };
  };

  /** Change a group's own settings. `slot: false` clears the assignment. */
  "skills.setGroup": {
    params: {
      group: number;
      label?: string;
      slot?: string | false;
      enabled?: boolean;
      includeInFullDPS?: boolean;
      count?: number;
    };
    result: SkillsResult;
  };

  "skills.deleteGroup": { params: { group: number }; result: SkillsResult };

  /**
   * Add or change one gem.
   *
   * A `gem` index one past the end appends — that is how PoB's trailing empty
   * row works, so there is no separate add call. Appending requires `gemId`.
   */
  "skills.setGem": {
    params: {
      group: number;
      gem: number;
      gemId?: string;
      level?: number;
      quality?: number;
      count?: number;
      enabled?: boolean;
      enableGlobal1?: boolean;
      enableGlobal2?: boolean;
    };
    result: SkillsResult;
  };

  "skills.deleteGem": { params: { group: number; gem: number }; result: SkillsResult };

  /**
   * Move a gem within its group. Order is not cosmetic: gems are matched to an
   * item's sockets by position (`SkillsTab.lua:1219-1243`).
   */
  /**
   * Imbue a support into this group's item slot, or pass `false` to clear it.
   *
   * It applies to everything in the slot as if socketed, without occupying a
   * socket. The group must be assigned to a slot, since that is the key the
   * engine stores it under.
   */
  "skills.setImbuedSupport": {
    params: { group: number; gemId: string | false };
    result: SkillsResult;
  };

  "skills.reorderGem": { params: { group: number; gem: number; to: number }; result: SkillsResult };

  /**
   * Skill sets: whole gem loadouts, switchable, saved with the build.
   *
   * Switching repoints the socket-group list wholesale. The host clamps
   * `mainGroup` into the new set's range at the switch (PoB only clamps it
   * later, inside the next calculation, and destructively) and remembers where
   * each set was, so returning to one restores its selection.
   */
  "skills.newSet": {
    params: { title?: string; copyFrom?: number };
    result: SkillsResult & { createdSet: number };
  };
  "skills.activateSet": { params: { id: number }; result: SkillsResult };
  "skills.deleteSet": { params: { id: number }; result: SkillsResult };
  /** Renaming touches no gems, so it does not recalculate. */
  "skills.renameSet": { params: { id: number; title: string }; result: { skills: SkillsState } };

  // -- configuration ----------------------------------------------------------

  /**
   * The option catalogue, in PoB's own order and grouping.
   *
   * Fixed for a given game-data version and about a thousand entries, so fetch
   * it once. What changes per edit is `config.state`, which is small.
   */
  "config.schema": { params: Record<string, never>; result: { sections: ConfigSection[] } };

  /** Current values and the per-build visibility mask. */
  "config.state": { params: Record<string, never>; result: ConfigState };

  /**
   * Set and/or clear options.
   *
   * Both are batched so several can be applied in one recalculation — importing
   * quest choices writes bandit and both pantheons together. `clear` unsets an
   * option back to "never touched", which PoB treats differently from setting
   * it to its default value.
   */
  "config.set": {
    params: {
      values?: Record<string, string | number | boolean>;
      clear?: string[];
    };
    result: ConfigResult;
  };

  /**
   * Arbitrary mod text applied to the build, in named groups.
   *
   * Not part of `config.schema`: `Custom Modifiers` is a bare section marker in
   * `ConfigOptions.lua` with no entries, and the blocks live on the config set.
   */
  /* ---- items ------------------------------------------------------------ */

  "items.list": { params: Record<string, never>; result: ItemsState };

  /**
   * Which slots this item may legally go in.
   *
   * Answered by PoB's `IsItemValidForSlot`, which knows a quiver needs a bow in
   * the other hand and that two wands pair but a wand and a sceptre do not.
   * Offer exactly these rather than offering every slot and failing on commit.
   */
  "items.slotsFor": { params: { item: number }; result: { slots: string[] } };

  /**
   * Recolour and relink the item in `slot` to fit the socket groups assigned
   * to it (`SkillsTab.lua:242-283`).
   *
   * Abyssal sockets are preserved and re-appended, each unlinked. Gems past the
   * base's socket limit are dropped rather than squeezed in — the group keeps
   * them, the item simply cannot hold them.
   *
   * Answers with the skills too, since the socket groups are re-resolved.
   */
  /** Which crafting sources apply to this item; per item, not global. */
  "items.modSources": {
    params: { item: number };
    result: { sources: Array<{ id: string; label: string }> };
  };

  /**
   * Every mod this item could take from one source.
   *
   * Doubles as the mod browser — the same list, read rather than picked from.
   * `search` is a plain substring over the labels, applied server-side because
   * a source can hold thousands of entries.
   */
  "items.modPool": {
    params: { item: number; source: string; search?: string };
    result: { mods: ModCandidate[]; total: number };
  };

  /**
   * Add a mod. Either `index` into the pool for `source`, or `text` with
   * `source: "CUSTOM"` for arbitrary text.
   */
  "items.addMod": {
    params: { item: number; source: string; index?: number; text?: string };
    result: ItemsResult;
  };

  /** Remove one mod line from any of the item's six lists. */
  "items.removeMod": {
    params: {
      item: number;
      list: "buff" | "enchant" | "scourge" | "implicit" | "explicit" | "crucible";
      index: number;
    };
    result: ItemsResult;
  };

  "items.optimiseSockets": {
    params: { slot: string };
    result: ItemsResult & { skills: SkillsState };
  };

  /**
   * Add an item from the text the game puts on the clipboard.
   *
   * Parsed by `Item:ParseRaw`, the only correct reader of that format. Rejects
   * with -32602 when the base type does not resolve, which is PoB's own test
   * for "this is not an item".
   *
   * `equip` follows PoB's auto-equip into the first empty legal slot. Off by
   * default: pasting a stash tab of candidates should not redress the character.
   */
  "items.paste": { params: { text: string; equip?: boolean }; result: ItemsResult };

  /** Put an item in a slot, or pass `item: false` to empty the slot. */
  "items.equip": { params: { slot: string; item?: number | false }; result: ItemsResult };

  /**
   * Remove an item from the build entirely.
   *
   * Reaches far past the item pool: clears the item from *every* item set and
   * *every* tree spec's jewel sockets, and for a cluster jewel deallocates the
   * nodes that depended on it. Confirm before calling.
   */
  "items.delete": { params: { item: number }; result: ItemsResult };

  /** Move a rolled modifier within its range, 0..1. */
  "items.setModRange": {
    params: {
      item: number;
      list: "buff" | "enchant" | "scourge" | "implicit" | "explicit" | "crucible";
      index: number;
      range: number;
    };
    result: ItemsResult;
  };

  /** Choose a variant on one axis; `key` comes from `ItemVariants.axes`. */
  "items.setVariant": {
    params: { item: number; key?: string; index: number };
    result: ItemsResult;
  };

  /** `copyFrom` takes another set's slot assignments; the items are shared. */
  "items.newSet": {
    params: { title?: string; copyFrom?: number };
    result: ItemsResult & { createdSet: number };
  };
  "items.activateSet": { params: { id: number }; result: ItemsResult };
  "items.renameSet": { params: { id: number; title: string }; result: ItemsResult };
  "items.deleteSet": { params: { id: number }; result: ItemsResult };

  /**
   * Swap to the second weapon set. Not cosmetic — it decides which weapon
   * slots feed the calculation, and equips are redirected while it is on.
   */
  "items.setWeaponSwap": { params: { enabled: boolean }; result: ItemsResult };

  "config.customMods": {
    params: Record<string, never>;
    result: { blocks: CustomModBlock[] };
  };

  /** Check text without committing it, for feedback while typing. */
  "config.validateMods": { params: { text: string }; result: { lines: CustomModLine[] } };

  "config.addCustomMod": {
    params: { title?: string; text?: string };
    result: CustomModResult & { addedBlock: number };
  };
  "config.setCustomMod": {
    params: { index: number; title?: string; enabled?: boolean; text?: string };
    result: CustomModResult;
  };
  /** Deleting the last block re-seeds an empty one, as PoB does. */
  "config.deleteCustomMod": { params: { index: number }; result: CustomModResult };

  /**
   * A build can hold several complete sets of option values and switch between
   * them — "mapping" against "bossing". The values live on the set and are
   * saved with the build (`ConfigTab.lua:1224-1244`).
   */
  "config.newSet": {
    params: { title?: string; copyFrom?: number };
    result: ConfigResult & { createdSet: number };
  };
  "config.activateSet": { params: { id: number }; result: ConfigResult };
  "config.deleteSet": { params: { id: number }; result: ConfigResult };
  /** Renaming touches no values, so it does not recalculate. */
  "config.renameSet": { params: { id: number; title: string }; result: { config: ConfigState } };

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
