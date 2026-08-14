import type {
  AllocState,
  Ascendancy,
  AscendancySelection,
  BuildClass,
  CompareState,
  ConnectorState,
  JewelRadius,
  MasteryEffect,
  MasterySelections,
  NodeId,
  NodePower,
  TreeGeometry,
  TreeNode,
} from '../types';

export interface PowerStats {
  /** Nodes scored so far. */
  received: number;
  /** Total the engine said it would score, if known. */
  expected: number;
  min: number;
  max: number;
  /** Robust low/high used for colour normalisation (2nd/98th percentile). */
  lo: number;
  hi: number;
  done: boolean;
  elapsedMs?: number;
}

export type PowerMetric = 'perPoint' | 'offence' | 'defence';

/** What `ascendancyTarget` resolves; the view adds the node and its position. */
export type AscendancyTarget = Omit<AscendancySelection, 'node' | 'screen'>;

export interface NodeVisualState {
  alloc: AllocState;
  compare: CompareState | null;
  /** Search is active and this node did not match. */
  dimmed: boolean;
  /** Search is active and this node did match. */
  matched: boolean;
  /** Normalised 0..1 heat value, or null when power mode is off. */
  heat: number | null;
  /** Power mode is on but the engine has not scored this node yet. */
  pending: boolean;
  /** The heatmap is on at all — lets styling recede nodes outside the pass. */
  powerActive: boolean;
  hovered: boolean;
  selected: boolean;
  /**
   * Draw the node's `effect` overlay — an allocated mastery with a chosen
   * effect, or an allocated tattooed node.
   */
  effectActive: boolean;
  /** A mastery that is reachable/allocated but has no effect chosen yet. */
  masteryUnchosen: boolean;
}

/**
 * Everything the renderer knows about the tree that is not geometry: which
 * nodes are allocated, what the engine has scored, what the user searched for.
 *
 * Deliberately free of any Pixi import so the interesting logic — connector
 * state derivation, progressive heat normalisation, search/compare precedence
 * — is unit-testable without a GPU.
 */
export class TreeModel {
  readonly geometry: TreeGeometry;
  readonly nodes: readonly TreeNode[];
  /** node id -> index into `nodes`. */
  readonly index = new Map<NodeId, number>();

  private readonly allocated = new Set<NodeId>();
  private readonly pathPreview = new Set<NodeId>();
  private readonly selected = new Set<NodeId>();

  private searchSet: Set<NodeId> | null = null;
  private compareAdded: Set<NodeId> | null = null;
  private compareRemoved: Set<NodeId> | null = null;

  private power = new Map<NodeId, NodePower>();
  private powerValues: number[] = [];
  private powerOn = false;
  private metric: PowerMetric = 'perPoint';
  private stats: PowerStats = {
    received: 0,
    expected: 0,
    min: 0,
    max: 0,
    lo: 0,
    hi: 1,
    done: false,
  };

  hovered: NodeId | null = null;
  jewels: JewelRadius[] = [];
  /** Mastery node id -> chosen effect id, from `BuildSummary.masterySelections`. */
  private masteries: MasterySelections = {};

  private buildClass: BuildClass | null = null;
  /**
   * Keyed by `id` *and* `name`: node data references an ascendancy by id, while
   * `BuildSummary.ascendClassName` names it by display name, and the two differ
   * (Warden's id is `Raider`). PoB indexes both for the same reason
   * (`PassiveTree.lua:170-174`).
   */
  private readonly ascendancies = new Map<string, Ascendancy>();

  /** Bumped whenever anything that affects appearance changes. */
  revision = 0;

  constructor(geometry: TreeGeometry) {
    this.geometry = geometry;
    this.nodes = geometry.nodes;
    for (let i = 0; i < this.nodes.length; i++) this.index.set(this.nodes[i].id, i);
    for (const asc of geometry.ascendancies ?? []) {
      if (asc.id) this.ascendancies.set(asc.id, asc);
      if (asc.name) this.ascendancies.set(asc.name, asc);
    }
  }

  private touch(): void {
    this.revision++;
  }

  // -------------------------------------------------------------- allocation

  setAllocated(ids: Iterable<NodeId>): void {
    this.allocated.clear();
    for (const id of ids) this.allocated.add(id);
    this.touch();
  }

  setPathPreview(ids: Iterable<NodeId> | null): void {
    this.pathPreview.clear();
    if (ids) for (const id of ids) if (!this.allocated.has(id)) this.pathPreview.add(id);
    this.touch();
  }

  setSelected(ids: Iterable<NodeId> | null): void {
    this.selected.clear();
    if (ids) for (const id of ids) this.selected.add(id);
    this.touch();
  }

  isAllocated(id: NodeId): boolean {
    return this.allocated.has(id);
  }

  get allocatedCount(): number {
    return this.allocated.size;
  }

  get pathCount(): number {
    return this.pathPreview.size;
  }

  /**
   * A mastery is only really allocated once an effect has been chosen
   * (PassiveSpec.lua:283). Until then it is drawn as reachable-but-unchosen, so
   * the tree never claims a point has been spent when it has not.
   */
  allocState(id: NodeId): AllocState {
    if (this.allocated.has(id)) {
      const i = this.index.get(id);
      if (i !== undefined && this.nodes[i].type === 'mastery' && this.masteries[id] === undefined) {
        return 'path';
      }
      return 'allocated';
    }
    if (this.pathPreview.has(id)) return 'path';
    return 'unallocated';
  }

  // ---------------------------------------------------------------- masteries

  /** Replace the whole selection map, e.g. from `BuildSummary`. */
  setMasterySelections(selections: MasterySelections | null): void {
    this.masteries = selections ? { ...selections } : {};
    this.touch();
  }

  /** Update one mastery, mirroring `tree.setMastery`. */
  setMastery(node: NodeId, effect: number | null): void {
    if (effect === null) delete this.masteries[node];
    else this.masteries[node] = effect;
    this.touch();
  }

  /** Chosen effect id for a mastery, or null. */
  masterySelection(node: NodeId): number | null {
    const v = this.masteries[node];
    return v === undefined ? null : v;
  }

  get masterySelections(): MasterySelections {
    return { ...this.masteries };
  }

  /**
   * Refresh `available` flags, mirroring the result of `tree.setMastery`.
   * An effect may be selected on only one mastery at a time (TreeTab.lua:1019).
   */
  setMasteryEffects(table: Record<NodeId, MasteryEffect[]>): void {
    for (const [id, effects] of Object.entries(table)) {
      const i = this.index.get(Number(id));
      if (i === undefined) continue;
      (this.nodes[i] as TreeNode).masteryEffects = effects;
    }
    this.touch();
  }

  effectsFor(node: NodeId): MasteryEffect[] {
    const i = this.index.get(node);
    return (i !== undefined && this.nodes[i].masteryEffects) || [];
  }

  /**
   * A link is active only when both ends are allocated, and intermediate when
   * exactly one end is — the same rule PoB uses, extended so a hovered path
   * preview lights its whole route rather than just its endpoints.
   */
  connectorState(from: NodeId, to: NodeId): AllocState {
    const a = this.allocState(from);
    const b = this.allocState(to);
    if (a === 'allocated' && b === 'allocated') return 'allocated';
    if (a === 'unallocated' || b === 'unallocated') return 'unallocated';
    return 'path';
  }

  // -------------------------------------------------------------------- class

  /**
   * The build's class, from `BuildSummary`. Arrives the same way allocation and
   * mastery selections do — pushed in after every engine round trip — because
   * it is the same kind of thing: engine-owned state the view reads.
   */
  setClass(cls: BuildClass | null): void {
    this.buildClass = cls;
    this.touch();
  }

  get className(): string | null {
    return this.buildClass?.className ?? null;
  }

  /**
   * The current ascendancy as an *id*, i.e. PoB's `curAscendClassBaseName` —
   * the form `TreeNode.ascendancy` uses. Null when unascended, which PoB spells
   * `curAscendClassId == 0` and the summary spells `"None"`.
   */
  get ascendancyId(): string | null {
    const name = this.buildClass?.ascendClassName;
    if (!name || name === 'None') return null;
    return this.ascendancies.get(name)?.id ?? name;
  }

  /** Look an ascendancy up by either its id or its display name. */
  ascendancyFor(key: string): Ascendancy | undefined {
    return this.ascendancies.get(key);
  }

  /**
   * Whether clicking this node is a class/ascendancy switch rather than an
   * allocation, and if so what it switches to.
   *
   * Mirrors `PassiveTreeView.lua:395-437`, which reaches this only for an
   * unallocated node — allocated ones deallocate (`:391`). Returns null, i.e.
   * "allocate normally", in the three cases PoB also falls through on:
   *
   *   - the node is not an ascendancy node at all;
   *   - it belongs to the ascendancy already selected (`:416`);
   *   - no owning class can be found for it (`:459` leaves `targetBaseClassId`
   *     nil and the switch never happens). That covers bloodline/alternate
   *     ascendancies, which PoB routes to `SelectSecondaryAscendClass` (`:400`)
   *     — deliberately out of scope here, so they keep today's behaviour rather
   *     than being mistaken for a base-class change.
   */
  ascendancyTarget(id: NodeId): AscendancyTarget | null {
    const i = this.index.get(id);
    if (i === undefined) return null;
    const ascendancy = this.nodes[i].ascendancy;
    if (!ascendancy || ascendancy === this.ascendancyId) return null;

    const entry = this.ascendancies.get(ascendancy);
    if (!entry || entry.classId === undefined || !entry.className) return null;

    return {
      ascendancy: entry.id,
      ascendancyName: entry.name,
      classId: entry.classId,
      className: entry.className,
      sameClass: entry.className === this.buildClass?.className,
    };
  }

  // ------------------------------------------------------------------- search

  setSearch(ids: Iterable<NodeId> | null): void {
    this.searchSet = ids ? new Set(ids) : null;
    this.touch();
  }

  get searchActive(): boolean {
    return this.searchSet !== null;
  }

  get searchCount(): number {
    return this.searchSet?.size ?? 0;
  }

  matchesSearch(id: NodeId): boolean {
    return this.searchSet ? this.searchSet.has(id) : false;
  }

  // ------------------------------------------------------------------ compare

  /**
   * `base` is what the build has now, `other` is the candidate. Nodes only in
   * `other` read as added, nodes only in `base` as removed.
   */
  setCompare(base: Iterable<NodeId> | null, other: Iterable<NodeId> | null): void {
    if (!base || !other) {
      this.compareAdded = null;
      this.compareRemoved = null;
      this.touch();
      return;
    }
    const a = new Set(base);
    const b = new Set(other);
    const added = new Set<NodeId>();
    const removed = new Set<NodeId>();
    for (const id of b) if (!a.has(id)) added.add(id);
    for (const id of a) if (!b.has(id)) removed.add(id);
    this.compareAdded = added;
    this.compareRemoved = removed;
    this.touch();
  }

  get compareActive(): boolean {
    return this.compareAdded !== null;
  }

  get compareCounts(): { added: number; removed: number } {
    return { added: this.compareAdded?.size ?? 0, removed: this.compareRemoved?.size ?? 0 };
  }

  compareState(id: NodeId): CompareState | null {
    if (!this.compareAdded || !this.compareRemoved) return null;
    if (this.compareAdded.has(id)) return 'added';
    if (this.compareRemoved.has(id)) return 'removed';
    return 'same';
  }

  // -------------------------------------------------------------------- power

  /** Turn the heatmap on/off without discarding scores already received. */
  setPowerVisible(on: boolean, metric: PowerMetric = this.metric): void {
    this.powerOn = on;
    if (metric !== this.metric) {
      this.metric = metric;
      this.recomputeValues();
    }
    this.touch();
  }

  get powerVisible(): boolean {
    return this.powerOn;
  }

  clearPower(): void {
    this.power.clear();
    this.powerValues = [];
    this.stats = { received: 0, expected: this.stats.expected, min: 0, max: 0, lo: 0, hi: 1, done: false };
    this.touch();
  }

  /** Tell the model how many nodes to expect, from `tree.power`'s result. */
  expectPower(total: number): void {
    this.stats = { ...this.stats, expected: total, done: false };
    this.touch();
  }

  /**
   * Merge a `tree.power.progress` batch.
   *
   * The engine streams these ordered by path distance over ~18 s, so this must
   * be safe to call dozens of times with partial, overlapping data. Values are
   * re-normalised on arrival against robust percentiles rather than min/max, so
   * one outlier keystone late in the stream does not wash out the whole map.
   */
  addPower(batch: readonly NodePower[], meta?: { done?: number; total?: number }): void {
    for (const p of batch) {
      if (!this.index.has(p.id)) continue;
      this.power.set(p.id, p);
    }
    if (meta?.total) this.stats.expected = meta.total;
    this.recomputeValues();
    this.touch();
  }

  finishPower(elapsedMs?: number): void {
    this.stats = { ...this.stats, done: true, elapsedMs };
    this.touch();
  }

  private metricValue(p: NodePower): number {
    switch (this.metric) {
      case 'offence':
        return p.offence;
      case 'defence':
        return p.defence;
      default:
        return p.perPoint;
    }
  }

  private recomputeValues(): void {
    const vals: number[] = [];
    let min = Infinity;
    let max = -Infinity;
    for (const p of this.power.values()) {
      const v = this.metricValue(p);
      if (!Number.isFinite(v)) continue;
      vals.push(v);
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (!vals.length) {
      this.stats = { ...this.stats, received: 0, min: 0, max: 0, lo: 0, hi: 1 };
      this.powerValues = [];
      return;
    }
    vals.sort((a, b) => a - b);
    this.powerValues = vals;
    const q = (t: number) => vals[Math.min(vals.length - 1, Math.max(0, Math.round(t * (vals.length - 1))))];
    let lo = q(0.02);
    let hi = q(0.98);
    if (hi - lo < 1e-9) {
      // Everything scored the same so far: keep a band so the ramp is stable.
      lo = Math.min(0, min);
      hi = Math.max(max, lo + 1e-6);
    }
    this.stats = { ...this.stats, received: vals.length, min, max, lo, hi };
  }

  get powerStats(): PowerStats {
    return this.stats;
  }

  powerFor(id: NodeId): NodePower | undefined {
    return this.power.get(id);
  }

  /** Normalised 0..1 heat, or null when the node has not been scored. */
  heatFor(id: NodeId): number | null {
    const p = this.power.get(id);
    if (!p) return null;
    const v = this.metricValue(p);
    if (!Number.isFinite(v)) return null;
    const { lo, hi } = this.stats;
    if (hi <= lo) return 0.5;
    return Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
  }

  /** Rank of a node among everything scored so far, 0..1. Used in tooltips. */
  percentileFor(id: NodeId): number | null {
    const p = this.power.get(id);
    if (!p || !this.powerValues.length) return null;
    const v = this.metricValue(p);
    let lo = 0;
    let hi = this.powerValues.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.powerValues[mid] < v) lo = mid + 1;
      else hi = mid;
    }
    return lo / Math.max(1, this.powerValues.length - 1);
  }

  // ------------------------------------------------------------------ resolve

  visualFor(i: number): NodeVisualState {
    const node = this.nodes[i];
    const id = node.id;
    const alloc = this.allocState(id);
    const compare = this.compareState(id);
    const matched = this.matchesSearch(id);
    const dimmed = this.searchActive && !matched;
    const heat = this.powerOn ? this.heatFor(id) : null;
    // Only unallocated, scoreable nodes can be "waiting for the engine".
    // An already-allocated node is not a candidate, and masteries have no
    // standalone value, so neither should read as pending.
    const pending =
      this.powerOn && heat === null && alloc === 'unallocated' && node.type !== 'mastery';
    const isMastery = node.type === 'mastery';
    const chosen = isMastery ? this.masteries[id] !== undefined : false;
    return {
      alloc,
      compare,
      dimmed,
      matched,
      heat,
      pending,
      powerActive: this.powerOn,
      hovered: this.hovered === id,
      selected: this.selected.has(id),
      // A mastery only glows once its effect is picked; everything else glows
      // as soon as it is allocated.
      effectActive: alloc === 'allocated' && (!isMastery || chosen),
      masteryUnchosen: isMastery && this.allocated.has(id) && !chosen,
    };
  }

  /** Path cost from the engine's power pass, when it has reached this node. */
  pathCostFor(id: NodeId): number | null {
    return this.power.get(id)?.pathCost ?? null;
  }
}

/** Maps a renderer allocation state to the schema's connector art variants. */
export function connectorArtState(state: AllocState): ConnectorState {
  switch (state) {
    case 'allocated':
      return 'active';
    case 'path':
      return 'intermediate';
    default:
      return 'normal';
  }
}
