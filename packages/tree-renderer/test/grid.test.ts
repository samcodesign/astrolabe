import { describe, expect, it } from 'vitest';
import { SpatialGrid } from '../src/math/grid';
import { realTree } from './fixture';

interface Item {
  x: number;
  y: number;
  radius: number;
}

/** Reference implementation: exactly what PassiveTreeView.lua does per frame. */
function linearPick(items: Item[], x: number, y: number, tolerance = 0, minRadius = 0): number {
  let best = -1;
  let bestScore = Infinity;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const dx = it.x - x;
    const dy = it.y - y;
    const d2 = dx * dx + dy * dy;
    const r = Math.max(it.radius, minRadius) + tolerance;
    if (d2 > r * r) continue;
    const score = d2 / (r * r);
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

describe('SpatialGrid', () => {
  it('finds the item under a point', () => {
    const items: Item[] = [
      { x: 0, y: 0, radius: 10 },
      { x: 100, y: 0, radius: 10 },
      { x: 0, y: 100, radius: 10 },
    ];
    const g = new SpatialGrid(items);
    expect(g.pick(1, 1)).toBe(0);
    expect(g.pick(102, -3)).toBe(1);
    expect(g.pick(50, 50)).toBe(-1);
  });

  it('respects the item radius as the hit boundary', () => {
    const g = new SpatialGrid<Item>([{ x: 0, y: 0, radius: 10 }]);
    expect(g.pick(9.99, 0)).toBe(0);
    expect(g.pick(10.01, 0)).toBe(-1);
  });

  it('honours minRadius so tiny nodes stay grabbable when zoomed out', () => {
    const g = new SpatialGrid<Item>([{ x: 0, y: 0, radius: 2 }]);
    expect(g.pick(20, 0)).toBe(-1);
    expect(g.pick(20, 0, 0, 30)).toBe(0);
  });

  it('prefers the smaller node when two overlap', () => {
    // A small node sitting on a big one must still be clickable.
    const items: Item[] = [
      { x: 0, y: 0, radius: 100 },
      { x: 20, y: 0, radius: 12 },
    ];
    const g = new SpatialGrid(items);
    expect(g.pick(20, 0)).toBe(1);
    expect(g.pick(-60, 0)).toBe(0);
  });

  it('agrees with a linear scan over a real-shaped tree', () => {
    const geo = realTree();
    const items: Item[] = geo.nodes.map((n) => ({ x: n.x, y: n.y, radius: Math.max(n.radius, 1) }));
    const g = new SpatialGrid(items);
    // Deterministic probe, so a failure is reproducible.
    let seed = 3;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    let hits = 0;
    for (let i = 0; i < 4000; i++) {
      const x = (rnd() - 0.5) * 24000;
      const y = (rnd() - 0.5) * 24000;
      const minRadius = i % 3 === 0 ? 40 : 0;
      const a = g.pick(x, y, 0, minRadius);
      const b = linearPick(items, x, y, 0, minRadius);
      expect(a).toBe(b);
      if (a >= 0) hits++;
    }
    // Sanity: the probe actually hit things, so the agreement means something.
    expect(hits).toBeGreaterThan(100);
  });

  it('queries rectangles and circles consistently', () => {
    const geo = realTree();
    const items: Item[] = geo.nodes.map((n) => ({ x: n.x, y: n.y, radius: Math.max(n.radius, 1) }));
    const g = new SpatialGrid(items);

    const inRect = g.queryRect(-1500, -1500, 1500, 1500).sort((a, b) => a - b);
    const expectRect = items
      .map((it, i) => [it, i] as const)
      .filter(([it]) => it.x >= -1500 && it.x <= 1500 && it.y >= -1500 && it.y <= 1500)
      .map(([, i]) => i);
    expect(inRect).toEqual(expectRect);

    const inCircle = new Set(g.queryCircle(0, 0, 2200));
    for (let i = 0; i < items.length; i++) {
      const d = Math.hypot(items[i].x, items[i].y);
      expect(inCircle.has(i)).toBe(d <= 2200);
    }
  });

  it('handles an empty tree without throwing', () => {
    const g = new SpatialGrid<Item>([]);
    expect(g.pick(0, 0)).toBe(-1);
    expect(g.queryRect(-1, -1, 1, 1)).toEqual([]);
  });

  it('keeps buckets small enough to be worth the trouble', () => {
    const geo = realTree();
    const g = new SpatialGrid(
      geo.nodes.map((n) => ({ x: n.x, y: n.y, radius: Math.max(n.radius, 1) })),
    );
    const s = g.stats();
    expect(s.items).toBe(geo.nodes.length);
    // Anything above ~40 would mean the grid has degenerated toward a scan.
    expect(s.maxBucket).toBeLessThan(40);
    expect(s.meanBucket).toBeLessThan(12);
  });
});
