export interface GridItem {
  x: number;
  y: number;
  radius: number;
}

export interface GridStats {
  cells: number;
  cellSize: number;
  items: number;
  maxBucket: number;
  meanBucket: number;
}

/**
 * Uniform spatial hash over tree-space.
 *
 * Path of Building hit-tests by linear scan over every node on every frame
 * (PassiveTreeView.lua:297-307) — ~2.2k distance checks per mouse move. This
 * replaces that with an O(1) bucket lookup: a query touches at most the cells
 * overlapping the search disc, which at the default cell size is 4-9 buckets of
 * a handful of nodes each.
 *
 * The structure is flat typed arrays (CSR-style: `starts` + `items`) so there
 * is no per-cell array allocation and lookups stay cache-friendly.
 */
export class SpatialGrid<T extends GridItem = GridItem> {
  readonly cellSize: number;
  readonly minX: number;
  readonly minY: number;
  readonly cols: number;
  readonly rows: number;

  private readonly starts: Int32Array;
  private readonly items: Int32Array;
  private readonly data: readonly T[];
  /** Largest item radius, so queries know how far to widen the cell search. */
  readonly maxRadius: number;

  constructor(data: readonly T[], cellSize?: number) {
    this.data = data;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxRadius = 0;
    for (let i = 0; i < data.length; i++) {
      const it = data[i];
      if (it.x < minX) minX = it.x;
      if (it.y < minY) minY = it.y;
      if (it.x > maxX) maxX = it.x;
      if (it.y > maxY) maxY = it.y;
      if (it.radius > maxRadius) maxRadius = it.radius;
    }
    if (!data.length) {
      minX = minY = 0;
      maxX = maxY = 1;
      maxRadius = 1;
    }
    this.maxRadius = maxRadius;

    // Aim for ~2-4 items per cell. Never smaller than the biggest item, or a
    // query would have to widen by more cells than it saves.
    const span = Math.max(maxX - minX, maxY - minY, 1);
    const target = data.length > 0 ? span / Math.sqrt(data.length / 2) : span;
    this.cellSize = Math.max(cellSize ?? target, maxRadius * 2, 1);

    this.minX = minX - this.cellSize;
    this.minY = minY - this.cellSize;
    this.cols = Math.max(1, Math.ceil((maxX - this.minX) / this.cellSize) + 1);
    this.rows = Math.max(1, Math.ceil((maxY - this.minY) / this.cellSize) + 1);

    const cellCount = this.cols * this.rows;
    const counts = new Int32Array(cellCount + 1);
    const cellOf = new Int32Array(data.length);

    for (let i = 0; i < data.length; i++) {
      const c = this.cellIndex(data[i].x, data[i].y);
      cellOf[i] = c;
      counts[c + 1]++;
    }
    for (let c = 0; c < cellCount; c++) counts[c + 1] += counts[c];

    const cursor = counts.slice(0, cellCount);
    const items = new Int32Array(data.length);
    for (let i = 0; i < data.length; i++) {
      items[cursor[cellOf[i]]++] = i;
    }

    this.starts = counts;
    this.items = items;
  }

  private cellIndex(x: number, y: number): number {
    const cx = Math.min(this.cols - 1, Math.max(0, Math.floor((x - this.minX) / this.cellSize)));
    const cy = Math.min(this.rows - 1, Math.max(0, Math.floor((y - this.minY) / this.cellSize)));
    return cy * this.cols + cx;
  }

  private colOf(x: number): number {
    return Math.min(this.cols - 1, Math.max(0, Math.floor((x - this.minX) / this.cellSize)));
  }

  private rowOf(y: number): number {
    return Math.min(this.rows - 1, Math.max(0, Math.floor((y - this.minY) / this.cellSize)));
  }

  /**
   * Nearest item containing the point, within `item.radius + tolerance`.
   * Returns the index into the source array, or -1.
   *
   * `tolerance` is in tree units. `minRadius` raises every item's grab radius
   * to a floor, which is how a constant *screen* grab size is maintained as
   * the user zooms out and the art shrinks below a clickable size.
   */
  pick(x: number, y: number, tolerance = 0, minRadius = 0): number {
    const reach = Math.max(this.maxRadius, minRadius) + Math.max(0, tolerance);
    const c0 = this.colOf(x - reach);
    const c1 = this.colOf(x + reach);
    const r0 = this.rowOf(y - reach);
    const r1 = this.rowOf(y + reach);

    let best = -1;
    let bestScore = Infinity;
    for (let ry = r0; ry <= r1; ry++) {
      const rowBase = ry * this.cols;
      for (let cx = c0; cx <= c1; cx++) {
        const cell = rowBase + cx;
        const end = this.starts[cell + 1];
        for (let k = this.starts[cell]; k < end; k++) {
          const idx = this.items[k];
          const it = this.data[idx];
          const dx = it.x - x;
          const dy = it.y - y;
          const d2 = dx * dx + dy * dy;
          const r = Math.max(it.radius, minRadius) + tolerance;
          if (d2 > r * r) continue;
          // Prefer the item whose centre is closest *relative to its size*, so
          // a small node sitting on top of a big one still wins.
          const score = d2 / (r * r);
          if (score < bestScore) {
            bestScore = score;
            best = idx;
          }
        }
      }
    }
    return best;
  }

  /** Indices of items whose centre falls in the AABB, appended to `out`. */
  queryRect(
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
    out: number[] = [],
  ): number[] {
    const c0 = this.colOf(minX - this.maxRadius);
    const c1 = this.colOf(maxX + this.maxRadius);
    const r0 = this.rowOf(minY - this.maxRadius);
    const r1 = this.rowOf(maxY + this.maxRadius);
    for (let ry = r0; ry <= r1; ry++) {
      const rowBase = ry * this.cols;
      for (let cx = c0; cx <= c1; cx++) {
        const cell = rowBase + cx;
        const end = this.starts[cell + 1];
        for (let k = this.starts[cell]; k < end; k++) {
          const idx = this.items[k];
          const it = this.data[idx];
          if (it.x >= minX && it.x <= maxX && it.y >= minY && it.y <= maxY) out.push(idx);
        }
      }
    }
    return out;
  }

  /** Indices of every item within `radius` of a point, appended to `out`. */
  queryCircle(x: number, y: number, radius: number, out: number[] = []): number[] {
    const c0 = this.colOf(x - radius);
    const c1 = this.colOf(x + radius);
    const r0 = this.rowOf(y - radius);
    const r1 = this.rowOf(y + radius);
    const r2 = radius * radius;
    for (let ry = r0; ry <= r1; ry++) {
      const rowBase = ry * this.cols;
      for (let cx = c0; cx <= c1; cx++) {
        const cell = rowBase + cx;
        const end = this.starts[cell + 1];
        for (let k = this.starts[cell]; k < end; k++) {
          const idx = this.items[k];
          const it = this.data[idx];
          const dx = it.x - x;
          const dy = it.y - y;
          if (dx * dx + dy * dy <= r2) out.push(idx);
        }
      }
    }
    return out;
  }

  stats(): GridStats {
    const cells = this.cols * this.rows;
    let max = 0;
    let used = 0;
    for (let c = 0; c < cells; c++) {
      const n = this.starts[c + 1] - this.starts[c];
      if (n > max) max = n;
      if (n > 0) used++;
    }
    return {
      cells,
      cellSize: this.cellSize,
      items: this.data.length,
      maxBucket: max,
      meanBucket: used ? this.data.length / used : 0,
    };
  }
}
