import { Assets, Texture, TextureSource } from 'pixi.js';
import type { SpriteRef, TreeGeometry } from '../types';

export type SheetSource = string | HTMLCanvasElement | ImageBitmap | HTMLImageElement | TextureSource;

export interface SpriteFrame {
  /** Sheet name, matching a key of `geometry.sheets`. */
  sheet: string;
  /** Normalised texture coordinates. */
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  /** Pixel size of the sub-rect, used to derive an aspect-correct quad. */
  w: number;
  h: number;
}

export interface AtlasOptions {
  /** Prefix for `geometry.sheets` paths, e.g. the vendored PoB `src` dir. */
  baseUrl?: string;
  /**
   * Pre-supplied sources keyed by sheet name. Anything present here wins over
   * the path in `geometry.sheets`; the demo uses it to hand over canvases it
   * painted itself so no binary assets are needed.
   */
  sheetSources?: Record<string, SheetSource>;
  /** Called for sheets that fail to load; defaults to a 1x1 magenta texture. */
  onSheetError?: (sheet: string, err: unknown) => void;
}

function joinUrl(base: string | undefined, path: string): string {
  if (!base) return path;
  if (/^([a-z]+:)?\/\//i.test(path) || path.startsWith('data:')) return path;
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

let missingTexture: Texture | null = null;
function getMissingTexture(): Texture {
  if (missingTexture) return missingTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 4;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#ff00ff';
  ctx.fillRect(0, 0, 4, 4);
  missingTexture = Texture.from(c);
  return missingTexture;
}

/**
 * Turns `geometry.sheets` plus sprite rects into GPU textures and normalised
 * UV rects.
 *
 * Nothing here creates a Pixi sub-`Texture` per sprite: the meshes sample the
 * sheet directly using per-vertex UVs, so a whole sheet is one texture bind and
 * every sprite on it lands in the same draw call. That matters more now that
 * nodes carry an icon *and* a frame *and* sometimes an effect — three quads a
 * node, all still batched by sheet.
 */
export class Atlas {
  readonly textures = new Map<string, Texture>();
  /** Sheets whose file could not be loaded; anything on them is skipped. */
  readonly failed = new Set<string>();
  private readonly frames = new Map<string, SpriteFrame>();
  private readonly sprites: Record<string, SpriteRef>;

  private constructor(sprites: Record<string, SpriteRef>) {
    this.sprites = sprites;
  }

  static async load(geometry: TreeGeometry, opts: AtlasOptions = {}): Promise<Atlas> {
    const atlas = new Atlas(geometry.sprites ?? {});
    const names = new Set<string>(Object.keys(geometry.sheets ?? {}));
    for (const name of Object.keys(opts.sheetSources ?? {})) names.add(name);
    // Nodes carry inline sprite refs, so a sheet can be referenced without ever
    // appearing in `sprites`. Collect those too or the icons silently vanish.
    for (const n of geometry.nodes ?? []) {
      for (const ref of [n.icon?.active, n.icon?.inactive, n.frame?.allocated, n.frame?.path, n.frame?.unallocated, n.effect]) {
        if (ref?.sheet) names.add(ref.sheet);
      }
    }
    // `TreeConnector.sheet` is a *sprite key* in the real data ("Orbit2Active"),
    // which then names the actual file; accept either spelling.
    for (const c of geometry.connectors ?? []) {
      if (!c.sheet) continue;
      const viaSprite = geometry.sprites?.[c.sheet];
      names.add(viaSprite ? viaSprite.sheet : c.sheet);
    }
    for (const ref of Object.values(geometry.sprites ?? {})) names.add(ref.sheet);

    await Promise.all(
      [...names].map(async (name) => {
        const override = opts.sheetSources?.[name];
        try {
          let tex: Texture;
          if (override !== undefined) {
            tex =
              typeof override === 'string'
                ? await Assets.load<Texture>(joinUrl(opts.baseUrl, override))
                : override instanceof TextureSource
                  ? new Texture({ source: override })
                  : Texture.from(override);
          } else {
            const path = geometry.sheets?.[name];
            if (!path) throw new Error(`no path for sheet "${name}"`);
            tex = await Assets.load<Texture>(joinUrl(opts.baseUrl, path));
          }
          atlas.textures.set(name, tex);
        } catch (err) {
          // Not fatal. A tree version may reference art that is not vendored
          // for it, and the tree must render without that piece rather than
          // fail — or worse, paint a magenta placeholder over the middle of it.
          atlas.failed.add(name);
          opts.onSheetError?.(name, err);
          atlas.textures.set(name, getMissingTexture());
        }
      }),
    );

    atlas.applyFiltering();
    atlas.buildFrames();
    return atlas;
  }

  /**
   * Linear filtering, clamped, and **no mipmaps** — which is what PoB does.
   *
   * `PassiveTree.lua` loads both the tree assets (`:240`) and the skill sprite
   * sheets (`:285`) with `MIPMAP` explicitly commented out. That is not an
   * oversight to improve on: these are packed atlases with no padding between
   * sprites, so every mip level blends a sprite with its neighbours and the
   * black gaps around it. `skills-3.jpg` holds 26-37px icons in a 999x1496
   * sheet, so by mip 2 a small node's icon is a few pixels of averaged sludge
   * and reads as an empty socket at any middling zoom.
   *
   * Mipmapping was enabled here to stop the frames and orbit arcs aliasing when
   * zoomed out. It does help those, but it costs the node icons — which are the
   * thing you actually read the tree by — so PoB's trade is the right one.
   */
  private applyFiltering(): void {
    for (const tex of this.textures.values()) {
      const src = tex.source;
      // No power-of-two check any more: that was only there because mipmaps
      // require it. Linear + clamp applies to every sheet.
      src.autoGenerateMipmaps = false;
      src.style.minFilter = 'linear';
      src.style.magFilter = 'linear';
      src.style.addressModeU = 'clamp-to-edge';
      src.style.addressModeV = 'clamp-to-edge';
      src.style.update();
      src.update();
    }
  }

  private buildFrames(): void {
    for (const [key, rect] of Object.entries(this.sprites)) {
      const f = this.refFrame(rect);
      if (f) this.frames.set(key, f);
    }
  }

  /** Normalise an inline sprite ref. Returns undefined for an unknown sheet. */
  refFrame(ref: SpriteRef | undefined): SpriteFrame | undefined {
    if (!ref) return undefined;
    const tex = this.textures.get(ref.sheet);
    if (!tex || this.failed.has(ref.sheet)) return undefined;
    const sw = tex.source.width || 1;
    const sh = tex.source.height || 1;
    return {
      sheet: ref.sheet,
      u0: ref.x / sw,
      v0: ref.y / sh,
      u1: (ref.x + ref.w) / sw,
      v1: (ref.y + ref.h) / sh,
      w: ref.w,
      h: ref.h,
    };
  }

  /** Look up a named sprite from `geometry.sprites`. */
  frame(key: string | undefined): SpriteFrame | undefined {
    const f = key ? this.frames.get(key) : undefined;
    return f && this.failed.has(f.sheet) ? undefined : f;
  }

  /** True when the sheet loaded and is safe to draw from. */
  sheetOk(sheet: string): boolean {
    return this.textures.has(sheet) && !this.failed.has(sheet);
  }

  /**
   * Resolve an `extraImages[].image`.
   *
   * The real data gives an art *path* — "Art/2DArt/BaseClassIllustrations/
   * Str.png" — while `sprites` keys the same illustration as "BackgroundStr",
   * mirroring PoB's `tree.assets.BackgroundStr`. Nothing in the schema states
   * the relationship, so this tries the plausible spellings in order: exact
   * sprite key, whole sheet, bare basename, and PoB's "Background"-prefixed
   * asset name.
   */
  imageFrame(name: string | undefined): SpriteFrame | undefined {
    if (!name) return undefined;
    const base = name.split(/[\\/]/).pop() ?? name;
    const stem = base.replace(/\.[a-z0-9]+$/i, '');
    for (const candidate of [name, base, stem, `Background${stem}`]) {
      const named = this.frames.get(candidate);
      if (named && !this.failed.has(named.sheet)) return named;
    }
    for (const candidate of [name, base, stem]) {
      if (this.failed.has(candidate)) continue;
      const tex = this.textures.get(candidate);
      if (tex) {
        return { sheet: candidate, u0: 0, v0: 0, u1: 1, v1: 1, w: tex.source.width, h: tex.source.height };
      }
    }
    return undefined;
  }

  /**
   * A connector's art. `TreeConnector.sheet` is a sprite key in the real data,
   * so the quad samples a sub-rect of a shared sheet rather than a whole file —
   * and its UVs are relative to that sub-rect, which is why they can exceed 1
   * (a long link tiles the 368x13 line strip along its length).
   */
  connectorFrame(sheetOrKey: string): SpriteFrame | undefined {
    return this.frames.get(sheetOrKey) ?? this.wholeSheetFrame(sheetOrKey);
  }

  private wholeSheetFrame(sheet: string): SpriteFrame | undefined {
    const tex = this.textures.get(sheet);
    if (!tex) return undefined;
    return { sheet, u0: 0, v0: 0, u1: 1, v1: 1, w: tex.source.width, h: tex.source.height };
  }

  texture(sheet: string): Texture | undefined {
    return this.textures.get(sheet);
  }

  get sheetNames(): string[] {
    return [...this.textures.keys()];
  }

  /** Pixel dimensions of a sheet, for turning schema UVs into normalised ones. */
  sheetSize(sheet: string): { w: number; h: number } {
    const tex = this.textures.get(sheet);
    return { w: tex?.source.width || 1, h: tex?.source.height || 1 };
  }

  destroy(): void {
    for (const tex of this.textures.values()) {
      if (tex !== missingTexture) tex.destroy(true);
    }
    this.textures.clear();
    this.frames.clear();
  }
}

/**
 * The schema does not say whether connector UVs are normalised or in pixels.
 * Values outside 0..1 can only be pixels, so we detect and normalise; a tree
 * that genuinely used normalised UVs is untouched.
 */
export function uvScaleFor(uvs: Array<{ x: number; y: number }>, sheetW: number, sheetH: number) {
  let max = 0;
  for (const p of uvs) max = Math.max(max, Math.abs(p.x), Math.abs(p.y));
  return max > 1.0001 ? { sx: 1 / (sheetW || 1), sy: 1 / (sheetH || 1) } : { sx: 1, sy: 1 };
}
