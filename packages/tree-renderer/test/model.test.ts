import { beforeEach, describe, expect, it } from 'vitest';
import { TreeModel, connectorArtState } from '../src/state/TreeModel';
import type { NodePower, TreeGeometry, TreeNode } from '../src/types';
import { realTree } from './fixture';

const ref = (i: number) => ({ sheet: 's', x: i * 10, y: 0, w: 10, h: 10 });

function node(id: number, over: Partial<TreeNode> = {}): TreeNode {
  return {
    id,
    name: `n${id}`,
    type: 'normal',
    icon: { active: ref(0), inactive: ref(1) },
    frame: { allocated: ref(2), path: ref(3), unallocated: ref(4) },
    stats: [],
    x: id * 10,
    y: 0,
    radius: 10,
    linked: [],
    ...over,
  };
}

/** 1 - 2 - 3 - 4, plus an isolated mastery 5. */
function geometry(): TreeGeometry {
  const nodes = [node(1), node(2), node(3), node(4), node(5, { type: 'mastery' })];
  const link = (from: number, to: number) => ({
    from,
    to,
    verts: [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ] as TreeGeometry['connectors'][number]['verts'],
    uvs: [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ] as TreeGeometry['connectors'][number]['uvs'],
    sheet: 's',
    state: 'normal' as const,
  });
  return {
    version: 't',
    size: 1000,
    nodes,
    connectors: [link(1, 2), link(2, 3), link(3, 4)],
    groups: [],
    sprites: {},
    sheets: {},
    extraImages: [],
  };
}

describe('allocation state', () => {
  let m: TreeModel;
  beforeEach(() => {
    m = new TreeModel(geometry());
  });

  it('reports allocated, on-path and unallocated', () => {
    m.setAllocated([1, 2]);
    m.setPathPreview([3]);
    expect(m.allocState(1)).toBe('allocated');
    expect(m.allocState(3)).toBe('path');
    expect(m.allocState(4)).toBe('unallocated');
  });

  it('never lets an already-allocated node sit in the path preview', () => {
    m.setAllocated([1, 2]);
    m.setPathPreview([1, 2, 3]);
    expect(m.pathCount).toBe(1);
    expect(m.allocState(1)).toBe('allocated');
  });

  it('activates a connector only when both ends are allocated', () => {
    m.setAllocated([1, 2]);
    expect(m.connectorState(1, 2)).toBe('allocated');
    expect(m.connectorState(2, 3)).toBe('unallocated');
  });

  it('lights the whole previewed route, not just its endpoints', () => {
    m.setAllocated([1]);
    m.setPathPreview([2, 3]);
    expect(m.connectorState(1, 2)).toBe('path');
    expect(m.connectorState(2, 3)).toBe('path');
    expect(m.connectorState(3, 4)).toBe('unallocated');
  });

  it('maps renderer states onto the schema art variants', () => {
    expect(connectorArtState('allocated')).toBe('active');
    expect(connectorArtState('path')).toBe('intermediate');
    expect(connectorArtState('unallocated')).toBe('normal');
  });

  it('bumps the revision on every visual change', () => {
    const r = m.revision;
    m.setAllocated([1]);
    expect(m.revision).toBeGreaterThan(r);
  });
});

describe('search', () => {
  it('is inactive until set and clears back to inactive', () => {
    const m = new TreeModel(geometry());
    expect(m.searchActive).toBe(false);
    m.setSearch([2, 3]);
    expect(m.searchActive).toBe(true);
    expect(m.matchesSearch(2)).toBe(true);
    expect(m.matchesSearch(1)).toBe(false);
    m.setSearch(null);
    expect(m.searchActive).toBe(false);
    expect(m.matchesSearch(2)).toBe(false);
  });

  it('dims non-matches and marks matches', () => {
    const m = new TreeModel(geometry());
    m.setSearch([3]);
    expect(m.visualFor(2)).toMatchObject({ matched: true, dimmed: false });
    expect(m.visualFor(0)).toMatchObject({ matched: false, dimmed: true });
  });

  it('an empty result set dims everything rather than clearing', () => {
    const m = new TreeModel(geometry());
    m.setSearch([]);
    expect(m.searchActive).toBe(true);
    expect(m.visualFor(0).dimmed).toBe(true);
  });
});

describe('compare', () => {
  it('classifies added, removed and unchanged', () => {
    const m = new TreeModel(geometry());
    m.setCompare([1, 2, 3], [2, 3, 4]);
    expect(m.compareState(4)).toBe('added');
    expect(m.compareState(1)).toBe('removed');
    expect(m.compareState(2)).toBe('same');
    expect(m.compareCounts).toEqual({ added: 1, removed: 1 });
  });

  it('is inactive when either side is null', () => {
    const m = new TreeModel(geometry());
    m.setCompare([1], null);
    expect(m.compareActive).toBe(false);
    expect(m.compareState(1)).toBeNull();
  });

  it('reports nothing changed for identical sets', () => {
    const m = new TreeModel(geometry());
    m.setCompare([1, 2], [2, 1]);
    expect(m.compareCounts).toEqual({ added: 0, removed: 0 });
    expect(m.compareState(1)).toBe('same');
  });
});

describe('progressive power', () => {
  const power = (id: number, perPoint: number, pathCost = 1): NodePower => ({
    id,
    offence: perPoint,
    defence: 0,
    pathCost,
    perPoint,
  });

  it('is off until asked for, and off means no heat', () => {
    const m = new TreeModel(geometry());
    m.addPower([power(1, 10)]);
    expect(m.visualFor(0).heat).toBeNull();
    expect(m.visualFor(0).pending).toBe(false);
  });

  it('marks unscored unallocated nodes as pending, and nothing else', () => {
    const m = new TreeModel(geometry());
    m.setAllocated([1]);
    m.setPowerVisible(true);
    m.addPower([power(2, 10)]);

    expect(m.visualFor(1).pending).toBe(false); // scored
    expect(m.visualFor(2).pending).toBe(true); // unscored, unallocated
    expect(m.visualFor(0).pending).toBe(false); // allocated: not a candidate
    expect(m.visualFor(4).pending).toBe(false); // mastery: never scored
  });

  it('accepts overlapping batches and keeps the latest value', () => {
    const m = new TreeModel(geometry());
    m.setPowerVisible(true);
    m.addPower([power(1, 10), power(2, 20)]);
    m.addPower([power(2, 99), power(3, 30)]);
    expect(m.powerFor(2)?.perPoint).toBe(99);
    expect(m.powerStats.received).toBe(3);
  });

  it('normalises across whatever has arrived so far', () => {
    const m = new TreeModel(geometry());
    m.setPowerVisible(true);
    m.addPower([power(1, 0), power(2, 50), power(3, 100)]);
    expect(m.heatFor(1)).toBeCloseTo(0, 5);
    expect(m.heatFor(3)).toBeCloseTo(1, 5);
    expect(m.heatFor(2)).toBeGreaterThan(0.2);
    expect(m.heatFor(2)).toBeLessThan(0.8);
  });

  it('renormalises when a later batch widens the range', () => {
    const m = new TreeModel(geometry());
    m.setPowerVisible(true);
    m.addPower([power(1, 10), power(2, 20)]);
    const before = m.heatFor(2)!;
    m.addPower([power(3, 1000)]);
    expect(m.heatFor(2)!).toBeLessThan(before);
    expect(m.heatFor(3)).toBeCloseTo(1, 5);
  });

  it('does not let a single outlier flatten the map', () => {
    // 2nd/98th percentile clipping is the whole point: a lone keystone worth
    // 100x everything else must not push every other node to heat 0.
    const geo = geometry();
    const many: NodePower[] = [];
    for (let i = 0; i < 100; i++) many.push(power(i + 1, i));
    const wide = new TreeModel({ ...geo, nodes: many.map((p) => node(p.id)) });
    wide.setPowerVisible(true);
    wide.addPower(many);
    wide.addPower([power(101, 1e6)]);
    // The 50th node should still sit near the middle of the ramp.
    expect(wide.heatFor(50)).toBeGreaterThan(0.3);
    expect(wide.heatFor(50)).toBeLessThan(0.7);
  });

  it('survives every value being identical', () => {
    const m = new TreeModel(geometry());
    m.setPowerVisible(true);
    m.addPower([power(1, 7), power(2, 7), power(3, 7)]);
    const h = m.heatFor(1);
    expect(Number.isFinite(h!)).toBe(true);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(1);
  });

  it('ignores scores for nodes that are not in this geometry', () => {
    const m = new TreeModel(geometry());
    m.setPowerVisible(true);
    m.addPower([power(999, 10)]);
    expect(m.powerStats.received).toBe(0);
  });

  it('ranks a node against everything scored so far', () => {
    const m = new TreeModel(geometry());
    m.setPowerVisible(true);
    m.addPower([power(1, 1), power(2, 2), power(3, 3), power(4, 4)]);
    expect(m.percentileFor(1)).toBeCloseTo(0, 5);
    expect(m.percentileFor(4)).toBeCloseTo(1, 5);
  });

  it('keeps scores when the overlay is toggled off and on', () => {
    const m = new TreeModel(geometry());
    m.setPowerVisible(true);
    m.addPower([power(1, 5)]);
    m.setPowerVisible(false);
    expect(m.visualFor(0).heat).toBeNull();
    m.setPowerVisible(true);
    expect(m.visualFor(0).heat).not.toBeNull();
  });

  it('switches metric without needing new data', () => {
    const m = new TreeModel(geometry());
    m.setPowerVisible(true);
    m.addPower([
      { id: 1, offence: 100, defence: 0, pathCost: 1, perPoint: 1 },
      { id: 2, offence: 0, defence: 100, pathCost: 1, perPoint: 2 },
    ]);
    m.setPowerVisible(true, 'offence');
    expect(m.heatFor(1)).toBeGreaterThan(m.heatFor(2)!);
    m.setPowerVisible(true, 'defence');
    expect(m.heatFor(2)).toBeGreaterThan(m.heatFor(1)!);
  });

  it('exposes path cost for the tooltip', () => {
    const m = new TreeModel(geometry());
    m.setPowerVisible(true);
    m.addPower([power(3, 10, 7)]);
    expect(m.pathCostFor(3)).toBe(7);
    expect(m.pathCostFor(4)).toBeNull();
  });

  it('reports progress and completion', () => {
    const m = new TreeModel(geometry());
    m.expectPower(4);
    m.setPowerVisible(true);
    m.addPower([power(1, 1), power(2, 2)]);
    expect(m.powerStats).toMatchObject({ received: 2, expected: 4, done: false });
    m.finishPower(18042);
    expect(m.powerStats).toMatchObject({ done: true, elapsedMs: 18042 });
  });

  it('clearPower resets scores but keeps the overlay on', () => {
    const m = new TreeModel(geometry());
    m.setPowerVisible(true);
    m.addPower([power(1, 1)]);
    m.clearPower();
    expect(m.powerStats.received).toBe(0);
    expect(m.powerVisible).toBe(true);
    expect(m.visualFor(0).pending).toBe(true);
  });
});

describe('visual precedence', () => {
  it('compare wins over heat, heat wins over pending', () => {
    const m = new TreeModel(geometry());
    m.setPowerVisible(true);
    m.addPower([{ id: 2, offence: 1, defence: 0, pathCost: 1, perPoint: 1 }]);
    m.setCompare([1], [2]);
    const v = m.visualFor(1);
    expect(v.compare).toBe('added');
    expect(v.heat).not.toBeNull();
    expect(v.pending).toBe(false);
  });

  it('search dimming is independent of everything else', () => {
    const m = new TreeModel(geometry());
    m.setAllocated([1]);
    m.setSearch([4]);
    expect(m.visualFor(0)).toMatchObject({ alloc: 'allocated', dimmed: true });
    expect(m.visualFor(3)).toMatchObject({ alloc: 'unallocated', matched: true, dimmed: false });
  });
});

// ---------------------------------------------------------------------------
// ascendancy switching — PassiveTreeView.lua:395-500

/**
 * Two classes, three ascendancies, one bloodline. `Raider`/`Warden` reproduces
 * the live data's id-vs-name split, and `Ascendant` is deliberately present on
 * a node but absent from `ascendancies` — the exporter gap Scion currently has.
 */
function classGeometry(): TreeGeometry {
  const g = geometry();
  g.nodes = [
    ...g.nodes,
    node(10, { type: 'ascendancy', ascendancy: 'Deadeye' }),
    node(11, { type: 'ascendancy', ascendancy: 'Raider' }),
    node(12, { type: 'ascendancy', ascendancy: 'Juggernaut' }),
    node(13, { type: 'ascendancy', ascendancy: 'Trialmaster' }),
    node(14, { type: 'ascendancy', ascendancy: 'Ascendant' }),
  ];
  g.ascendancies = [
    {
      id: 'Deadeye',
      name: 'Deadeye',
      classId: 2,
      className: 'Ranger',
      flavourText: '',
      flavourTextColour: '000000',
      flavourTextRect: { x: 0, y: 0 },
    },
    {
      id: 'Raider',
      name: 'Warden',
      classId: 2,
      className: 'Ranger',
      flavourText: '',
      flavourTextColour: '000000',
      flavourTextRect: { x: 0, y: 0 },
    },
    {
      id: 'Juggernaut',
      name: 'Juggernaut',
      classId: 1,
      className: 'Marauder',
      flavourText: '',
      flavourTextColour: '000000',
      flavourTextRect: { x: 0, y: 0 },
    },
    {
      id: 'Trialmaster',
      name: 'Chaos Bloodline',
      flavourText: '',
      flavourTextColour: '000000',
      flavourTextRect: { x: 0, y: 0 },
      alternate: true,
    },
  ];
  return g;
}

describe('ascendancy targets', () => {
  let m: TreeModel;
  beforeEach(() => {
    m = new TreeModel(classGeometry());
    m.setClass({ className: 'Ranger', ascendClassName: 'Warden' });
  });

  it('resolves the current ascendancy by display name back to its id', () => {
    expect(m.ascendancyId).toBe('Raider');
    expect(m.className).toBe('Ranger');
  });

  it('has no target for a plain passive', () => {
    expect(m.ascendancyTarget(1)).toBeNull();
  });

  it('has no target for a node of the ascendancy already selected', () => {
    expect(m.ascendancyTarget(11)).toBeNull();
  });

  it('reports a same-class switch, which PoB performs without prompting', () => {
    expect(m.ascendancyTarget(10)).toEqual({
      ascendancy: 'Deadeye',
      ascendancyName: 'Deadeye',
      classId: 2,
      className: 'Ranger',
      sameClass: true,
    });
  });

  it('reports a cross-class switch with the owning class', () => {
    expect(m.ascendancyTarget(12)).toEqual({
      ascendancy: 'Juggernaut',
      ascendancyName: 'Juggernaut',
      classId: 1,
      className: 'Marauder',
      sameClass: false,
    });
  });

  it('treats every ascendancy as foreign while the build is unascended', () => {
    m.setClass({ className: 'Ranger', ascendClassName: 'None' });
    expect(m.ascendancyId).toBeNull();
    expect(m.ascendancyTarget(11)?.ascendancy).toBe('Raider');
    expect(m.ascendancyTarget(11)?.sameClass).toBe(true);
  });

  it('leaves bloodline nodes alone — they are a secondary ascendancy', () => {
    expect(m.ascendancyTarget(13)).toBeNull();
  });

  it('falls through when the ascendancy is missing from the geometry', () => {
    // PoB does the same: no owning class found means no switch, and the click
    // goes on to normal allocation (PassiveTreeView.lua:441-459).
    expect(m.ascendancyTarget(14)).toBeNull();
  });

  it('still resolves a target when no class has been pushed in yet', () => {
    const fresh = new TreeModel(classGeometry());
    expect(fresh.ascendancyTarget(10)).toMatchObject({ sameClass: false });
  });

  it('bumps the revision, so the view redraws on a class change', () => {
    const r = m.revision;
    m.setClass({ className: 'Marauder', ascendClassName: 'Juggernaut' });
    expect(m.revision).toBeGreaterThan(r);
    expect(m.ascendancyTarget(12)).toBeNull();
  });
});

describe('ascendancy targets on the real tree', () => {
  it('agrees with the shipped 3.29 data', () => {
    const m = new TreeModel(realTree());
    const deadeye = realTree().nodes.find((n) => n.ascendancy === 'Deadeye')!;
    const jugg = realTree().nodes.find((n) => n.ascendancy === 'Juggernaut')!;

    m.setClass({ className: 'Ranger', ascendClassName: 'Deadeye' });
    expect(m.ascendancyTarget(deadeye.id)).toBeNull();
    // classId is PoB's own 0-based index, where Scion is 0 and Marauder 1.
    expect(m.ascendancyTarget(jugg.id)).toMatchObject({
      className: 'Marauder',
      classId: 1,
      sameClass: false,
    });

    // Warden ships as id `Raider`; the summary names it `Warden`.
    m.setClass({ className: 'Ranger', ascendClassName: 'Warden' });
    expect(m.ascendancyId).toBe('Raider');
    expect(m.ascendancyTarget(deadeye.id)).toMatchObject({ sameClass: true });
  });
});
