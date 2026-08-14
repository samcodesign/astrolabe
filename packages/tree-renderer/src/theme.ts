import type { AllocState } from './types';

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

export function rgba(hex: number, a = 1): RGBA {
  return {
    r: ((hex >> 16) & 0xff) / 255,
    g: ((hex >> 8) & 0xff) / 255,
    b: (hex & 0xff) / 255,
    a,
  };
}

export function mixRGBA(a: RGBA, b: RGBA, t: number): RGBA {
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
    a: a.a + (b.a - a.a) * t,
  };
}

export function scaleRGB(c: RGBA, k: number, alpha = c.a): RGBA {
  return { r: c.r * k, g: c.g * k, b: c.b * k, a: alpha };
}

export function toCss(c: RGBA): string {
  const to = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
  return `rgba(${to(c.r)}, ${to(c.g)}, ${to(c.b)}, ${c.a.toFixed(3)})`;
}

/**
 * Value ramp for the heatmap: an inferno-style sequence from near-black through
 * purple and red to bright yellow.
 *
 * Lightness increases monotonically along the ramp, so the map survives
 * greyscale and the ~8% of players with a red/green deficiency — which the
 * usual red-to-green "good/bad" gradient does not. It also means low-value
 * nodes recede into a dark background on their own, without extra dimming.
 */
const HEAT: Array<[number, RGBA]> = [
  [0.0, rgba(0x1b1f33)],
  [0.14, rgba(0x33265f)],
  [0.29, rgba(0x632a6d)],
  [0.44, rgba(0x933563)],
  [0.58, rgba(0xbd4a4c)],
  [0.72, rgba(0xd96f34)],
  [0.86, rgba(0xeda32c)],
  [1.0, rgba(0xf8e05c)],
];

export function heatColour(t: number): RGBA {
  const x = Math.max(0, Math.min(1, t));
  for (let i = 1; i < HEAT.length; i++) {
    if (x <= HEAT[i][0]) {
      const [t0, c0] = HEAT[i - 1];
      const [t1, c1] = HEAT[i];
      const k = t1 === t0 ? 0 : (x - t0) / (t1 - t0);
      return mixRGBA(c0, c1, k);
    }
  }
  return HEAT[HEAT.length - 1][1];
}

/** CSS gradient string for legends, sampled from the same ramp. */
export function heatGradientCss(steps = 12): string {
  const parts: string[] = [];
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    parts.push(`${toCss(heatColour(t))} ${(t * 100).toFixed(1)}%`);
  }
  return `linear-gradient(90deg, ${parts.join(', ')})`;
}

export interface Theme {
  background: number;
  /** Node body tint by allocation state. */
  node: Record<AllocState, RGBA>;
  /** Connector tint by allocation state, used when per-state art is absent. */
  connector: Record<AllocState, RGBA>;
  groupBackground: RGBA;
  /** Multiplied into anything dimmed by a search or compare filter. */
  dimFactor: number;
  hoverRing: RGBA;
  hoverGlow: RGBA;
  selectRing: RGBA;
  searchRing: RGBA;
  searchGlow: RGBA;
  compareAdded: RGBA;
  compareRemoved: RGBA;
  /** Nodes the engine has not scored yet, during a progressive power pass. */
  powerPending: RGBA;
  /**
   * Allocated nodes while the heatmap is up. Deliberately cool: the hot end of
   * the ramp is a warm yellow, and the normal allocated gold is close enough to
   * it to be misread as "extremely valuable".
   */
  powerAllocated: RGBA;
  jewelRing: RGBA;
  pathPreview: RGBA;
}

export const DARK_THEME: Theme = {
  background: 0x0a0d14,
  // PoB draws every node and link at `SetDrawColor(1,1,1)` and lets the art
  // carry allocation state — the icon comes from the desaturated atlas when
  // unallocated, and the frame is a different sprite per state. Tinting on top
  // of that only muddies it, so the default is white and colour is reserved for
  // the heatmap, compare and search overlays.
  node: {
    unallocated: rgba(0xffffff, 1),
    path: rgba(0xffffff, 1),
    allocated: rgba(0xffffff, 1),
  },
  connector: {
    unallocated: rgba(0xffffff, 1),
    path: rgba(0xffffff, 1),
    allocated: rgba(0xffffff, 1),
  },
  groupBackground: rgba(0xffffff, 1),
  dimFactor: 0.17,
  hoverRing: rgba(0xffffff, 0.9),
  hoverGlow: rgba(0x9ad8ff, 0.32),
  selectRing: rgba(0xffd98a, 0.95),
  searchRing: rgba(0xc08cff, 1),
  searchGlow: rgba(0xc08cff, 0.28),
  compareAdded: rgba(0x4ede8f, 1),
  compareRemoved: rgba(0xff6b74, 1),
  powerPending: rgba(0x4d566b, 0.6),
  powerAllocated: rgba(0xdce8fb, 1),
  jewelRing: rgba(0x8fe3ff, 0.55),
  pathPreview: rgba(0x7fc4ff, 1),
};
