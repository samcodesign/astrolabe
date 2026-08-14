import type { Point } from '../types';

export const ZOOM_BASE = 1.2;
export const MIN_ZOOM_LEVEL = -4;
export const MAX_ZOOM_LEVEL = 14;

/** Discrete zoom factor for a level, per PoB: `zoom = 1.2 ^ level`. */
export function zoomForLevel(level: number): number {
  return Math.pow(ZOOM_BASE, level);
}

/** Inverse of {@link zoomForLevel}; not rounded, so callers choose the rounding. */
export function levelForZoom(zoom: number): number {
  return Math.log(zoom) / Math.log(ZOOM_BASE);
}

export function clampLevel(level: number): number {
  return Math.max(MIN_ZOOM_LEVEL, Math.min(MAX_ZOOM_LEVEL, level));
}

/**
 * Base scale before zoom: the tree's bounding box is fitted to the smaller
 * viewport axis. `scale = min(vw, vh) / size * zoom`.
 */
export function scaleFor(vw: number, vh: number, treeSize: number, zoom: number): number {
  if (treeSize <= 0) return 0;
  return (Math.min(vw, vh) / treeSize) * zoom;
}

/**
 * Pan limit per axis: `±viewport * zoom * 2/3`.
 * Returned as positive magnitudes.
 */
export function panLimit(vw: number, vh: number, zoom: number): Point {
  return { x: (vw * zoom * 2) / 3, y: (vh * zoom * 2) / 3 };
}

export function clampPan(offset: Point, vw: number, vh: number, zoom: number): Point {
  const lim = panLimit(vw, vh, zoom);
  return {
    x: Math.max(-lim.x, Math.min(lim.x, offset.x)),
    y: Math.max(-lim.y, Math.min(lim.y, offset.y)),
  };
}

export interface ViewportSnapshot {
  level: number;
  zoom: number;
  scale: number;
  x: number;
  y: number;
  vw: number;
  vh: number;
}

/**
 * Screen <-> tree-space transform.
 *
 * Tree coordinates arrive already cartesian and centred on the origin. Screen
 * space is CSS pixels with the origin at the canvas top-left.
 *
 * The *target* zoom is always a discrete `1.2^level` as the contract requires;
 * `renderZoom` is an eased value used for drawing so the motion does not snap.
 * All hit-testing and reported viewport state use `renderZoom` so what you
 * click is what you see mid-animation.
 */
export class Viewport {
  vw = 1;
  vh = 1;
  treeSize = 1;

  /** Discrete target level. */
  level = 0;
  /** Eased zoom actually used for rendering; converges on `zoomForLevel(level)`. */
  renderZoom = 1;

  /** Pan offset in screen px from the viewport centre. */
  x = 0;
  y = 0;
  /** Eased pan target. */
  targetX = 0;
  targetY = 0;

  /** Set false to disable easing (tests, reduced motion). */
  smooth = true;

  constructor(treeSize = 1) {
    this.treeSize = treeSize;
  }

  get targetZoom(): number {
    return zoomForLevel(this.level);
  }

  get zoom(): number {
    return this.renderZoom;
  }

  get scale(): number {
    return scaleFor(this.vw, this.vh, this.treeSize, this.renderZoom);
  }

  resize(vw: number, vh: number): void {
    this.vw = Math.max(1, vw);
    this.vh = Math.max(1, vh);
    this.applyPanClamp();
  }

  treeToScreen(p: Point, out: Point = { x: 0, y: 0 }): Point {
    const s = this.scale;
    out.x = this.vw / 2 + this.x + p.x * s;
    out.y = this.vh / 2 + this.y + p.y * s;
    return out;
  }

  screenToTree(p: Point, out: Point = { x: 0, y: 0 }): Point {
    const s = this.scale;
    if (s === 0) {
      out.x = 0;
      out.y = 0;
      return out;
    }
    out.x = (p.x - this.vw / 2 - this.x) / s;
    out.y = (p.y - this.vh / 2 - this.y) / s;
    return out;
  }

  /** Tree-space units covered by one screen pixel; drives LOD decisions. */
  get unitsPerPixel(): number {
    const s = this.scale;
    return s === 0 ? Infinity : 1 / s;
  }

  panBy(dx: number, dy: number): void {
    this.targetX += dx;
    this.targetY += dy;
    // Dragging is direct: no easing lag between cursor and content.
    this.x += dx;
    this.y += dy;
    this.applyPanClamp();
  }

  panTo(x: number, y: number, immediate = false): void {
    this.targetX = x;
    this.targetY = y;
    if (immediate || !this.smooth) {
      this.x = x;
      this.y = y;
    }
    this.applyPanClamp();
  }

  /**
   * Change zoom by whole levels, keeping the tree point currently under
   * `anchor` (screen px) pinned there.
   */
  zoomByLevels(delta: number, anchor?: Point): void {
    const next = clampLevel(this.level + delta);
    if (next === this.level) return;
    this.setLevel(next, anchor);
  }

  setLevel(level: number, anchor?: Point, immediate = false): void {
    const clamped = clampLevel(level);
    const a = anchor ?? { x: this.vw / 2, y: this.vh / 2 };
    // Anchor against the *target* transform so repeated wheel ticks compose
    // correctly instead of chasing the eased value.
    const before = this.pointAt(a, this.targetZoom, this.targetX, this.targetY);
    this.level = clamped;
    const s2 = scaleFor(this.vw, this.vh, this.treeSize, this.targetZoom);
    this.targetX = a.x - this.vw / 2 - before.x * s2;
    this.targetY = a.y - this.vh / 2 - before.y * s2;
    if (immediate || !this.smooth) {
      this.renderZoom = this.targetZoom;
      this.x = this.targetX;
      this.y = this.targetY;
    }
    this.applyPanClamp();
  }

  private pointAt(screen: Point, zoom: number, ox: number, oy: number): Point {
    const s = scaleFor(this.vw, this.vh, this.treeSize, zoom);
    if (s === 0) return { x: 0, y: 0 };
    return { x: (screen.x - this.vw / 2 - ox) / s, y: (screen.y - this.vh / 2 - oy) / s };
  }

  /** Centre a tree-space point, optionally at a specific zoom level. */
  centreOn(p: Point, level = this.level, immediate = false): void {
    this.level = clampLevel(level);
    const s = scaleFor(this.vw, this.vh, this.treeSize, this.targetZoom);
    this.targetX = -p.x * s;
    this.targetY = -p.y * s;
    if (immediate || !this.smooth) {
      this.renderZoom = this.targetZoom;
      this.x = this.targetX;
      this.y = this.targetY;
    }
    this.applyPanClamp();
  }

  reset(immediate = false): void {
    this.level = 0;
    this.targetX = 0;
    this.targetY = 0;
    if (immediate || !this.smooth) {
      this.renderZoom = 1;
      this.x = 0;
      this.y = 0;
    }
  }

  /**
   * Advance the easing. `dt` in seconds. Returns true while still moving, so
   * the caller can skip redraws once everything has settled.
   */
  tick(dt: number): boolean {
    if (!this.smooth) {
      this.renderZoom = this.targetZoom;
      this.x = this.targetX;
      this.y = this.targetY;
      this.applyPanClamp();
      return false;
    }
    // Frame-rate independent exponential approach. tau chosen so a wheel tick
    // reads as instant but not jarring (~90 ms to 95%).
    const kZoom = 1 - Math.exp(-dt / 0.045);
    const kPan = 1 - Math.exp(-dt / 0.055);

    const tz = this.targetZoom;
    let moving = false;

    // Interpolate in log space: constant perceived speed across zoom levels.
    const lz = Math.log(this.renderZoom);
    const lt = Math.log(tz);
    if (Math.abs(lt - lz) > 1e-4) {
      this.renderZoom = Math.exp(lz + (lt - lz) * kZoom);
      moving = true;
    } else {
      this.renderZoom = tz;
    }

    if (Math.abs(this.targetX - this.x) > 0.05 || Math.abs(this.targetY - this.y) > 0.05) {
      this.x += (this.targetX - this.x) * kPan;
      this.y += (this.targetY - this.y) * kPan;
      moving = true;
    } else {
      this.x = this.targetX;
      this.y = this.targetY;
    }

    this.applyPanClamp();
    return moving;
  }

  applyPanClamp(): void {
    const t = clampPan({ x: this.targetX, y: this.targetY }, this.vw, this.vh, this.targetZoom);
    this.targetX = t.x;
    this.targetY = t.y;
    const c = clampPan({ x: this.x, y: this.y }, this.vw, this.vh, this.renderZoom);
    this.x = c.x;
    this.y = c.y;
  }

  /** Tree-space AABB currently visible, padded by `pad` tree units. */
  visibleBounds(pad = 0): { minX: number; minY: number; maxX: number; maxY: number } {
    const tl = this.screenToTree({ x: 0, y: 0 });
    const br = this.screenToTree({ x: this.vw, y: this.vh });
    return {
      minX: Math.min(tl.x, br.x) - pad,
      minY: Math.min(tl.y, br.y) - pad,
      maxX: Math.max(tl.x, br.x) + pad,
      maxY: Math.max(tl.y, br.y) + pad,
    };
  }

  snapshot(): ViewportSnapshot {
    return {
      level: this.level,
      zoom: this.renderZoom,
      scale: this.scale,
      x: this.x,
      y: this.y,
      vw: this.vw,
      vh: this.vh,
    };
  }
}
