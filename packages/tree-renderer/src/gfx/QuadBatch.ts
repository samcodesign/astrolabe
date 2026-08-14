import { Buffer, BufferUsage, Geometry, Mesh } from 'pixi.js';
import type { Shader, TextureShader } from 'pixi.js';

export interface AttributeSpec {
  name: string;
  /** Components per vertex. */
  size: 1 | 2 | 3 | 4;
}

const FORMATS = ['', 'float32', 'float32x2', 'float32x3', 'float32x4'] as const;

/**
 * A fixed-capacity pool of textured quads sharing one draw call.
 *
 * Attributes live in separate (non-interleaved) buffers so a colour change
 * re-uploads ~48 KB instead of the whole 600 KB vertex block. Each attribute
 * tracks its own dirty high-water mark and uploads only the used prefix.
 *
 * The index buffer is written last and can be shortened via
 * `setDrawnQuads`, which is how per-quad frustum culling works: the vertex
 * data never moves, only the index list shrinks.
 */
export class QuadBatch {
  readonly capacity: number;
  readonly geometry: Geometry;
  readonly mesh: Mesh<Geometry, TextureShader>;

  readonly arrays: Record<string, Float32Array> = {};
  private readonly buffers: Record<string, Buffer> = {};
  private readonly sizes: Record<string, number> = {};
  private readonly dirty: Record<string, number> = {};

  private readonly indexArray: Uint32Array;
  private readonly indexBuffer: Buffer;
  private drawnQuads = 0;
  private indexDirty = true;

  constructor(capacity: number, attributes: AttributeSpec[], shader: Shader) {
    this.capacity = capacity;
    const vertexCount = capacity * 4;

    const attrs: Record<string, { buffer: Buffer; format: string }> = {};
    for (const spec of attributes) {
      const arr = new Float32Array(vertexCount * spec.size);
      const buf = new Buffer({ data: arr, usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
      this.arrays[spec.name] = arr;
      this.buffers[spec.name] = buf;
      this.sizes[spec.name] = spec.size;
      this.dirty[spec.name] = 0;
      attrs[spec.name] = { buffer: buf, format: FORMATS[spec.size] };
    }

    this.indexArray = new Uint32Array(capacity * 6);
    this.indexBuffer = new Buffer({
      data: this.indexArray,
      usage: BufferUsage.INDEX | BufferUsage.COPY_DST,
    });

    this.geometry = new Geometry({
      attributes: attrs as never,
      indexBuffer: this.indexBuffer,
      topology: 'triangle-list',
    });

    // The custom shaders are procedural/atlas-sampling; Pixi's Mesh type wants
    // a TextureShader, but the mesh pipe only ever reads glProgram/gpuProgram.
    this.mesh = new Mesh({ geometry: this.geometry, shader: shader as unknown as TextureShader });
    // Bounds are computed from tree-space positions once; the container's own
    // transform handles pan/zoom, so Pixi never needs to recompute them.
    this.mesh.cullable = false;
  }

  /** Component count per vertex for an attribute. */
  stride(name: string): number {
    return this.sizes[name];
  }

  /** Index of the first float of quad `q`, vertex `v`, for attribute `name`. */
  at(name: string, quad: number, vertex = 0): number {
    return (quad * 4 + vertex) * this.sizes[name];
  }

  /** Write the same tuple to all four vertices of a quad. */
  setQuad(name: string, quad: number, values: ArrayLike<number>): void {
    const s = this.sizes[name];
    const arr = this.arrays[name];
    let o = quad * 4 * s;
    for (let v = 0; v < 4; v++) {
      for (let c = 0; c < s; c++) arr[o + c] = values[c];
      o += s;
    }
    this.markDirty(name, quad);
  }

  /** Write four distinct tuples (one per corner), e.g. positions and UVs. */
  setQuadCorners(name: string, quad: number, values: ArrayLike<number>): void {
    const s = this.sizes[name];
    const arr = this.arrays[name];
    const base = quad * 4 * s;
    for (let i = 0; i < 4 * s; i++) arr[base + i] = values[i];
    this.markDirty(name, quad);
  }

  markDirty(name: string, quad: number): void {
    const end = (quad + 1) * 4 * this.sizes[name];
    if (end > this.dirty[name]) this.dirty[name] = end;
  }

  markAllDirty(): void {
    for (const name of Object.keys(this.arrays)) {
      this.dirty[name] = this.arrays[name].length;
    }
    this.indexDirty = true;
  }

  /**
   * Fill the index list with the given quad ids, in order. Draw order inside a
   * batch is therefore controllable without touching vertex data.
   *
   * Pixi's mesh pipe does not pass a draw `size`, so the GPU always consumes
   * the whole index buffer. Unused slots are collapsed to a repeated vertex,
   * which the rasteriser drops as a zero-area triangle.
   */
  setIndices(quads: ArrayLike<number>, count = quads.length): void {
    const idx = this.indexArray;
    const n = Math.min(count, this.capacity);
    let o = 0;
    for (let i = 0; i < n; i++) {
      const base = quads[i] * 4;
      idx[o++] = base;
      idx[o++] = base + 1;
      idx[o++] = base + 2;
      idx[o++] = base;
      idx[o++] = base + 2;
      idx[o++] = base + 3;
    }
    if (this.drawnQuads > n) idx.fill(0, o, this.drawnQuads * 6);
    this.drawnQuads = n;
    this.indexDirty = true;
  }

  /** Draw quads `[0, count)` in their natural order. */
  setDrawnQuads(count: number): void {
    const n = Math.min(count, this.capacity);
    if (n === this.drawnQuads && !this.indexDirty) return;
    const idx = this.indexArray;
    let o = 0;
    for (let q = 0; q < n; q++) {
      const base = q * 4;
      idx[o++] = base;
      idx[o++] = base + 1;
      idx[o++] = base + 2;
      idx[o++] = base;
      idx[o++] = base + 2;
      idx[o++] = base + 3;
    }
    if (this.drawnQuads > n) idx.fill(0, o, this.drawnQuads * 6);
    this.drawnQuads = n;
    this.indexDirty = true;
  }

  get drawn(): number {
    return this.drawnQuads;
  }

  /** Push every dirty range to the GPU. Cheap when nothing changed. */
  flush(): void {
    for (const name of Object.keys(this.arrays)) {
      const n = this.dirty[name];
      if (n > 0) {
        this.buffers[name].update(n * Float32Array.BYTES_PER_ELEMENT);
        this.dirty[name] = 0;
      }
    }
    if (this.indexDirty) {
      this.indexBuffer.update(this.indexArray.byteLength);
      this.indexDirty = false;
      this.mesh.visible = this.drawnQuads > 0;
    }
  }

  destroy(): void {
    this.mesh.destroy();
    this.geometry.destroy(true);
  }
}
