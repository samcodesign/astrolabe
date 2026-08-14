import { describe, expect, it } from 'vitest';
import { uvScaleFor } from '../src/gfx/atlas';
import { heatColour, mixRGBA, rgba, scaleRGB, toCss } from '../src/theme';
import {
  ART_SCALE,
  FLAVOUR_TEXT_FONT_SIZE,
  FLAVOUR_TEXT_MIN_ZOOM,
  HALF_GROUP_BACKGROUNDS,
  NODE_OVERLAY,
  dimFlavourColour,
  drawAssetHalfRects,
  backdropTileScale,
  BACKDROP_TILE_ZOOM,
  drawAssetRect,
  flavourTextOffset,
  frameFieldFor,
  nodeMatchesSearch,
  parseSearchQuery,
  planNodeArt,
  pobCompareNodeColour,
  pobConnectorState,
  pobFrameState,
  pobHitRadius,
  spriteTreeSize,
  toAllocState,
} from '../src/pob/nodeArt';
import { realTree } from './fixture';

describe('uv normalisation', () => {
  it('leaves already-normalised UVs alone', () => {
    expect(uvScaleFor([{ x: 0, y: 0 }, { x: 1, y: 1 }], 2048, 2048)).toEqual({ sx: 1, sy: 1 });
  });

  it('converts pixel UVs using the sheet size', () => {
    const s = uvScaleFor([{ x: 0, y: 0 }, { x: 512, y: 256 }], 2048, 1024);
    expect(s.sx).toBeCloseTo(1 / 2048, 12);
    expect(s.sy).toBeCloseTo(1 / 1024, 12);
  });

  it('does not divide by zero for an unknown sheet', () => {
    expect(Number.isFinite(uvScaleFor([{ x: 0, y: 0 }, { x: 4, y: 4 }], 0, 0).sx)).toBe(true);
  });
});

describe('theme colour maths', () => {
  it('unpacks hex to 0..1 channels', () => {
    expect(rgba(0xff8000, 0.5)).toEqual({ r: 1, g: 128 / 255, b: 0, a: 0.5 });
  });

  it('mixes linearly', () => {
    expect(mixRGBA(rgba(0x000000, 0), rgba(0xffffff, 1), 0.5)).toEqual({
      r: 0.5,
      g: 0.5,
      b: 0.5,
      a: 0.5,
    });
  });

  it('scales rgb without touching alpha unless asked', () => {
    const c = scaleRGB(rgba(0x808080, 0.4), 0.5);
    expect(c.a).toBe(0.4);
    expect(c.r).toBeCloseTo(0.251, 3);
  });

  it('clamps the heat ramp and keeps lightness monotonic', () => {
    expect(heatColour(-5)).toEqual(heatColour(0));
    expect(heatColour(5)).toEqual(heatColour(1));
    // Monotonic lightness is what makes the map readable in greyscale and to
    // red/green-deficient viewers; assert it directly.
    let last = -1;
    for (let i = 0; i <= 40; i++) {
      const c = heatColour(i / 40);
      const l = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
      expect(l).toBeGreaterThan(last - 1e-6);
      last = l;
    }
  });

  it('emits usable CSS', () => {
    expect(toCss(rgba(0x0a0b0c, 1))).toBe('rgba(10, 11, 12, 1.000)');
  });
});

// ---------------------------------------------------------------------------
// the ported PoB logic

describe('PoB sizing', () => {
  it('derives the hit radius as artWidth * 1.33', () => {
    expect(pobHitRadius('notable')).toBeCloseTo(58 * ART_SCALE, 6);
    expect(pobHitRadius('keystone')).toBeCloseTo(84 * ART_SCALE, 6);
    expect(NODE_OVERLAY.Normal.artWidth).toBe(40);
  });

  it('draws a sprite at 2.66 tree units per art pixel', () => {
    expect(spriteTreeSize(58)).toBeCloseTo(58 * 2 * ART_SCALE, 6);
  });

  it('agrees with the radius the real tree ships', () => {
    // PassiveTree.lua:470 derives the radius from `nodeOverlay[type].artWidth`,
    // NOT from the frame sprite's own width — a mastery uses artWidth 65 while
    // reusing the 58px ascendancy frame art. Porting the table rather than
    // measuring the sprite is what makes this line up.
    const geo = realTree();
    let checked = 0;
    for (const n of geo.nodes) {
      const expected = pobHitRadius(n.type);
      if (!expected || !n.radius) continue;
      expect(n.radius).toBeCloseTo(expected, 1);
      checked++;
    }
    expect(checked).toBeGreaterThan(2000);
  });
});

describe('tiled backdrop', () => {
  // PassiveTreeView.lua:537-544 fills the viewport with `Background2` and
  // scrolls it via UVs, sizing one tile as `bg.width * scale * 1.33 * 2.5`.
  it('sizes one tile the way PoB does', () => {
    const tileWidth = 256;
    for (const scale of [0.03, 0.0629, 0.25, 1, 2.5]) {
      const pobBgSize = tileWidth * scale * ART_SCALE * BACKDROP_TILE_ZOOM;
      expect(backdropTileScale(scale) * tileWidth).toBeCloseTo(pobBgSize, 9);
    }
  });

  it('keeps the tile locked to tree space, not the screen', () => {
    // Doubling the zoom must double the tile, or the backdrop would visibly
    // swim against the nodes while panning.
    expect(backdropTileScale(0.5)).toBeCloseTo(backdropTileScale(0.25) * 2, 9);
    expect(backdropTileScale(0)).toBe(0);
  });

  it('ships the backdrop art the real tree asks for', () => {
    const geo = realTree();
    const bg = geo.sprites.Background2 ?? geo.sprites.Background1;
    expect(bg).toBeDefined();
    // A whole-file sprite, so the tile is the texture itself.
    expect(bg.x).toBe(0);
    expect(bg.y).toBe(0);
    expect(bg.w).toBeGreaterThan(0);
    expect(geo.sheets[bg.sheet]).toBeDefined();
  });
});

describe('PoB frame state', () => {
  const base = { isAlloc: false, showHeatMap: false, isHovered: false, onHoverPath: false };

  it('is unalloc by default', () => {
    expect(pobFrameState(base)).toBe('unalloc');
  });

  it('promotes an allocated, hovered or trace-end node to alloc', () => {
    expect(pobFrameState({ ...base, isAlloc: true })).toBe('alloc');
    expect(pobFrameState({ ...base, isHovered: true })).toBe('alloc');
    expect(pobFrameState({ ...base, isTraceEnd: true })).toBe('alloc');
  });

  it('promotes everything to alloc while the heatmap is up', () => {
    // Deliberate in PoB: a dim frame swallows the colour the map is showing.
    expect(pobFrameState({ ...base, showHeatMap: true })).toBe('alloc');
  });

  it('uses the path frame for a previewed route', () => {
    expect(pobFrameState({ ...base, onHoverPath: true })).toBe('path');
  });

  it('maps states onto the schema frame fields', () => {
    expect(frameFieldFor('alloc')).toBe('allocated');
    expect(frameFieldFor('path')).toBe('path');
    expect(frameFieldFor('unalloc')).toBe('unallocated');
  });
});

describe('PoB node art plan', () => {
  const base = { isAlloc: false, showHeatMap: false, isHovered: false, onHoverPath: false };

  it('swaps the icon atlas rather than tinting', () => {
    expect(planNodeArt({ ...base, type: 'notable' }).icon).toBe('inactive');
    expect(planNodeArt({ ...base, type: 'notable', isAlloc: true }).icon).toBe('active');
  });

  it('gives a class start no icon at all', () => {
    const p = planNodeArt({ ...base, type: 'classStart' });
    expect(p.icon).toBeNull();
    expect(p.frameIsBase).toBe(true);
  });

  it('uses the frame as a socket’s base art', () => {
    const p = planNodeArt({ ...base, type: 'socket', isAlloc: true });
    expect(p.icon).toBeNull();
    expect(p.frameIsBase).toBe(true);
  });

  it('draws masteries below the connectors', () => {
    expect(planNodeArt({ ...base, type: 'mastery', hasMasteryEffects: true }).layer).toBe(15);
    expect(planNodeArt({ ...base, type: 'notable' }).layer).toBe(25);
  });

  it('only lights a mastery once an effect is chosen', () => {
    const allocatedUnchosen = planNodeArt({
      ...base,
      type: 'mastery',
      hasMasteryEffects: true,
      isAlloc: true,
      masteryChosen: false,
    });
    expect(allocatedUnchosen.icon).toBe('inactive');
    expect(allocatedUnchosen.effect).toBe(false);

    const chosen = planNodeArt({
      ...base,
      type: 'mastery',
      hasMasteryEffects: true,
      isAlloc: true,
      masteryChosen: true,
    });
    expect(chosen.icon).toBe('active');
    expect(chosen.effect).toBe(true);
  });
});

describe('PoB connector state', () => {
  const base = { hoverPathActive: false, aOnHoverPath: false, bOnHoverPath: false };

  it('is Active only when both ends are allocated', () => {
    expect(pobConnectorState({ ...base, aAlloc: true, bAlloc: true })).toBe('Active');
    expect(pobConnectorState({ ...base, aAlloc: true, bAlloc: false })).toBe('Normal');
  });

  it('is Intermediate along a previewed route', () => {
    expect(
      pobConnectorState({
        aAlloc: true,
        bAlloc: false,
        hoverPathActive: true,
        aOnHoverPath: true,
        bOnHoverPath: true,
      }),
    ).toBe('Intermediate');
  });

  it('stays Normal when only one end is on the route', () => {
    expect(
      pobConnectorState({
        aAlloc: false,
        bAlloc: false,
        hoverPathActive: true,
        aOnHoverPath: true,
        bOnHoverPath: false,
      }),
    ).toBe('Normal');
  });

  it('maps onto the renderer states', () => {
    expect(toAllocState('Active')).toBe('allocated');
    expect(toAllocState('Intermediate')).toBe('path');
    expect(toAllocState('Normal')).toBe('unallocated');
  });
});

describe('PoB compare colouring', () => {
  it('greens additions and reds removals', () => {
    expect(pobCompareNodeColour({ type: 'normal', baseAlloc: false, otherAlloc: true })).toBe('added');
    expect(pobCompareNodeColour({ type: 'normal', baseAlloc: true, otherAlloc: false })).toBe('removed');
  });

  it('flags a mastery whose chosen effect differs, not just its allocation', () => {
    expect(
      pobCompareNodeColour({ type: 'mastery', baseAlloc: true, otherAlloc: true, contentsDiffer: true }),
    ).toBe('changed');
    expect(
      pobCompareNodeColour({ type: 'normal', baseAlloc: true, otherAlloc: true, contentsDiffer: true }),
    ).toBe('same');
  });
});

describe('PoB search', () => {
  const geo = realTree();
  const node = (name: string) => geo.nodes.find((n) => n.name === name)!;

  it('splits quoted phrases from bare terms', () => {
    expect(parseSearchQuery('life "increased maximum" crit')).toEqual([
      'life',
      'increased maximum',
      'crit',
    ]);
  });

  it('requires every term to match somewhere', () => {
    const n = geo.nodes.find((x) => x.stats.some((s) => /maximum Life/i.test(s)))!;
    expect(nodeMatchesSearch(n, ['maximum', 'life'])).toBe(true);
    expect(nodeMatchesSearch(n, ['maximum', 'life', 'zzzznope'])).toBe(false);
  });

  it('matches the node name', () => {
    const n = node('Twin Terrors') ?? geo.nodes.find((x) => x.type === 'notable')!;
    expect(nodeMatchesSearch(n, [n.name.toLowerCase()])).toBe(true);
  });

  it('matches the node type', () => {
    const k = geo.nodes.find((n) => n.type === 'keystone')!;
    expect(nodeMatchesSearch(k, ['keystone'])).toBe(true);
  });

  it('skips class starts and effect-less masteries, as PoB does', () => {
    const cs = geo.nodes.find((n) => n.type === 'classStart');
    if (cs) expect(nodeMatchesSearch(cs, ['classstart'])).toBe(false);
    expect(nodeMatchesSearch({ ...geo.nodes[0], type: 'mastery', masteryEffects: [] }, ['a'])).toBe(false);
  });

  it('searches a mastery through the effects its chooser offers', () => {
    const m = geo.nodes.find((n) => n.type === 'mastery' && n.masteryEffects?.length)!;
    const word = m.masteryEffects![0].stats[0].split(' ').find((w) => w.length > 5)!;
    expect(nodeMatchesSearch(m, [word.toLowerCase()])).toBe(true);
  });

  it('returns nothing for an empty query', () => {
    expect(nodeMatchesSearch(geo.nodes[0], [])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// the real fixture

describe('the real 3.29 tree', () => {
  const geo = realTree();

  it('is the size the renderer expects', () => {
    expect(geo.version).toBe('3_29');
    expect(geo.nodes.length).toBeGreaterThan(2500);
    expect(geo.connectors.length).toBeGreaterThan(8000);
    expect(geo.size).toBeGreaterThan(1000);
  });

  it('gives every node an id, a frame and coordinates', () => {
    expect(new Set(geo.nodes.map((n) => n.id)).size).toBe(geo.nodes.length);
    for (const n of geo.nodes) {
      expect(Number.isFinite(n.x) && Number.isFinite(n.y)).toBe(true);
      expect(n.frame).toBeDefined();
    }
  });

  it('gives every non-socket, non-classStart node an icon', () => {
    // The single most visible failure mode is a tree of bare frames.
    const drawable = geo.nodes.filter((n) => n.type !== 'socket' && n.type !== 'classStart');
    const withIcon = drawable.filter((n) => n.icon?.active || n.icon?.inactive);
    // ~1% are ascendancy start markers, which are frame-only like class starts.
    expect(withIcon.length / drawable.length).toBeGreaterThan(0.98);
  });

  it('takes inactive icons from the desaturated atlas, not a tint', () => {
    const n = geo.nodes.find((x) => x.icon?.active && x.icon?.inactive)!;
    expect(n.icon.inactive!.sheet).not.toBe(n.icon.active!.sheet);
    expect(n.icon.inactive!.sheet).toMatch(/disabled/i);
  });

  it('resolves every connector sheet through the sprite table', () => {
    for (const c of geo.connectors) expect(geo.sprites[c.sheet]).toBeDefined();
  });

  it('ships each link once per allocation state, with its own vertices', () => {
    // PoB's BuildArc recomputes the quad per state because the art differs in
    // size, so the three entries are not interchangeable.
    const byLink = new Map<string, typeof geo.connectors>();
    for (const c of geo.connectors) {
      const k = `${c.from}_${c.to}`;
      const l = byLink.get(k);
      if (l) l.push(c);
      else byLink.set(k, [c]);
    }
    let differing = 0;
    for (const group of byLink.values()) {
      expect(new Set(group.map((c) => c.state)).size).toBeGreaterThan(1);
      const first = JSON.stringify(group[0].verts);
      if (group.some((c) => JSON.stringify(c.verts) !== first)) differing++;
    }
    expect(differing).toBeGreaterThan(0);
  });

  it('has connector UVs relative to the sprite sub-rect, some tiling past 1', () => {
    let max = 0;
    for (const c of geo.connectors) for (const u of c.uvs) max = Math.max(max, u.x, u.y);
    expect(max).toBeGreaterThan(1);
  });

  it('offers a chooser on masteries and never on anything else', () => {
    const masteries = geo.nodes.filter((n) => n.type === 'mastery');
    expect(masteries.some((n) => (n.masteryEffects?.length ?? 0) > 1)).toBe(true);
    for (const n of geo.nodes) {
      if (n.type !== 'mastery') expect(n.masteryEffects).toBeUndefined();
    }
  });

  it('gives allocated masteries an effect sprite to glow with', () => {
    const withEffect = geo.nodes.filter((n) => n.type === 'mastery' && n.effect);
    expect(withEffect.length).toBeGreaterThan(0);
  });

  it('sizes an ascendancy wheel so its own nodes land inside it', () => {
    // The regression: backdrops were drawn `frame.w` across instead of
    // `frame.w * 2 * 1.33`, i.e. at 3/8 size — so the wheel art ended up
    // *inside* its own ring of nodes rather than around it.
    const inside = (r: ReturnType<typeof drawAssetRect>, p: { x: number; y: number }) =>
      p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1;

    let checked = 0;
    let total = 0;
    let heldNow = 0;
    let heldBefore = 0;
    for (const g of geo.groups) {
      if (!g.isAscendancyStart || !g.ascendancy) continue;
      const s = geo.sprites[g.background];
      if (!s) continue;
      // Excluding the entry marker, which PoB parks outside the wheel.
      const own = geo.nodes.filter(
        (n) => n.ascendancy === g.ascendancy && n.type !== 'ascendClassStart',
      );
      if (own.length === 0) continue;

      const rect = drawAssetRect(g.x, g.y, s.w, s.h);
      // A handful of ascendancy notables live in their own far-flung group
      // (Raider's "Fury of Nature" is 1803 units out); PoB paints those outside
      // the wheel too. The wheel proper must be covered.
      const held = own.filter((n) => inside(rect, n)).length;
      expect(held / own.length).toBeGreaterThan(0.9);

      // Pin the old behaviour as wrong rather than merely unverified: at 3/8
      // size the backdrop held a minority of its own wheel.
      const undersized = { x0: g.x - s.w / 2, y0: g.y - s.h / 2, x1: g.x + s.w / 2, y1: g.y + s.h / 2 };
      total += own.length;
      heldNow += held;
      heldBefore += own.filter((n) => inside(undersized, n)).length;
      checked++;
    }
    expect(checked).toBeGreaterThan(20);
    expect(heldNow / total).toBeGreaterThan(0.98);
    expect(heldBefore / total).toBeLessThan(0.4);
  });

  it('draws every group backdrop at spriteTreeSize', () => {
    let checked = 0;
    for (const g of geo.groups) {
      const s = geo.sprites[g.background];
      if (!s) continue;
      const r = HALF_GROUP_BACKGROUNDS.has(g.background)
        ? drawAssetHalfRects(g.x, g.y, s.w, s.h)[0]
        : drawAssetRect(g.x, g.y, s.w, s.h);
      expect(r.x1 - r.x0).toBeCloseTo(spriteTreeSize(s.w), 6);
      checked++;
    }
    expect(checked).toBeGreaterThan(400);
  });

  it('anchors ascendancy flavour text inside its own wheel', () => {
    const wheels = geo.groups.filter((g) => g.isAscendancyStart && g.ascendancy);
    expect(wheels.length).toBeGreaterThan(20);
    const byId = new Map((geo.ascendancies ?? []).map((a) => [a.id, a]));
    let checked = 0;
    for (const g of wheels) {
      const asc = byId.get(g.ascendancy!);
      // Scion's wheels carry no flavour text, so there is no anchor to check.
      if (!asc?.flavourTextRect) continue;
      const sprite = geo.sprites[g.background];
      expect(sprite).toBeDefined();
      const art = drawAssetRect(g.x, g.y, sprite.w, sprite.h);
      const off = flavourTextOffset(asc.flavourTextRect, asc.alternate === true);
      const x = g.x + off.x;
      const y = g.y + off.y;
      expect(x).toBeGreaterThanOrEqual(art.x0);
      expect(x).toBeLessThanOrEqual(art.x1);
      expect(y).toBeGreaterThanOrEqual(art.y0);
      expect(y).toBeLessThanOrEqual(art.y1);
      checked++;
    }
    expect(checked).toBeGreaterThan(20);
  });
});

describe('PoB DrawAsset', () => {
  it('centres an asset with a half-extent of w * 1.33', () => {
    // PassiveTreeView.lua:1286-1292.
    expect(drawAssetRect(0, 0, 100, 40)).toEqual({
      x0: -133, y0: -53.2, x1: 133, y1: 53.2,
    });
  });

  it('draws the full box at spriteTreeSize, not the raw pixel width', () => {
    const r = drawAssetRect(10, -20, 499, 499);
    expect(r.x1 - r.x0).toBeCloseTo(spriteTreeSize(499), 6);
    // PoB's own comment: "Normal ascendancy images are 1300x1300".
    expect(r.x1 - r.x0).toBeCloseTo(1327.34, 2);
    expect((r.x0 + r.x1) / 2).toBeCloseTo(10, 9);
    expect((r.y0 + r.y1) / 2).toBeCloseTo(-20, 9);
  });

  it('stacks the half-art backdrop around y, top half first', () => {
    const [top, bottom] = drawAssetHalfRects(0, 0, 284, 144);
    const hh = 144 * ART_SCALE;
    expect(top).toEqual({ x0: -284 * ART_SCALE, y0: -hh * 2, x1: 284 * ART_SCALE, y1: 0 });
    expect(bottom).toEqual({ x0: -284 * ART_SCALE, y0: 0, x1: 284 * ART_SCALE, y1: hh * 2 });
    // The pair is contiguous and symmetric about the group origin.
    expect(top.y1).toBe(bottom.y0);
    expect(top.y0).toBe(-bottom.y1);
  });

  it('knows which backdrops are half art', () => {
    expect(HALF_GROUP_BACKGROUNDS.has('PSGroupBackground3')).toBe(true);
    expect(HALF_GROUP_BACKGROUNDS.has('GroupBackgroundLargeHalfAlt')).toBe(true);
    expect(HALF_GROUP_BACKGROUNDS.has('PSGroupBackground2')).toBe(false);
  });
});

describe('PoB ascendancy flavour text', () => {
  it('re-bases the rect off the art half-size', () => {
    // PassiveTreeView.lua:604-608. Juggernaut ships rect {215, 165}.
    expect(flavourTextOffset({ x: 215, y: 165 })).toEqual({ x: -435, y: -485 });
    expect(flavourTextOffset({ x: 500, y: 960 }, true)).toEqual({ x: -244, y: 254 });
  });

  it('halves each colour byte for an unselected ascendancy', () => {
    expect(dimFlavourColour('af5a32')).toBe('572D19');
    expect(dimFlavourColour('ffffff')).toBe('7F7F7F');
    expect(dimFlavourColour('000000')).toBe('000000');
  });

  it('keeps PoB’s zoom cutoff and base font size', () => {
    expect(FLAVOUR_TEXT_MIN_ZOOM).toBe(2.5);
    expect(FLAVOUR_TEXT_FONT_SIZE).toBe(52);
  });
});
