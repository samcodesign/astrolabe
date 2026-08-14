import { Container } from 'pixi.js';
import type { Shader } from 'pixi.js';
import { QuadBatch } from './QuadBatch';
import type { Atlas } from './atlas';
import {
  createNodeQuadShader,
  createRingShader,
  createStaticQuadShader,
  type SceneUniformGroup,
} from './shaders';
import type { RGBA } from '../theme';

const STATIC_ATTRS = [
  { name: 'aPosition', size: 2 },
  { name: 'aUV', size: 2 },
  { name: 'aColor', size: 4 },
  { name: 'aAnim', size: 2 },
  // Sub-rect for quads whose UVs tile past 1. z < 0 means "aUV is absolute".
  { name: 'aRect', size: 4 },
] as const;

const NODE_ATTRS = [
  { name: 'aPosition', size: 2 },
  { name: 'aOffset', size: 2 },
  { name: 'aUV', size: 2 },
  { name: 'aColor', size: 4 },
  { name: 'aAnim', size: 2 },
  { name: 'aScale', size: 1 },
] as const;

const RING_ATTRS = [
  { name: 'aPosition', size: 2 },
  { name: 'aLocal', size: 2 },
  { name: 'aParams', size: 4 },
  { name: 'aColor', size: 4 },
  { name: 'aPhase', size: 1 },
] as const;

export interface StaticQuadItem {
  sheet: string;
  /** Tree-space corners, clockwise from top-left. */
  verts: ArrayLike<number>; // 8 floats
  /** Normalised UVs matching the corners. */
  uvs: ArrayLike<number>; // 8 floats
  /**
   * Sub-rect (u0, v0, u1, v1) for quads whose UVs tile past 1, e.g. a long link
   * repeating a short line strip. Omit when `uvs` are absolute sheet
   * coordinates, which is the common case.
   */
  rect?: readonly [number, number, number, number];
}

interface Slot {
  batch: QuadBatch;
  quad: number;
}

/**
 * Quads whose corner positions are baked, one draw call per atlas sheet.
 *
 * This is the piece Canvas 2D cannot do: an orbit connector is a curved quad
 * with four independent texture coordinates, and the schema hands those over
 * verbatim. They go straight into the vertex buffer with no reinterpretation.
 */
export class StaticQuadLayer {
  readonly container = new Container();
  private readonly batches: QuadBatch[] = [];
  private readonly slotBatch: Int32Array;
  private readonly slotQuad: Int32Array;
  readonly count: number;

  private constructor(count: number) {
    this.count = count;
    this.slotBatch = new Int32Array(count);
    this.slotQuad = new Int32Array(count);
  }

  static build(
    items: readonly StaticQuadItem[],
    atlas: Atlas,
    scene: SceneUniformGroup,
    label = 'static',
  ): StaticQuadLayer {
    const layer = new StaticQuadLayer(items.length);
    const perSheet = new Map<string, number[]>();
    for (let i = 0; i < items.length; i++) {
      const list = perSheet.get(items[i].sheet);
      if (list) list.push(i);
      else perSheet.set(items[i].sheet, [i]);
    }

    let batchIndex = 0;
    for (const [sheet, indices] of [...perSheet.entries()].sort((a, b) =>
      a[0].localeCompare(b[0]),
    )) {
      const tex = atlas.texture(sheet);
      if (!tex) continue;
      const shader: Shader = createStaticQuadShader(tex, scene);
      const batch = new QuadBatch(indices.length, STATIC_ATTRS as never, shader);
      batch.mesh.label = `${label}:${sheet}`;

      const pos = batch.arrays.aPosition;
      const uv = batch.arrays.aUV;
      const col = batch.arrays.aColor;
      const rect = batch.arrays.aRect;
      for (let q = 0; q < indices.length; q++) {
        const item = items[indices[q]];
        const base = q * 8;
        for (let k = 0; k < 8; k++) {
          pos[base + k] = item.verts[k];
          uv[base + k] = item.uvs[k];
        }
        const cbase = q * 16;
        for (let k = 0; k < 16; k++) col[cbase + k] = 1;
        const r = item.rect ?? ([0, 0, -1, -1] as const);
        for (let v = 0; v < 4; v++) {
          const o = cbase + v * 4;
          rect[o] = r[0];
          rect[o + 1] = r[1];
          rect[o + 2] = r[2];
          rect[o + 3] = r[3];
        }
        layer.slotBatch[indices[q]] = batchIndex;
        layer.slotQuad[indices[q]] = q;
      }
      batch.setDrawnQuads(indices.length);
      batch.markAllDirty();
      layer.batches.push(batch);
      layer.container.addChild(batch.mesh);
      batchIndex++;
    }
    return layer;
  }

  private slot(i: number): Slot {
    return { batch: this.batches[this.slotBatch[i]], quad: this.slotQuad[i] };
  }

  setColour(i: number, c: RGBA, animMode = 0, phase = 0): void {
    const b = this.batches[this.slotBatch[i]];
    if (!b) return;
    const q = this.slotQuad[i];
    b.setQuad('aColor', q, [c.r, c.g, c.b, c.a]);
    b.setQuad('aAnim', q, [animMode, phase]);
  }

  /** Replace the four texture coordinates, e.g. swapping a state art variant. */
  setUVs(i: number, uvs: ArrayLike<number>): void {
    const b = this.batches[this.slotBatch[i]];
    if (!b) return;
    b.setQuadCorners('aUV', this.slotQuad[i], uvs);
  }

  /** Move a quad's four corners; used when cluster jewels reshape the tree. */
  setVerts(i: number, verts: ArrayLike<number>): void {
    const b = this.batches[this.slotBatch[i]];
    if (!b) return;
    b.setQuadCorners('aPosition', this.slotQuad[i], verts);
  }

  /**
   * Hide or show individual quads by rebuilding each batch's index list.
   *
   * The real tree ships every connector three times, once per allocation state,
   * so two thirds of them must be off at any moment. Dropping them from the
   * index list means they cost nothing at all, rather than shading transparent
   * fragments over the whole tree.
   */
  setVisibility(visible: (i: number) => boolean): void {
    const perBatch: number[][] = this.batches.map(() => []);
    for (let i = 0; i < this.count; i++) {
      const b = this.slotBatch[i];
      if (b < 0 || !visible(i)) continue;
      perBatch[b].push(this.slotQuad[i]);
    }
    for (let b = 0; b < this.batches.length; b++) this.batches[b].setIndices(perBatch[b]);
  }

  flush(): void {
    for (const b of this.batches) b.flush();
  }

  get drawCalls(): number {
    return this.batches.length;
  }

  get quads(): number {
    let n = 0;
    for (const b of this.batches) n += b.drawn;
    return n;
  }

  destroy(): void {
    for (const b of this.batches) b.destroy();
    this.batches.length = 0;
    this.container.destroy();
  }

  /** @internal test hook */
  _slot(i: number): Slot {
    return this.slot(i);
  }
}

export interface NodeQuadItem {
  sheet: string;
  cx: number;
  cy: number;
  /** Half extents in tree units. */
  hw: number;
  hh: number;
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

/** One node's art, keyed by the state that selects it. */
export interface NodeVariants {
  /** Index into the caller's node array. */
  node: number;
  variants: Record<string, NodeQuadItem>;
}

/**
 * Node art with per-state variants.
 *
 * A node's icon and frame both change with allocation state, and PoB puts the
 * inactive icon on an entirely *different sheet* (`skills-disabled-3.jpg`) —
 * it desaturates by swapping art, not by tinting. So a variant switch can move
 * a quad between draw batches, which a single-quad-per-node layer cannot do.
 *
 * Instead every variant gets its own permanent quad in its own sheet's batch,
 * and switching state sets the unwanted quads' scale to zero. A zero-area
 * triangle is discarded before rasterisation, so the hidden variants cost one
 * vertex shader invocation and no fragments.
 */
export class NodeArtLayer {
  readonly container = new Container();
  private readonly batches: QuadBatch[] = [];
  /** Flat quad table: parallel arrays indexed by an internal quad handle. */
  private readonly qBatch: number[] = [];
  private readonly qQuad: number[] = [];
  private readonly qKey: string[] = [];
  private readonly qNode: number[] = [];
  /** node index -> quad handles belonging to it. */
  private readonly byNode: number[][] = [];
  /** node index -> currently visible variant key. */
  private readonly active: string[] = [];
  /** node index -> base scale multiplier (hover pop). */
  private readonly baseScale: Float32Array;
  readonly count: number;

  private constructor(count: number) {
    this.count = count;
    this.baseScale = new Float32Array(count).fill(1);
    for (let i = 0; i < count; i++) this.byNode.push([]);
  }

  static build(
    nodeCount: number,
    items: readonly NodeVariants[],
    atlas: Atlas,
    scene: SceneUniformGroup,
    label = 'node-art',
  ): NodeArtLayer {
    const layer = new NodeArtLayer(nodeCount);

    // Bucket every (node, variant) pair by the sheet it samples.
    interface Pending {
      node: number;
      key: string;
      item: NodeQuadItem;
    }
    const perSheet = new Map<string, Pending[]>();
    for (const entry of items) {
      for (const [key, item] of Object.entries(entry.variants)) {
        const list = perSheet.get(item.sheet);
        const p: Pending = { node: entry.node, key, item };
        if (list) list.push(p);
        else perSheet.set(item.sheet, [p]);
      }
    }

    let batchIndex = 0;
    for (const [sheet, pending] of [...perSheet.entries()].sort((a, b) =>
      a[0].localeCompare(b[0]),
    )) {
      const tex = atlas.texture(sheet);
      if (!tex) continue;
      const batch = new QuadBatch(pending.length, NODE_ATTRS as never, createNodeQuadShader(tex, scene));
      batch.mesh.label = `${label}:${sheet}`;

      const pos = batch.arrays.aPosition;
      const off = batch.arrays.aOffset;
      const uv = batch.arrays.aUV;
      const col = batch.arrays.aColor;
      const scale = batch.arrays.aScale;

      for (let q = 0; q < pending.length; q++) {
        const { node, key, item } = pending[q];
        const p2 = q * 8;
        // clockwise from top-left
        pos[p2] = item.cx; pos[p2 + 1] = item.cy;
        pos[p2 + 2] = item.cx; pos[p2 + 3] = item.cy;
        pos[p2 + 4] = item.cx; pos[p2 + 5] = item.cy;
        pos[p2 + 6] = item.cx; pos[p2 + 7] = item.cy;

        off[p2] = -item.hw; off[p2 + 1] = -item.hh;
        off[p2 + 2] = item.hw; off[p2 + 3] = -item.hh;
        off[p2 + 4] = item.hw; off[p2 + 5] = item.hh;
        off[p2 + 6] = -item.hw; off[p2 + 7] = item.hh;

        uv[p2] = item.u0; uv[p2 + 1] = item.v0;
        uv[p2 + 2] = item.u1; uv[p2 + 3] = item.v0;
        uv[p2 + 4] = item.u1; uv[p2 + 5] = item.v1;
        uv[p2 + 6] = item.u0; uv[p2 + 7] = item.v1;

        const c4 = q * 16;
        for (let k = 0; k < 16; k++) col[c4 + k] = 1;
        const s = q * 4;
        scale[s] = scale[s + 1] = scale[s + 2] = scale[s + 3] = 0;

        const handle = layer.qBatch.length;
        layer.qBatch.push(batchIndex);
        layer.qQuad.push(q);
        layer.qKey.push(key);
        layer.qNode.push(node);
        layer.byNode[node].push(handle);
      }

      batch.setDrawnQuads(pending.length);
      batch.markAllDirty();
      layer.batches.push(batch);
      layer.container.addChild(batch.mesh);
      batchIndex++;
    }
    return layer;
  }

  has(node: number): boolean {
    return this.byNode[node]?.length > 0;
  }

  /** Which variants exist for this node. */
  variantsOf(node: number): string[] {
    return (this.byNode[node] ?? []).map((h) => this.qKey[h]);
  }

  /**
   * Show exactly one variant. Pass a key that does not exist (or null) to hide
   * the node's art entirely — that is how an optional effect overlay is turned
   * off without a separate layer.
   */
  setVariant(node: number, key: string | null): void {
    const handles = this.byNode[node];
    if (!handles) return;
    if (this.active[node] === key) return;
    this.active[node] = key ?? '';
    const base = this.baseScale[node];
    for (const h of handles) {
      const s = this.qKey[h] === key ? base : 0;
      this.batches[this.qBatch[h]].setQuad('aScale', this.qQuad[h], [s]);
    }
  }

  activeVariant(node: number): string | null {
    return this.active[node] || null;
  }

  setColour(node: number, c: RGBA, animMode = 0, phase = 0): void {
    const handles = this.byNode[node];
    if (!handles) return;
    for (const h of handles) {
      const b = this.batches[this.qBatch[h]];
      b.setQuad('aColor', this.qQuad[h], [c.r, c.g, c.b, c.a]);
      b.setQuad('aAnim', this.qQuad[h], [animMode, phase]);
    }
  }

  /** Hover/selection pop. Only the visible variant is resized. */
  setScale(node: number, s: number): void {
    const handles = this.byNode[node];
    if (!handles) return;
    this.baseScale[node] = s;
    const key = this.active[node];
    for (const h of handles) {
      const v = this.qKey[h] === key ? s : 0;
      this.batches[this.qBatch[h]].setQuad('aScale', this.qQuad[h], [v]);
    }
  }

  setCentre(node: number, x: number, y: number): void {
    const handles = this.byNode[node];
    if (!handles) return;
    for (const h of handles) {
      this.batches[this.qBatch[h]].setQuad('aPosition', this.qQuad[h], [x, y]);
    }
  }

  flush(): void {
    for (const b of this.batches) b.flush();
  }

  get drawCalls(): number {
    return this.batches.length;
  }

  /** Quads actually visible, i.e. one per node with a selected variant. */
  get visibleNodes(): number {
    let n = 0;
    for (let i = 0; i < this.count; i++) if (this.active[i]) n++;
    return n;
  }

  get quads(): number {
    let n = 0;
    for (const b of this.batches) n += b.drawn;
    return n;
  }

  destroy(): void {
    for (const b of this.batches) b.destroy();
    this.batches.length = 0;
    this.container.destroy();
  }
}

export const RING_SOLID = 0;
export const RING_DASHED = 1;
export const RING_GLOW = 2;
export const RING_DISC = 3;

/**
 * Decoration rings drawn as analytic signed-distance fields.
 *
 * Everything transient goes here: hover, selection, search results, compare
 * markers, "not yet evaluated" dashes, jewel radii. Because the shape is
 * evaluated per pixel rather than sampled from a bitmap, a 1500-unit jewel
 * radius circle is exactly as crisp as a 30-unit hover ring.
 */
export class RingLayer {
  readonly container = new Container();
  private batch: QuadBatch;
  private readonly scene: SceneUniformGroup;
  private cursor = 0;
  private capacity: number;

  constructor(scene: SceneUniformGroup, capacity = 2048) {
    this.scene = scene;
    this.capacity = capacity;
    this.batch = this.makeBatch(capacity);
    this.container.addChild(this.batch.mesh);
  }

  private makeBatch(capacity: number): QuadBatch {
    const batch = new QuadBatch(capacity, RING_ATTRS as never, createRingShader(this.scene));
    batch.mesh.label = 'rings';
    const local = batch.arrays.aLocal;
    for (let q = 0; q < capacity; q++) {
      const o = q * 8;
      local[o] = -1; local[o + 1] = -1;
      local[o + 2] = 1; local[o + 3] = -1;
      local[o + 4] = 1; local[o + 5] = 1;
      local[o + 6] = -1; local[o + 7] = 1;
    }
    batch.markAllDirty();
    return batch;
  }

  begin(): void {
    this.cursor = 0;
  }

  /**
   * Queue one ring. `radius` and `thickness` are tree units; the quad is
   * padded so the antialiased edge and glow falloff are never clipped.
   */
  add(
    x: number,
    y: number,
    radius: number,
    thickness: number,
    style: number,
    colour: RGBA,
    phase = 0,
  ): void {
    if (this.cursor >= this.capacity) this.grow();
    const q = this.cursor++;
    const b = this.batch;
    const extent = style === RING_GLOW ? radius : radius + thickness * 0.5 + Math.max(2, radius * 0.06);
    b.setQuad('aPosition', q, [x, y]);
    b.setQuad('aParams', q, [extent, radius, thickness, style]);
    b.setQuad('aColor', q, [colour.r, colour.g, colour.b, colour.a]);
    b.setQuad('aPhase', q, [phase]);
  }

  private grow(): void {
    const next = this.capacity * 2;
    const old = this.batch;
    const batch = this.makeBatch(next);
    // Carry over what has already been queued this frame.
    for (const name of ['aPosition', 'aParams', 'aColor', 'aPhase']) {
      batch.arrays[name].set(old.arrays[name].subarray(0, this.cursor * 4 * batch.stride(name)));
    }
    batch.markAllDirty();
    this.container.removeChildren();
    old.destroy();
    this.batch = batch;
    this.capacity = next;
    this.container.addChild(batch.mesh);
  }

  end(): void {
    this.batch.setDrawnQuads(this.cursor);
    this.batch.flush();
  }

  get drawn(): number {
    return this.cursor;
  }

  destroy(): void {
    this.batch.destroy();
    this.container.destroy();
  }
}
