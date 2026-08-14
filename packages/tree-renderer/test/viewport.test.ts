import { describe, expect, it } from 'vitest';
import {
  clampLevel,
  clampPan,
  levelForZoom,
  panLimit,
  scaleFor,
  Viewport,
  zoomForLevel,
  MAX_ZOOM_LEVEL,
  MIN_ZOOM_LEVEL,
} from '../src/math/viewport';

describe('zoom levels', () => {
  it('is 1.2^level, per the contract', () => {
    expect(zoomForLevel(0)).toBe(1);
    expect(zoomForLevel(1)).toBeCloseTo(1.2, 10);
    expect(zoomForLevel(5)).toBeCloseTo(1.2 ** 5, 10);
    expect(zoomForLevel(-2)).toBeCloseTo(1 / 1.44, 10);
  });

  it('round-trips through levelForZoom', () => {
    for (const l of [-4, -1, 0, 3, 7, 14]) {
      expect(levelForZoom(zoomForLevel(l))).toBeCloseTo(l, 10);
    }
  });

  it('clamps to the supported range', () => {
    expect(clampLevel(-99)).toBe(MIN_ZOOM_LEVEL);
    expect(clampLevel(99)).toBe(MAX_ZOOM_LEVEL);
    expect(clampLevel(3)).toBe(3);
  });
});

describe('scaleFor', () => {
  it('fits the tree to the smaller viewport axis', () => {
    expect(scaleFor(1600, 900, 11500, 1)).toBeCloseTo(900 / 11500, 10);
    expect(scaleFor(600, 900, 11500, 1)).toBeCloseTo(600 / 11500, 10);
  });

  it('scales linearly with zoom', () => {
    const a = scaleFor(1000, 1000, 10000, 1);
    const b = scaleFor(1000, 1000, 10000, 1.2);
    expect(b / a).toBeCloseTo(1.2, 10);
  });

  it('is zero for a degenerate tree rather than Infinity', () => {
    expect(scaleFor(800, 600, 0, 1)).toBe(0);
  });
});

describe('pan clamping', () => {
  it('limits to ±viewport * zoom * 2/3', () => {
    expect(panLimit(1200, 900, 1)).toEqual({ x: 800, y: 600 });
    expect(panLimit(1200, 900, 2)).toEqual({ x: 1600, y: 1200 });
  });

  it('clamps both axes independently', () => {
    const c = clampPan({ x: 5000, y: -5000 }, 1200, 900, 1);
    expect(c).toEqual({ x: 800, y: -600 });
  });

  it('leaves in-range offsets untouched', () => {
    expect(clampPan({ x: 10, y: -20 }, 1200, 900, 1)).toEqual({ x: 10, y: -20 });
  });
});

describe('Viewport', () => {
  const make = () => {
    const vp = new Viewport(10000);
    vp.smooth = false;
    vp.resize(1000, 800);
    return vp;
  };

  it('maps tree origin to the viewport centre at rest', () => {
    const vp = make();
    expect(vp.treeToScreen({ x: 0, y: 0 })).toEqual({ x: 500, y: 400 });
  });

  it('round-trips screen <-> tree', () => {
    const vp = make();
    vp.setLevel(4, undefined, true);
    vp.panTo(120, -60, true);
    for (const p of [
      { x: 0, y: 0 },
      { x: 137, y: 902 },
      { x: 1000, y: 800 },
    ]) {
      const back = vp.screenToTree(vp.treeToScreen(p));
      expect(back.x).toBeCloseTo(p.x, 6);
      expect(back.y).toBeCloseTo(p.y, 6);
    }
  });

  it('keeps the point under the cursor fixed while zooming', () => {
    const vp = make();
    const anchor = { x: 720, y: 240 };
    const before = vp.screenToTree(anchor);
    vp.zoomByLevels(3, anchor);
    const after = vp.screenToTree(anchor);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it('composes repeated wheel ticks without drift', () => {
    const vp = make();
    const anchor = { x: 300, y: 650 };
    const before = vp.screenToTree(anchor);
    for (let i = 0; i < 6; i++) vp.zoomByLevels(1, anchor);
    expect(vp.level).toBe(6);
    const after = vp.screenToTree(anchor);
    expect(after.x).toBeCloseTo(before.x, 4);
    expect(after.y).toBeCloseTo(before.y, 4);
  });

  it('will not zoom past the limits', () => {
    const vp = make();
    vp.zoomByLevels(500);
    expect(vp.level).toBe(MAX_ZOOM_LEVEL);
    vp.zoomByLevels(-500);
    expect(vp.level).toBe(MIN_ZOOM_LEVEL);
  });

  it('clamps pan on every mutation', () => {
    const vp = make();
    vp.panBy(1e6, 1e6);
    const lim = panLimit(1000, 800, 1);
    expect(vp.x).toBeCloseTo(lim.x, 6);
    expect(vp.y).toBeCloseTo(lim.y, 6);
  });

  it('centres a tree point', () => {
    const vp = make();
    vp.centreOn({ x: 300, y: -200 }, 2, true);
    const s = vp.treeToScreen({ x: 300, y: -200 });
    expect(s.x).toBeCloseTo(500, 6);
    expect(s.y).toBeCloseTo(400, 6);
  });

  it('eases towards the target and then settles exactly', () => {
    const vp = new Viewport(10000);
    vp.resize(1000, 800);
    vp.setLevel(4);
    expect(vp.renderZoom).toBeLessThan(vp.targetZoom);
    let moving = true;
    for (let i = 0; i < 400 && moving; i++) moving = vp.tick(1 / 60);
    expect(moving).toBe(false);
    expect(vp.renderZoom).toBeCloseTo(zoomForLevel(4), 9);
  });

  it('reports visible bounds that contain the viewport corners', () => {
    const vp = make();
    vp.setLevel(2, undefined, true);
    const b = vp.visibleBounds();
    const tl = vp.screenToTree({ x: 0, y: 0 });
    const br = vp.screenToTree({ x: 1000, y: 800 });
    expect(b.minX).toBeLessThanOrEqual(tl.x);
    expect(b.maxX).toBeGreaterThanOrEqual(br.x);
  });
});
