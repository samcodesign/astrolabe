/**
 * Node art selection, draw ordering and connector state are ported from
 * Path of Building Community — see `src/pob/nodeArt.ts` for the full
 * provenance note. Copyright (c) 2016 David Gowor and contributors.
 * MIT — see NOTICE.md.
 */
import { Application, Container, TilingSprite } from 'pixi.js';
import { Atlas, uvScaleFor, type AtlasOptions } from './gfx/atlas';
import {
  NodeArtLayer,
  RingLayer,
  RING_DASHED,
  RING_DISC,
  RING_GLOW,
  RING_SOLID,
  StaticQuadLayer,
  type NodeQuadItem,
  type NodeVariants,
  type StaticQuadItem,
} from './gfx/layers';
import { createSceneUniforms, type SceneUniformGroup } from './gfx/shaders';
import {
  ART_SCALE,
  HALF_GROUP_BACKGROUNDS,
  classBackground,
  backdropTileScale,
  drawAssetHalfRects,
  drawAssetRect,
  flavourTextOffset,
  frameFieldFor,
  planNodeArt,
  pobConnectorState,
  toAllocState,
  type AssetRect,
  type PobConnectorState,
} from './pob/nodeArt';
import { SpatialGrid } from './math/grid';
import { Viewport } from './math/viewport';
import { TreeModel, type NodeVisualState, type PowerMetric } from './state/TreeModel';
import { DARK_THEME, heatColour, mixRGBA, rgba, scaleRGB, toCss, type RGBA, type Theme } from './theme';
import { AscendancyText, type FlavourLabel } from './ui/AscendancyText';
import { Tooltip } from './ui/Tooltip';
import type {
  BuildClass,
  ConnectorVariantTable,
  HoverInfo,
  JewelRadius,
  MasteryEffect,
  MasterySelections,
  NodeId,
  NodePower,
  SpriteRef,
  TreeGeometry,
  TreeNode,
  TreeViewEvents,
} from './types';

export interface TreeViewOptions {
  /** Element the canvas and tooltip are mounted into. */
  container: HTMLElement;
  /** Reuse an existing canvas instead of creating one. */
  canvas?: HTMLCanvasElement;
  theme?: Partial<Theme>;
  /**
   * 'webgl' by default. The custom shaders carry a WGSL variant too, but WebGL
   * is the path that is exercised everywhere, so it is what ships on.
   */
  preference?: 'webgl' | 'webgpu';
  /** Device pixel ratio cap; 2 keeps 4K displays honest. */
  maxResolution?: number;
  /** Minimum on-screen grab radius in CSS px, so tiny nodes stay clickable. */
  minGrabPx?: number;
  /** Disable easing (also honoured automatically for prefers-reduced-motion). */
  reducedMotion?: boolean;
  /** Show the built-in tooltip on hover. */
  tooltips?: boolean;
  /**
   * Re-derive art scale from `node.radius` instead of PoB's flat 1.33*2.
   * Off by default: the real data's radius already equals `artWidth * 1.33`,
   * and class-start nodes ship `radius: 0`.
   */
  fitSpriteToRadius?: boolean;
  /** Extra scale applied to all node art after fitting. */
  spriteScale?: number;
}

type Handler<K extends keyof TreeViewEvents> = (payload: TreeViewEvents[K]) => void;

const HOVER_SCALE = 1.22;
const DRAG_THRESHOLD = 4;

/**
 * Every name {@link TreeView.emit} can fire, as a runtime value — `TreeViewEvents`
 * is a type and vanishes at compile time, so `on()` has nothing to check
 * against without it.
 *
 * Declaring it as a total `Record` over the event keys makes the compiler keep
 * the two in step in both directions: adding an event without listing it here
 * fails, and listing one that no longer exists fails too.
 */
const EVENT_NAMES: Record<keyof TreeViewEvents, true> = {
  hover: true,
  click: true,
  mastery: true,
  ascendancySelect: true,
  viewport: true,
  frame: true,
};

export const TREE_VIEW_EVENTS = new Set(Object.keys(EVENT_NAMES)) as ReadonlySet<
  keyof TreeViewEvents
>;

interface Layers {
  /**
   * The one painted class illustration, behind everything. Rebuilt on class
   * change rather than on load, because which art is drawn depends on the class.
   */
  extras: StaticQuadLayer;
  groups: StaticQuadLayer;
  connectors: StaticQuadLayer;
  /** Masteries sit under the connectors, per PoB's layer 15. */
  masteryIcon: NodeArtLayer;
  masteryFrame: NodeArtLayer;
  masteryEffect: NodeArtLayer;
  /** The node's own artwork: `icon.active` / `icon.inactive`. */
  icon: NodeArtLayer;
  /** The ring around it: `frame.allocated` / `.path` / `.unallocated`. */
  frame: NodeArtLayer;
  /** Glow over allocated masteries and tattooed nodes. */
  effect: NodeArtLayer;
  glow: RingLayer;
  rings: RingLayer;
  /** Decorative ring artwork for jewel radii; rebuilt when the jewels change. */
  jewelArt: StaticQuadLayer;
  jewels: RingLayer;
  hover: RingLayer;
}

/** Variant keys used by the icon / frame / effect layers. */
const ICON_ACTIVE = 'active';
const ICON_INACTIVE = 'inactive';
const FRAME_ALLOCATED = 'allocated';
const FRAME_PATH = 'path';
const FRAME_UNALLOCATED = 'unallocated';
const EFFECT_ON = 'on';

/**
 * The passive tree renderer.
 *
 * ```ts
 * const view = await TreeView.create({ container });
 * await view.load(geometry, { baseUrl: '/treedata' });
 * view.setAllocated(build.allocated);
 * view.on('click', ({ node }) => allocate(node.id));
 * ```
 */
export class TreeView {
  readonly app: Application;
  readonly viewport = new Viewport(1);
  readonly world = new Container();
  /** Tiled stone texture under the tree; null when the art is unavailable. */
  private backdrop: TilingSprite | null = null;

  private readonly opts: Required<Omit<TreeViewOptions, 'theme' | 'canvas'>> & { canvas?: HTMLCanvasElement };
  private readonly theme: Theme;
  private readonly scene: SceneUniformGroup;
  private readonly listeners = new Map<keyof TreeViewEvents, Set<Handler<never>>>();
  private tooltip: Tooltip | null = null;
  private readonly ascendancyText: AscendancyText;
  /** Per group-background quad: the ascendancy whose wheel it is, else null. */
  private groupAscendancy: (string | null)[] = [];

  private model: TreeModel | null = null;
  private atlas: Atlas | null = null;
  private layers: Layers | null = null;
  private grid: SpatialGrid<{ x: number; y: number; radius: number }> | null = null;
  private connectorVariants: ConnectorVariantTable | null = null;
  /** Per node: stable random phase so shimmer/pulse are not in lockstep. */
  private phases = new Float32Array(0);
  /** Per node: eased render scale, so hover pops rather than snaps. */
  private nodeScale = new Float32Array(0);
  private nodeScaleTarget = new Float32Array(0);
  private scaleAnimating = false;

  private hoverIndex = -1;
  private lastRevision = -1;
  private ringsDirty = true;
  /** Viewport scale the current ring set was built for; drives ring LOD. */
  private ringLodScale = 0;
  /** Per connector: which art variant it *is*, so only its state is drawn. */
  private connectorState: PobConnectorState[] = [];
  private running = false;
  private rafId = 0;
  private lastTime = 0;
  private elapsed = 0;
  private ro: ResizeObserver | null = null;
  private destroyed = false;

  // frame stats
  private fpsSmoothed = 60;
  private frameMs = 0;

  private constructor(app: Application, opts: TreeViewOptions) {
    this.app = app;
    this.opts = {
      container: opts.container,
      canvas: opts.canvas,
      preference: opts.preference ?? 'webgl',
      maxResolution: opts.maxResolution ?? 2,
      minGrabPx: opts.minGrabPx ?? 9,
      reducedMotion:
        opts.reducedMotion ??
        (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches),
      tooltips: opts.tooltips ?? true,
      fitSpriteToRadius: opts.fitSpriteToRadius ?? false,
      spriteScale: opts.spriteScale ?? 1,
    };
    this.theme = { ...DARK_THEME, ...opts.theme };
    this.scene = createSceneUniforms();
    this.viewport.smooth = !this.opts.reducedMotion;

    this.app.stage.addChild(this.world);
    if (getComputedStyle(opts.container).position === 'static') {
      opts.container.style.position = 'relative';
    }
    this.ascendancyText = new AscendancyText(opts.container);
    if (this.opts.tooltips) this.tooltip = new Tooltip(opts.container);
    this.bindInput();
    this.observeResize();
  }

  static async create(opts: TreeViewOptions): Promise<TreeView> {
    const app = new Application();
    const canvas = opts.canvas ?? document.createElement('canvas');
    if (!opts.canvas) {
      canvas.style.display = 'block';
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      canvas.style.touchAction = 'none';
      canvas.tabIndex = 0;
      canvas.style.outline = 'none';
      opts.container.appendChild(canvas);
    }
    const theme = { ...DARK_THEME, ...opts.theme };
    const rect = opts.container.getBoundingClientRect();
    await app.init({
      canvas,
      preference: opts.preference ?? 'webgl',
      width: Math.max(1, Math.floor(rect.width)),
      height: Math.max(1, Math.floor(rect.height)),
      background: theme.background,
      antialias: false,
      autoDensity: true,
      resolution: Math.min(opts.maxResolution ?? 2, globalThis.devicePixelRatio || 1),
      autoStart: false,
      powerPreference: 'high-performance',
    });
    const view = new TreeView(app, { ...opts, canvas });
    view.resize();
    view.start();
    return view;
  }

  get canvas(): HTMLCanvasElement {
    return this.app.canvas as HTMLCanvasElement;
  }

  // ------------------------------------------------------------------ loading

  /**
   * Build every GPU buffer for a tree.
   *
   * Must be re-run after a jewel change: per the schema, cluster jewels
   * synthesise nodes and connectors, so the geometry is not static data.
   */
  async load(geometry: TreeGeometry, atlasOptions: AtlasOptions = {}): Promise<void> {
    this.disposeTree();

    const atlas = await Atlas.load(geometry, atlasOptions);
    const model = new TreeModel(geometry);
    this.atlas = atlas;
    this.model = model;
    this.viewport.treeSize = geometry.size || 1;

    const nodes = geometry.nodes;
    this.phases = new Float32Array(nodes.length);
    this.nodeScale = new Float32Array(nodes.length).fill(1);
    this.nodeScaleTarget = new Float32Array(nodes.length).fill(1);
    for (let i = 0; i < nodes.length; i++) this.phases[i] = (i * 2.399963) % 6.2831853;

    this.grid = new SpatialGrid(
      nodes.map((n) => ({ x: n.x, y: n.y, radius: Math.max(n.radius, 1) })),
    );

    // ---- group backgrounds. PoB centres these on the group origin with a
    // half-extent of `art.width * 1.33` (`DrawAsset`), so the drawn box is
    // 2.66x the source pixels — see `drawAssetRect`. The half-art backdrops
    // (PSGroupBackground3) are two stacked quads, the lower one V-flipped.
    const groupItems: StaticQuadItem[] = [];
    // Parallel to `groupItems`: which ascendancy wheel a quad belongs to, so
    // restyle can dim the wheels the build has not taken.
    this.groupAscendancy = [];
    for (const g of geometry.groups ?? []) {
      const frame = atlas.frame(g.background);
      if (!frame) continue;
      const uv = (top: number, bottom: number): number[] => [
        frame.u0, top, frame.u1, top, frame.u1, bottom, frame.u0, bottom,
      ];
      const push = (r: AssetRect, uvs: number[]): void => {
        groupItems.push({
          sheet: frame.sheet,
          verts: [r.x0, r.y0, r.x1, r.y0, r.x1, r.y1, r.x0, r.y1],
          uvs,
        });
        this.groupAscendancy.push(g.isAscendancyStart ? (g.ascendancy ?? null) : null);
      };
      if (HALF_GROUP_BACKGROUNDS.has(g.background)) {
        const [top, bottom] = drawAssetHalfRects(g.x, g.y, frame.w, frame.h);
        push(top, uv(frame.v0, frame.v1));
        push(bottom, uv(frame.v1, frame.v0));
      } else {
        push(drawAssetRect(g.x, g.y, frame.w, frame.h), uv(frame.v0, frame.v1));
      }
    }

    // ---- connectors. `TreeConnector.sheet` is a sprite key, its UVs are
    // relative to that sub-rect, and the real data ships the same link three
    // times — once per allocation state — so only one of each trio is drawn.
    const connectorItems: StaticQuadItem[] = [];
    this.connectorState = new Array<PobConnectorState>(geometry.connectors.length);
    for (let i = 0; i < geometry.connectors.length; i++) {
      const c = geometry.connectors[i];
      const f = atlas.connectorFrame(c.sheet);
      const sheet = f?.sheet ?? c.sheet;
      let maxUv = 0;
      for (const u of c.uvs) maxUv = Math.max(maxUv, Math.abs(u.x), Math.abs(u.y));

      let uvs: number[];
      let rect: readonly [number, number, number, number] | undefined;
      if (f && maxUv <= 1.0001) {
        // Absolute sheet coordinates; no wrapping needed.
        const du = f.u1 - f.u0;
        const dv = f.v1 - f.v0;
        uvs = [
          f.u0 + c.uvs[0].x * du, f.v0 + c.uvs[0].y * dv,
          f.u0 + c.uvs[1].x * du, f.v0 + c.uvs[1].y * dv,
          f.u0 + c.uvs[2].x * du, f.v0 + c.uvs[2].y * dv,
          f.u0 + c.uvs[3].x * du, f.v0 + c.uvs[3].y * dv,
        ];
      } else if (f) {
        // Tiling: keep the tile coordinate and let the shader wrap inside the
        // sub-rect, which GL_REPEAT cannot do for an atlased sprite.
        uvs = [
          c.uvs[0].x, c.uvs[0].y, c.uvs[1].x, c.uvs[1].y,
          c.uvs[2].x, c.uvs[2].y, c.uvs[3].x, c.uvs[3].y,
        ];
        rect = [f.u0, f.v0, f.u1, f.v1];
      } else {
        const size = atlas.sheetSize(sheet);
        const { sx, sy } = uvScaleFor(c.uvs, size.w, size.h);
        uvs = [
          c.uvs[0].x * sx, c.uvs[0].y * sy, c.uvs[1].x * sx, c.uvs[1].y * sy,
          c.uvs[2].x * sx, c.uvs[2].y * sy, c.uvs[3].x * sx, c.uvs[3].y * sy,
        ];
      }

      this.connectorState[i] =
        c.state === 'active' ? 'Active' : c.state === 'intermediate' ? 'Intermediate' : 'Normal';
      connectorItems.push({
        sheet,
        verts: [
          c.verts[0].x, c.verts[0].y, c.verts[1].x, c.verts[1].y,
          c.verts[2].x, c.verts[2].y, c.verts[3].x, c.verts[3].y,
        ],
        uvs,
        ...(rect ? { rect } : {}),
      });
    }

    // ---- ascendancy flavour text. Only the start group of each wheel carries
    // it, and `flavourTextRect` is measured from the backdrop art's corner, so
    // it has to be re-based onto the group origin (PassiveTreeView.lua:604-608).
    const byId = new Map((geometry.ascendancies ?? []).map((a) => [a.id, a]));
    const labels: FlavourLabel[] = [];
    for (const g of geometry.groups ?? []) {
      if (!g.isAscendancyStart || !g.ascendancy) continue;
      const asc = byId.get(g.ascendancy);
      if (!asc?.flavourText || !asc.flavourTextRect) continue;
      const off = flavourTextOffset(asc.flavourTextRect, asc.alternate === true);
      labels.push({
        id: asc.id,
        x: g.x + off.x,
        y: g.y + off.y,
        text: asc.flavourText,
        // Every ascendancy that ships flavour text also ships its colour;
        // white is a visible fallback rather than a silently dropped label.
        colour: asc.flavourTextColour ?? 'ffffff',
      });
    }
    this.ascendancyText.setLabels(labels);

    // ---- the painted class illustration. One only, for the class being
    // played, at PoB's own coordinate — see `classBackground`. Built empty here
    // and filled by `refreshClassArt`, because it changes with the class rather
    // than with the geometry.
    const extraItems: StaticQuadItem[] = [];

    // ---- node art: icon, frame and effect are three separate quads per node,
    // each with its own per-state variants. Masteries are split out so they can
    // be drawn under the connectors.
    const iconItems: NodeVariants[] = [];
    const frameItems: NodeVariants[] = [];
    const effectItems: NodeVariants[] = [];
    const mIconItems: NodeVariants[] = [];
    const mFrameItems: NodeVariants[] = [];
    const mEffectItems: NodeVariants[] = [];

    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];

      // Tree units per art pixel. PoB's `DrawAsset` uses a flat
      // `width * scale * 1.33`, drawn at twice that — so one art pixel is
      // exactly 2.66 tree units, for every asset. The real data agrees: a
      // notable's 58px frame carries `radius: 77.1`, and 58 * 1.33 = 77.14.
      //
      // `fitSpriteToRadius` re-derives the scale from `radius` instead, for
      // hosts whose art and hit radius disagree. It cannot be the default:
      // class-start nodes ship `radius: 0`.
      const sizeRef =
        atlas.refFrame(n.frame?.unallocated ?? n.frame?.allocated ?? n.frame?.path) ??
        atlas.refFrame(n.icon?.inactive ?? n.icon?.active);
      const unit =
        this.opts.fitSpriteToRadius && sizeRef && sizeRef.w > 0 && n.radius > 0
          ? ((n.radius * 2) / sizeRef.w) * this.opts.spriteScale
          : ART_SCALE * 2 * this.opts.spriteScale;

      const mk = (ref: SpriteRef | undefined): NodeQuadItem | null => {
        const f = atlas.refFrame(ref);
        if (!f) return null;
        return {
          sheet: f.sheet,
          cx: n.x,
          cy: n.y,
          hw: (f.w * unit) / 2,
          hh: (f.h * unit) / 2,
          u0: f.u0,
          v0: f.v0,
          u1: f.u1,
          v1: f.v1,
        };
      };

      const collect = (
        pairs: Array<[string, SpriteRef | undefined]>,
      ): Record<string, NodeQuadItem> | null => {
        const out: Record<string, NodeQuadItem> = {};
        let any = false;
        for (const [key, ref] of pairs) {
          const item = mk(ref);
          if (item) {
            out[key] = item;
            any = true;
          }
        }
        return any ? out : null;
      };

      const icons = collect([
        [ICON_ACTIVE, n.icon?.active],
        [ICON_INACTIVE, n.icon?.inactive],
      ]);
      const frames = collect([
        [FRAME_ALLOCATED, n.frame?.allocated],
        [FRAME_PATH, n.frame?.path],
        [FRAME_UNALLOCATED, n.frame?.unallocated],
      ]);
      const effects = collect([[EFFECT_ON, n.effect]]);

      const mastery = n.type === 'mastery';
      if (icons) (mastery ? mIconItems : iconItems).push({ node: i, variants: icons });
      if (frames) (mastery ? mFrameItems : frameItems).push({ node: i, variants: frames });
      if (effects) (mastery ? mEffectItems : effectItems).push({ node: i, variants: effects });
    }

    const N = nodes.length;
    const layers: Layers = {
      extras: StaticQuadLayer.build(extraItems, atlas, this.scene, 'extras'),
      groups: StaticQuadLayer.build(groupItems, atlas, this.scene, 'groups'),
      masteryIcon: NodeArtLayer.build(N, mIconItems, atlas, this.scene, 'mastery-icon'),
      masteryFrame: NodeArtLayer.build(N, mFrameItems, atlas, this.scene, 'mastery-frame'),
      masteryEffect: NodeArtLayer.build(N, mEffectItems, atlas, this.scene, 'mastery-effect'),
      connectors: StaticQuadLayer.build(connectorItems, atlas, this.scene, 'connectors'),
      glow: new RingLayer(this.scene, 1024),
      icon: NodeArtLayer.build(N, iconItems, atlas, this.scene, 'icon'),
      frame: NodeArtLayer.build(N, frameItems, atlas, this.scene, 'frame'),
      effect: NodeArtLayer.build(N, effectItems, atlas, this.scene, 'effect'),
      rings: new RingLayer(this.scene, 2048),
      jewelArt: StaticQuadLayer.build([], atlas, this.scene, 'jewel-art'),
      jewels: new RingLayer(this.scene, 64),
      hover: new RingLayer(this.scene, 16),
    };
    this.layers = layers;

    // Draw order, matching PoB's layer numbering: background art, group art,
    // masteries (15), connectors (20), node icons then frames (25), decoration.
    this.world.addChild(
      layers.extras.container,
      layers.groups.container,
      layers.masteryIcon.container,
      layers.masteryFrame.container,
      layers.masteryEffect.container,
      layers.connectors.container,
      layers.glow.container,
      layers.icon.container,
      layers.frame.container,
      layers.effect.container,
      layers.rings.container,
      layers.jewelArt.container,
      layers.jewels.container,
      layers.hover.container,
    );

    this.buildBackdrop(atlas);
    this.refreshClassArt();

    this.lastRevision = -1;
    this.ringsDirty = true;
    this.requestRender();
  }

  /**
   * The tiled stone texture behind everything (PassiveTreeView.lua:536-545).
   *
   * PoB fills the whole viewport with one quad and scrolls it by remapping the
   * UVs against the pan offset, so the tile is pinned to *tree* space while the
   * quad stays in screen space. A `TilingSprite` expresses exactly that, and
   * keeps it to one draw call regardless of how far out the tree is zoomed.
   *
   * `Background1` is the pre-3.x fallback PoB still honours; a tree version
   * missing both simply renders without a backdrop.
   */
  private buildBackdrop(atlas: Atlas): void {
    this.backdrop?.destroy();
    this.backdrop = null;

    const frame = atlas.frame('Background2') ?? atlas.frame('Background1');
    const texture = frame && atlas.texture(frame.sheet);
    if (!frame || !texture || !atlas.sheetOk(frame.sheet)) return;

    const sprite = new TilingSprite({ texture, width: 1, height: 1 });
    this.backdrop = sprite;
    // Below `world`, which holds every other layer.
    this.app.stage.addChildAt(sprite, 0);
    this.sizeBackdrop();
  }

  private sizeBackdrop(): void {
    if (!this.backdrop) return;
    this.backdrop.width = this.viewport.vw;
    this.backdrop.height = this.viewport.vh;
  }

  /**
   * Supply per-state connector art. See `ConnectorVariantTable` — the schema
   * only ships one UV set per connector, so without this the renderer tints
   * the delivered art instead of swapping it.
   */
  setConnectorVariants(table: ConnectorVariantTable | null): void {
    this.connectorVariants = table;
    this.lastRevision = -1;
    this.requestRender();
  }

  // -------------------------------------------------------------- public API

  setAllocated(ids: Iterable<NodeId>): void {
    this.model?.setAllocated(ids);
    this.requestRender();
  }

  /** Preview route to a candidate node; pass null to clear. */
  setPathPreview(ids: Iterable<NodeId> | null): void {
    this.model?.setPathPreview(ids);
    this.requestRender();
  }

  setSelected(ids: Iterable<NodeId> | null): void {
    this.model?.setSelected(ids);
    this.requestRender();
  }

  /** Ring these nodes and dim everything else. Pass null to clear. */
  setSearch(ids: Iterable<NodeId> | null): void {
    this.model?.setSearch(ids);
    this.requestRender();
  }

  /** Colour the difference between two allocation sets. Pass nulls to clear. */
  setCompare(base: Iterable<NodeId> | null, other: Iterable<NodeId> | null): void {
    this.model?.setCompare(base, other);
    this.requestRender();
  }

  setPowerVisible(on: boolean, metric?: PowerMetric): void {
    this.model?.setPowerVisible(on, metric);
    this.requestRender();
  }

  /** Called once with `tree.power`'s `requested` count. */
  expectPower(total: number): void {
    this.model?.expectPower(total);
    this.requestRender();
  }

  /** Merge a `tree.power.progress` batch. Safe to call repeatedly. */
  addPower(nodes: readonly NodePower[], meta?: { done?: number; total?: number }): void {
    this.model?.addPower(nodes, meta);
    this.requestRender();
  }

  finishPower(elapsedMs?: number): void {
    this.model?.finishPower(elapsedMs);
    this.requestRender();
  }

  clearPower(): void {
    this.model?.clearPower();
    this.requestRender();
  }

  /**
   * Mastery selections, straight from `BuildSummary.masterySelections`.
   *
   * A mastery with no chosen effect is drawn as reachable rather than
   * allocated, because that is what it is: PoB does not count the point until
   * an effect is picked.
   */
  setMasterySelections(selections: MasterySelections | null): void {
    this.model?.setMasterySelections(selections);
    this.requestRender();
  }

  /** Mirror one `tree.setMastery` call. */
  setMastery(node: NodeId, effect: number | null): void {
    this.model?.setMastery(node, effect);
    this.requestRender();
  }

  /** Apply the refreshed `available` flags from `tree.setMastery`'s result. */
  setMasteryEffects(table: Record<NodeId, MasteryEffect[]>): void {
    this.model?.setMasteryEffects(table);
    this.requestRender();
  }

  masterySelection(node: NodeId): number | null {
    return this.model?.masterySelection(node) ?? null;
  }

  /**
   * The build's class and ascendancy, from `BuildSummary`.
   *
   * Without it every ascendancy node reads as foreign, so clicking one of your
   * own ascendancy's nodes would emit `ascendancy` instead of allocating.
   */
  setClass(cls: BuildClass | null): void {
    this.model?.setClass(cls);
    this.refreshClassArt();
    this.requestRender();
  }

  /**
   * Swap the painted class illustration to match the current class.
   *
   * PoB re-picks it every frame from `curClassId` (PassiveTreeView.lua:547-566),
   * so it appears and disappears with the class. Here the art is baked into a
   * quad batch, which means the layer is rebuilt instead — cheap, because it is
   * at most one quad, and it only happens on a class change.
   */
  private refreshClassArt(): void {
    const layers = this.layers;
    const atlas = this.atlas;
    if (!layers || !atlas) return;

    const bg = classBackground(this.model?.className);
    const frame = bg && atlas.frame(bg.asset);
    const items: StaticQuadItem[] = [];
    if (bg && frame) {
      const r = drawAssetRect(bg.x, bg.y, frame.w, frame.h);
      items.push({
        sheet: frame.sheet,
        verts: [r.x0, r.y0, r.x1, r.y0, r.x1, r.y1, r.x0, r.y1],
        uvs: [frame.u0, frame.v0, frame.u1, frame.v0, frame.u1, frame.v1, frame.u0, frame.v1],
      });
    }

    const index = this.world.getChildIndex(layers.extras.container);
    layers.extras.destroy();
    layers.extras = StaticQuadLayer.build(items, atlas, this.scene, 'extras');
    this.world.addChildAt(layers.extras.container, index);
  }

  setJewelRadii(list: JewelRadius[]): void {
    if (!this.model) return;
    this.model.jewels = list;
    this.refreshJewelArt();
    this.lastRevision = -1;
    this.requestRender();
  }

  /**
   * The ornate rings PoB draws for a socketed jewel
   * (`PassiveTreeView.lua:1158-1204`).
   *
   * Each ring is one sprite drawn twice, counter-rotated, so the pair reads as
   * a single ring. `DrawImageRotated` centres the image with a side of
   * `radius * 2`, so the half-extent is the radius itself — not `ART_SCALE`d
   * like ordinary node art, because this size comes from the radius table
   * rather than from the sprite's pixels.
   */
  private refreshJewelArt(): void {
    const layers = this.layers;
    const atlas = this.atlas;
    const model = this.model;
    if (!layers || !atlas || !model) return;

    const items: StaticQuadItem[] = [];
    for (const j of model.jewels) {
      const i = model.index.get(j.nodeId);
      if (i === undefined) continue;
      const n = model.nodes[i];

      // The socket's own art, which is how PoB shows what is slotted. Sized
      // like any other node asset, unlike the ring below.
      const socket = j.socketArt ? atlas.frame(j.socketArt) : undefined;
      if (socket) {
        const r = drawAssetRect(n.x, n.y, socket.w, socket.h);
        items.push({
          sheet: socket.sheet,
          verts: [r.x0, r.y0, r.x1, r.y0, r.x1, r.y1, r.x0, r.y1],
          uvs: [socket.u0, socket.v0, socket.u1, socket.v0, socket.u1, socket.v1, socket.u0, socket.v1],
        });
      }

      // The engine resolves which rings a jewel draws, how big, at what angle
      // and — for Impossible Escape, whose rings mark the keystones it unlocks
      // rather than an area around the socket — where. So this is one loop with
      // no jewel names in it.
      for (const ring of j.rings ?? []) {
        const cx0 = ring.x ?? n.x;
        const cy0 = ring.y ?? n.y;
        const h = ring.radius;
        if (!h) continue;
        for (let k = 0; k < ring.sprites.length; k++) {
          const frame = atlas.frame(ring.sprites[k]);
          if (!frame) continue;
          const angle = ring.rotation[k] ?? 0;
          const cos = Math.cos(angle);
          const sin = Math.sin(angle);
          const corner = (dx: number, dy: number): [number, number] => [
            cx0 + dx * h * cos - dy * h * sin,
            cy0 + dx * h * sin + dy * h * cos,
          ];
          const [ax, ay] = corner(-1, -1);
          const [bx, by] = corner(1, -1);
          const [cx, cy] = corner(1, 1);
          const [dx2, dy2] = corner(-1, 1);
          items.push({
            sheet: frame.sheet,
            verts: [ax, ay, bx, by, cx, cy, dx2, dy2],
            uvs: [frame.u0, frame.v0, frame.u1, frame.v0, frame.u1, frame.v1, frame.u0, frame.v1],
          });
        }
      }
    }

    const index = this.world.getChildIndex(layers.jewelArt.container);
    layers.jewelArt.destroy();
    layers.jewelArt = StaticQuadLayer.build(items, atlas, this.scene, 'jewel-art');
    this.world.addChildAt(layers.jewelArt.container, index);
  }

  /** Fill the app-owned slot at the bottom of the tooltip. */
  setTooltipExtra(content: string | HTMLElement | null): void {
    this.tooltip?.setExtra(content);
  }

  /**
   * Hold the tooltip closed. The mastery chooser opens on top of the node you
   * just clicked and the tooltip never sees the cursor leave, so without this
   * the two overlap. Wire it to `MasteryChooser.setOpenChangeHandler`.
   */
  setTooltipSuppressed(on: boolean): void {
    this.tooltip?.setSuppressed(on);
  }

  get hoveredNode(): TreeNode | null {
    return this.hoverIndex >= 0 ? (this.model?.nodes[this.hoverIndex] ?? null) : null;
  }

  get powerProgress(): { received: number; expected: number; done: boolean } {
    const s = this.model?.powerStats;
    return { received: s?.received ?? 0, expected: s?.expected ?? 0, done: s?.done ?? false };
  }

  focusNode(id: NodeId, level = Math.max(this.viewport.level, 4)): void {
    const idx = this.model?.index.get(id);
    if (idx === undefined || !this.model) return;
    const n = this.model.nodes[idx];
    this.viewport.centreOn(n, level);
    this.requestRender();
  }

  /** Frame a set of nodes, e.g. every search hit. */
  focusNodes(ids: Iterable<NodeId>, padding = 1.35): void {
    if (!this.model) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let n = 0;
    for (const id of ids) {
      const i = this.model.index.get(id);
      if (i === undefined) continue;
      const node = this.model.nodes[i];
      minX = Math.min(minX, node.x); maxX = Math.max(maxX, node.x);
      minY = Math.min(minY, node.y); maxY = Math.max(maxY, node.y);
      n++;
    }
    if (!n) return;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const span = Math.max(maxX - minX, maxY - minY, this.viewport.treeSize * 0.02) * padding;
    const wanted = this.viewport.treeSize / span;
    const level = Math.max(-4, Math.min(14, Math.floor(Math.log(wanted) / Math.log(1.2))));
    this.viewport.centreOn({ x: cx, y: cy }, level);
    this.requestRender();
  }

  resetView(): void {
    this.viewport.reset();
    this.requestRender();
  }

  zoomBy(levels: number): void {
    this.viewport.zoomByLevels(levels);
    this.requestRender();
  }

  on<K extends keyof TreeViewEvents>(event: K, fn: Handler<K>): () => void {
    // Subscribing to a name nothing emits is silent: no error, no warning, the
    // interaction just never happens. That is exactly how the app came to
    // listen for `ascendancySelect` while this emitted `ascendancy`, and it
    // survived both a green renderer suite and a green app suite. A JS caller
    // (or one whose types have drifted from the built package) gets told.
    if (!TREE_VIEW_EVENTS.has(event)) {
      throw new Error(
        `TreeView has no "${String(event)}" event; expected one of ` +
          `${[...TREE_VIEW_EVENTS].join(', ')}`,
      );
    }
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn as Handler<never>);
    return () => set!.delete(fn as Handler<never>);
  }

  private emit<K extends keyof TreeViewEvents>(event: K, payload: TreeViewEvents[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const fn of set) (fn as Handler<K>)(payload);
  }

  /** The six node-art layers, so per-node updates never miss one. */
  private artLayers(): NodeArtLayer[] {
    const l = this.layers!;
    return [l.icon, l.frame, l.effect, l.masteryIcon, l.masteryFrame, l.masteryEffect];
  }

  /**
   * Point each art layer at the variant its state selects.
   *
   * This is the art swap the schema asks for: `icon.active` vs
   * `icon.inactive` (different sheets — PoB desaturates by swapping art, not by
   * tinting) and `frame.allocated` / `.path` / `.unallocated`. The effect
   * overlay is shown only for an allocated node that has one, which for a
   * mastery means one with a chosen effect.
   */
  private applyVariants(i: number, v: NodeVisualState): void {
    const l = this.layers!;
    const node = this.model!.nodes[i];

    // PassiveTreeView.lua Draw(), 805-900.
    const plan = planNodeArt({
      type: node.type,
      isAlloc: v.alloc === 'allocated',
      showHeatMap: v.powerActive,
      isHovered: v.hovered,
      onHoverPath: v.alloc === 'path',
      hasMasteryEffects: !!node.masteryEffects?.length,
      masteryChosen: !v.masteryUnchosen,
    });

    const iconKey = plan.icon === 'active' ? ICON_ACTIVE : plan.icon === null ? null : ICON_INACTIVE;
    const frameKey = plan.frame ? frameFieldFor(plan.frame) : null;

    // Fall back rather than vanish when the host omits a variant.
    const pick = (layer: NodeArtLayer, want: string | null, order: string[]): string | null => {
      if (want === null) return null;
      const have = layer.variantsOf(i);
      if (!have.length) return null;
      if (have.includes(want)) return want;
      for (const k of order) if (have.includes(k)) return k;
      return have[0];
    };

    const iconOrder = [ICON_INACTIVE, ICON_ACTIVE];
    const frameOrder = [FRAME_UNALLOCATED, FRAME_PATH, FRAME_ALLOCATED];
    l.icon.setVariant(i, pick(l.icon, iconKey, iconOrder));
    l.masteryIcon.setVariant(i, pick(l.masteryIcon, iconKey, iconOrder));
    l.frame.setVariant(i, pick(l.frame, frameKey, frameOrder));
    l.masteryFrame.setVariant(i, pick(l.masteryFrame, frameKey, frameOrder));
    l.effect.setVariant(i, plan.effect ? EFFECT_ON : null);
    l.masteryEffect.setVariant(i, plan.effect ? EFFECT_ON : null);
  }

  // ------------------------------------------------------------------ styling

  /**
   * The single place node colour is decided, so the full restyle pass and the
   * incremental hover update can never disagree.
   *
   * Precedence: compare overlay > heat > not-yet-scored > allocation state,
   * then the search filter dims whatever came out.
   */
  private resolveColour(v: NodeVisualState, isFrame: boolean): RGBA {
    const t = this.theme;
    let base: RGBA;

    if (v.compare === 'added') base = t.compareAdded;
    else if (v.compare === 'removed') base = t.compareRemoved;
    else if (v.heat !== null) {
      // Mostly heat, with a trace of the allocation colour so an allocated
      // node still reads as allocated while the map is up.
      base = mixRGBA(t.node[v.alloc], heatColour(v.heat), v.alloc === 'allocated' ? 0.5 : 0.88);
      if (isFrame) base = heatColour(v.heat);
    } else if (v.pending) {
      base = t.powerPending;
    } else if (v.powerActive && v.alloc === 'allocated') {
      base = t.powerAllocated;
    } else {
      base = t.node[v.alloc];
      // Power mode is on but this node is outside the pass (a mastery, say):
      // recede it so it is not confused with a low score.
      if (v.powerActive && v.alloc === 'unallocated') base = scaleRGB(base, 0.4, base.a);
    }

    if (v.dimmed) return scaleRGB(base, t.dimFactor, base.a * 0.5);
    if (v.matched) base = scaleRGB(base, 1.45, 1);
    if (v.compare === 'same' && v.alloc === 'unallocated') {
      base = scaleRGB(base, 0.55, base.a * 0.7);
    }
    if (isFrame && v.compare === null && v.heat === null && !v.pending) {
      base = scaleRGB(base, 1.18, Math.min(1, base.a * 1.1));
    }
    return base;
  }

  private animFor(v: NodeVisualState): number {
    if (v.hovered) return 1;
    if (v.pending) return 2;
    return 0;
  }

  private restyle(): void {
    const model = this.model;
    const layers = this.layers;
    if (!model || !layers) return;
    const t = this.theme;
    const powerOn = model.powerVisible;

    // PoB compares each wheel against `spec.curAscendClassBaseName`; we have no
    // separate class selection, so the chosen ascendancy is simply whichever
    // one the build has spent points in. Everything else draws dimmed.
    const chosen = new Set<string>();
    for (let i = 0; i < model.nodes.length; i++) {
      const n = model.nodes[i];
      if (n.ascendancy && model.allocState(n.id) === 'allocated') chosen.add(n.ascendancy);
    }
    this.ascendancyText.setSelected(chosen);

    for (let i = 0; i < model.nodes.length; i++) {
      const v = model.visualFor(i);
      const anim = this.animFor(v);
      const base = this.resolveColour(v, false);
      const frame = this.resolveColour(v, true);

      this.applyVariants(i, v);
      layers.icon.setColour(i, base, anim, this.phases[i]);
      layers.masteryIcon.setColour(i, base, anim, this.phases[i]);
      layers.frame.setColour(i, frame, anim, this.phases[i]);
      layers.masteryFrame.setColour(i, frame, anim, this.phases[i]);
      layers.effect.setColour(i, frame, anim, this.phases[i]);
      layers.masteryEffect.setColour(i, frame, anim, this.phases[i]);

      const target = v.hovered ? HOVER_SCALE : v.selected ? 1.08 : v.matched ? 1.12 : 1;
      if (this.nodeScaleTarget[i] !== target) {
        this.nodeScaleTarget[i] = target;
        this.scaleAnimating = true;
      }
    }

    // Group backgrounds follow the global filter. Without this they stay at
    // full brightness during a search and become the loudest thing on screen.
    const groupDim = model.searchActive ? 0.28 : model.compareActive ? 0.5 : powerOn ? 0.45 : 1;
    const groupColour = scaleRGB(t.groupBackground, groupDim, t.groupBackground.a * groupDim);
    // PoB draws a wheel the build has not taken at `SetDrawColor(1, 1, 1, 0.50)`
    // (PassiveTreeView.lua:574-577), so only your own ascendancy is at full
    // strength; the other 30 recede.
    const unchosenWheel = scaleRGB(groupColour, 1, groupColour.a * 0.5);
    for (let i = 0; i < layers.groups.count; i++) {
      const asc = this.groupAscendancy[i];
      layers.groups.setColour(i, asc && !chosen.has(asc) ? unchosenWheel : groupColour, 0, 0);
    }

    // Connectors: the real data ships one quad per allocation state per link, so
    // "swapping art" means drawing the one whose state matches and dropping the
    // other two from the index list entirely.
    const connectors = model.geometry.connectors;
    const wanted = new Uint8Array(connectors.length);
    for (let i = 0; i < connectors.length; i++) {
      const c = connectors[i];
      // PassiveTreeView.lua:663-673.
      const state = pobConnectorState({
        aAlloc: model.allocState(c.from) === 'allocated',
        bAlloc: model.allocState(c.to) === 'allocated',
        hoverPathActive: model.pathCount > 0,
        aOnHoverPath: model.allocState(c.from) !== 'unallocated',
        bOnHoverPath: model.allocState(c.to) !== 'unallocated',
      });
      const show = this.connectorState[i] === state;
      wanted[i] = show ? 1 : 0;
      if (!show) continue;

      let colour = t.connector[toAllocState(state)];
      if (model.compareActive) {
        const a = model.compareState(c.from);
        const b = model.compareState(c.to);
        if (a === 'added' && b === 'added') colour = scaleRGB(t.compareAdded, 0.8, 0.9);
        else if (a === 'removed' && b === 'removed') colour = scaleRGB(t.compareRemoved, 0.8, 0.9);
        else colour = scaleRGB(colour, 0.5, colour.a * 0.6);
      }
      if (model.searchActive && !(model.matchesSearch(c.from) && model.matchesSearch(c.to))) {
        colour = scaleRGB(colour, t.dimFactor, colour.a * 0.45);
      } else if (powerOn && state !== 'Active') {
        // Let the heat read: recede unallocated links behind the node art.
        colour = scaleRGB(colour, 0.5, colour.a);
      }

      layers.connectors.setColour(i, colour, 0, 0);
      this.applyConnectorVariant(i, toAllocState(state));
    }
    layers.connectors.setVisibility((i) => wanted[i] === 1);

    this.ringsDirty = true;
  }

  private applyConnectorVariant(i: number, state: 'allocated' | 'path' | 'unallocated'): void {
    const table = this.connectorVariants;
    if (!table || !this.layers) return;
    const variants = table.get(i);
    if (!variants) return;
    const key = state === 'allocated' ? 'active' : state === 'path' ? 'intermediate' : 'normal';
    const v = variants[key];
    if (!v) return;
    const sheet = v.sheet ?? this.model!.geometry.connectors[i].sheet;
    const size = this.atlas!.sheetSize(sheet);
    const { sx, sy } = uvScaleFor(v.uvs, size.w, size.h);
    this.layers.connectors.setUVs(i, [
      v.uvs[0].x * sx, v.uvs[0].y * sy,
      v.uvs[1].x * sx, v.uvs[1].y * sy,
      v.uvs[2].x * sx, v.uvs[2].y * sy,
      v.uvs[3].x * sx, v.uvs[3].y * sy,
    ]);
  }

  private rebuildRings(): void {
    const model = this.model;
    const layers = this.layers;
    if (!model || !layers) return;
    const t = this.theme;

    layers.glow.begin();
    layers.rings.begin();
    layers.jewels.begin();

    // Level of detail. A dashed "not evaluated" ring around 2,700 nodes is
    // noise when each node is four pixels wide, so the ring only appears once
    // it can actually be read. `ringLodScale` records the zoom this set was
    // built at; crossing a threshold rebuilds.
    const scale = this.viewport.scale;
    this.ringLodScale = scale;
    const minPendingRadiusPx = 6;

    for (let i = 0; i < model.nodes.length; i++) {
      const n = model.nodes[i];
      const v = model.visualFor(i);
      const r = Math.max(n.radius, 1);

      if (v.heat !== null && v.heat > 0.5) {
        const k = (v.heat - 0.5) / 0.5;
        const c = heatColour(v.heat);
        layers.glow.add(n.x, n.y, r * (2.4 + k * 1.6), 0, RING_GLOW, { ...c, a: 0.16 + k * 0.42 });
      }
      if (v.matched) {
        layers.glow.add(n.x, n.y, r * 3.2, 0, RING_GLOW, t.searchGlow);
        layers.rings.add(n.x, n.y, r * 1.55, r * 0.16, RING_SOLID, t.searchRing, this.phases[i]);
      }
      if (v.pending && r * scale >= minPendingRadiusPx) {
        layers.rings.add(n.x, n.y, r * 1.3, r * 0.1, RING_DASHED, t.powerPending, this.phases[i]);
      }
      if (v.compare === 'added' || v.compare === 'removed') {
        const c = v.compare === 'added' ? t.compareAdded : t.compareRemoved;
        layers.glow.add(n.x, n.y, r * 3.0, 0, RING_GLOW, { ...c, a: 0.3 });
        layers.rings.add(n.x, n.y, r * 1.5, r * 0.18, RING_SOLID, c, 0);
      }
      if (v.selected) {
        layers.rings.add(n.x, n.y, r * 1.78, r * 0.12, RING_SOLID, t.selectRing, 0);
      }
    }

    for (const j of model.jewels) {
      const idx = model.index.get(j.nodeId);
      if (idx === undefined) continue;
      const n = model.nodes[idx];
      const colour = j.colour !== undefined ? rgba(j.colour, t.jewelRing.a) : t.jewelRing;
      if (!j.outer) continue;
      const inner = j.inner ?? 0;
      // Both bounds get an outline; only a disc-shaped radius gets the wash.
      // Filling an annulus as a disc would claim the hole is covered, and for
      // Thread of Hope the hole is the whole point.
      const bounds = inner > 0 ? [inner, j.outer] : [j.outer];
      for (const radius of bounds) {
        layers.jewels.add(n.x, n.y, radius, Math.max(2, radius * 0.006), RING_SOLID, colour, 0);
        if (inner > 0) continue;
        layers.jewels.add(n.x, n.y, radius, radius * 0.02, RING_DISC, { ...colour, a: 0.05 }, 0);
      }
    }

    layers.glow.end();
    layers.rings.end();
    layers.jewels.end();
    this.ringsDirty = false;
  }

  private rebuildHoverRing(): void {
    const layers = this.layers;
    const model = this.model;
    if (!layers || !model) return;
    layers.hover.begin();
    if (this.hoverIndex >= 0) {
      const n = model.nodes[this.hoverIndex];
      const r = Math.max(n.radius, 1) * this.nodeScale[this.hoverIndex];
      layers.hover.add(n.x, n.y, r * 3.4, 0, RING_GLOW, this.theme.hoverGlow);
      layers.hover.add(n.x, n.y, r * 1.42, r * 0.1, RING_SOLID, this.theme.hoverRing);
    }
    layers.hover.end();
  }

  // -------------------------------------------------------------------- input

  private dragging = false;
  private dragMoved = 0;
  private lastPointer = { x: 0, y: 0 };
  private wheelAccum = 0;

  private localPoint(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private bindInput(): void {
    const c = this.canvas;
    c.addEventListener('wheel', this.onWheel, { passive: false });
    c.addEventListener('pointerdown', this.onPointerDown);
    c.addEventListener('pointermove', this.onPointerMove);
    c.addEventListener('pointerup', this.onPointerUp);
    c.addEventListener('pointercancel', this.onPointerUp);
    c.addEventListener('pointerleave', this.onPointerLeave);
    c.addEventListener('contextmenu', this.onContextMenu);
    c.addEventListener('keydown', this.onKeyDown);
  }

  private unbindInput(): void {
    const c = this.canvas;
    c.removeEventListener('wheel', this.onWheel);
    c.removeEventListener('pointerdown', this.onPointerDown);
    c.removeEventListener('pointermove', this.onPointerMove);
    c.removeEventListener('pointerup', this.onPointerUp);
    c.removeEventListener('pointercancel', this.onPointerUp);
    c.removeEventListener('pointerleave', this.onPointerLeave);
    c.removeEventListener('contextmenu', this.onContextMenu);
    c.removeEventListener('keydown', this.onKeyDown);
  }

  private onContextMenu = (e: Event) => e.preventDefault();

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    // Convert whatever the device reports into "notches": one notch of a mouse
    // wheel is one zoom level. Chrome reports 100 px per notch, Firefox reports
    // 3 lines, page mode reports 1. Trackpads emit small pixel deltas, so the
    // remainder accumulates and a smooth two-finger scroll still steps evenly.
    const perNotch = e.deltaMode === 1 ? 3 : e.deltaMode === 2 ? 1 : 100;
    this.wheelAccum += Math.max(-4, Math.min(4, e.deltaY / perNotch));
    const levels = -Math.trunc(this.wheelAccum);
    if (levels !== 0) {
      this.wheelAccum += levels;
      this.viewport.zoomByLevels(levels, this.localPoint(e));
      this.requestRender();
    }
  };

  private onPointerDown = (e: PointerEvent) => {
    this.canvas.focus({ preventScroll: true });
    if (e.button === 0 || e.button === 1) {
      this.dragging = true;
      this.dragMoved = 0;
      this.lastPointer = this.localPoint(e);
      this.canvas.setPointerCapture(e.pointerId);
    }
  };

  private onPointerMove = (e: PointerEvent) => {
    const p = this.localPoint(e);
    if (this.dragging) {
      const dx = p.x - this.lastPointer.x;
      const dy = p.y - this.lastPointer.y;
      this.dragMoved += Math.abs(dx) + Math.abs(dy);
      this.lastPointer = p;
      if (this.dragMoved > DRAG_THRESHOLD) {
        this.viewport.panBy(dx, dy);
        this.canvas.style.cursor = 'grabbing';
        this.setHover(-1, p);
        this.requestRender();
        return;
      }
    }
    this.lastPointer = p;
    this.updateHover(p);
  };

  private onPointerUp = (e: PointerEvent) => {
    const wasDrag = this.dragMoved > DRAG_THRESHOLD;
    if (this.dragging) {
      this.dragging = false;
      this.canvas.style.cursor = '';
      try {
        this.canvas.releasePointerCapture(e.pointerId);
      } catch {
        /* pointer already released */
      }
    }
    if (wasDrag) {
      this.updateHover(this.localPoint(e));
      return;
    }
    const p = this.localPoint(e);
    const idx = this.pick(p);
    if (idx < 0 || !this.model) return;
    const node = this.model.nodes[idx];

    // A mastery is not allocated by clicking: it opens a chooser and the player
    // picks exactly one effect. The renderer does not own that popup — it hands
    // the node and its options to the app.
    if (node.type === 'mastery' && node.masteryEffects?.length) {
      this.emit('mastery', {
        node,
        effects: node.masteryEffects,
        selected: this.model.masterySelection(node.id),
        screen: this.viewport.treeToScreen(node),
      });
      return;
    }

    // Clicking an unallocated node of another ascendancy switches class or
    // ascendancy instead of allocating: PoB runs the whole switch before it
    // ever reaches its allocation branch (`PassiveTreeView.lua:395-500`), and a
    // cross-class switch can reset the tree, so it is the app's call and not
    // the renderer's. Allocated nodes are excluded because PoB deallocates them
    // without consulting the ascendancy at all (`:389-392`).
    if (!this.model.isAllocated(node.id)) {
      const target = this.model.ascendancyTarget(node.id);
      if (target) {
        this.emit('ascendancySelect', {
          ...target,
          node,
          screen: this.viewport.treeToScreen(node),
        });
        return;
      }
    }

    this.emit('click', {
      node,
      button: e.button,
      shift: e.shiftKey,
      ctrl: e.ctrlKey || e.metaKey,
      alt: e.altKey,
    });
  };

  private onPointerLeave = () => {
    this.setHover(-1, this.lastPointer);
    this.requestRender();
  };

  private onKeyDown = (e: KeyboardEvent) => {
    const pan = e.shiftKey ? 240 : 90;
    switch (e.key) {
      case '+':
      case '=':
        this.viewport.zoomByLevels(1);
        break;
      case '-':
      case '_':
        this.viewport.zoomByLevels(-1);
        break;
      case '0':
        this.viewport.reset();
        break;
      case 'ArrowLeft':
        this.viewport.panTo(this.viewport.targetX + pan, this.viewport.targetY);
        break;
      case 'ArrowRight':
        this.viewport.panTo(this.viewport.targetX - pan, this.viewport.targetY);
        break;
      case 'ArrowUp':
        this.viewport.panTo(this.viewport.targetX, this.viewport.targetY + pan);
        break;
      case 'ArrowDown':
        this.viewport.panTo(this.viewport.targetX, this.viewport.targetY - pan);
        break;
      default:
        return;
    }
    e.preventDefault();
    this.requestRender();
  };

  /** Tree-space hit test through the spatial grid. */
  private pick(screen: { x: number; y: number }): number {
    if (!this.grid) return -1;
    const p = this.viewport.screenToTree(screen);
    const minRadius = this.opts.minGrabPx * this.viewport.unitsPerPixel;
    return this.grid.pick(p.x, p.y, 0, minRadius);
  }

  private updateHover(p: { x: number; y: number }): void {
    const idx = this.pick(p);
    this.setHover(idx, p);
  }

  private setHover(idx: number, screen: { x: number; y: number }): void {
    if (idx === this.hoverIndex) {
      if (idx >= 0 && this.tooltip) this.moveTooltip(screen);
      return;
    }
    const model = this.model;
    const prev = this.hoverIndex;
    this.hoverIndex = idx;
    if (model) {
      model.hovered = idx >= 0 ? model.nodes[idx].id : null;
      // Hover is applied incrementally: a full restyle on every mouse move
      // would be 12k buffer writes for a two-node change.
      if (prev >= 0) this.applyHoverStyle(prev, false);
      if (idx >= 0) this.applyHoverStyle(idx, true);
    }
    this.canvas.style.cursor = this.dragging ? 'grabbing' : idx >= 0 ? 'pointer' : '';

    if (idx >= 0 && model) {
      const node = model.nodes[idx];
      const info: HoverInfo = {
        node,
        screen: this.viewport.treeToScreen(node),
        power: model.powerFor(node.id),
        alloc: model.allocState(node.id),
      };
      this.emit('hover', info);
      if (this.tooltip) {
        const heat = model.heatFor(node.id);
        this.tooltip.show(
          {
            node,
            alloc: info.alloc,
            power: info.power,
            percentile: model.percentileFor(node.id),
            pending: model.powerVisible && !info.power,
            heatCss: heat !== null ? toCss(heatColour(heat)) : undefined,
            pathCost: model.pathCostFor(node.id),
            jewel: this.jewelAt(node.id),
          },
          screen.x,
          screen.y,
        );
      }
    } else {
      this.emit('hover', null);
      this.tooltip?.hide();
    }
    this.requestRender();
  }

  /** The jewel socketed at a node, if any. Sockets are few, so a scan is fine. */
  private jewelAt(nodeId: NodeId) {
    return this.model?.jewels.find((j) => j.nodeId === nodeId)?.item;
  }

  private moveTooltip(screen: { x: number; y: number }): void {
    if (!this.tooltip || this.hoverIndex < 0 || !this.model) return;
    const node = this.model.nodes[this.hoverIndex];
    const heat = this.model.heatFor(node.id);
    this.tooltip.show(
      {
        node,
        alloc: this.model.allocState(node.id),
        power: this.model.powerFor(node.id),
        percentile: this.model.percentileFor(node.id),
        pending: this.model.powerVisible && !this.model.powerFor(node.id),
        heatCss: heat !== null ? toCss(heatColour(heat)) : undefined,
        pathCost: this.model.pathCostFor(node.id),
        jewel: this.jewelAt(node.id),
      },
      screen.x,
      screen.y,
    );
  }

  /**
   * Hover is applied incrementally: a full restyle on every mouse move would
   * be ~12k buffer writes to change two nodes.
   */
  private applyHoverStyle(i: number, on: boolean): void {
    const layers = this.layers;
    if (!layers || !this.model) return;
    const v = { ...this.model.visualFor(i), hovered: on };
    this.nodeScaleTarget[i] = on ? HOVER_SCALE : v.selected ? 1.08 : v.matched ? 1.12 : 1;
    this.scaleAnimating = true;
    const anim = this.animFor(v);
    const base = this.resolveColour(v, false);
    const frame = this.resolveColour(v, true);
    layers.icon.setColour(i, base, anim, this.phases[i]);
    layers.masteryIcon.setColour(i, base, anim, this.phases[i]);
    layers.frame.setColour(i, frame, anim, this.phases[i]);
    layers.masteryFrame.setColour(i, frame, anim, this.phases[i]);
    layers.effect.setColour(i, frame, anim, this.phases[i]);
    layers.masteryEffect.setColour(i, frame, anim, this.phases[i]);
  }

  // -------------------------------------------------------------------- frame

  private observeResize(): void {
    if (typeof ResizeObserver === 'undefined') return;
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.opts.container);
  }

  resize(): void {
    const rect = this.opts.container.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    this.app.renderer.resize(w, h);
    this.viewport.resize(w, h);
    this.sizeBackdrop();
    this.requestRender();
  }

  private dirty = true;

  private requestRender(): void {
    this.dirty = true;
  }

  start(): void {
    if (this.running || this.destroyed) return;
    this.running = true;
    this.lastTime = performance.now();
    const loop = (now: number) => {
      if (!this.running) return;
      this.rafId = requestAnimationFrame(loop);
      this.tick(now);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  private tick(now: number): void {
    const dt = Math.min(0.1, (now - this.lastTime) / 1000);
    this.lastTime = now;
    this.elapsed += dt;

    const model = this.model;
    if (!model || !this.layers) return;

    const moving = this.viewport.tick(dt);
    const animating = this.animatesContinuously();
    if (this.scaleAnimating) this.stepScales(dt);

    if (model.revision !== this.lastRevision) {
      this.lastRevision = model.revision;
      this.restyle();
      this.dirty = true;
    }
    // Rings carry zoom-dependent detail, so a big zoom change invalidates them.
    if (this.ringLodScale > 0 && Math.abs(Math.log(this.viewport.scale / this.ringLodScale)) > 0.25) {
      this.ringsDirty = true;
    }
    if (this.ringsDirty) {
      this.rebuildRings();
      this.dirty = true;
    }

    if (!this.dirty && !moving && !animating && !this.scaleAnimating) return;

    const t0 = performance.now();

    this.scene.uniforms.uTime = this.elapsed;
    this.world.position.set(
      this.viewport.vw / 2 + this.viewport.x,
      this.viewport.vh / 2 + this.viewport.y,
    );
    this.world.scale.set(this.viewport.scale);

    if (this.backdrop) {
      // The tile is pinned to tree space, so its origin is tree (0,0) — which
      // in screen coordinates is exactly `world.position`.
      this.backdrop.tileScale.set(backdropTileScale(this.viewport.scale));
      this.backdrop.tilePosition.copyFrom(this.world.position);
    }

    this.ascendancyText.update(
      (p, out) => this.viewport.treeToScreen(p, out),
      this.viewport.zoom,
      this.viewport.scale,
    );

    this.rebuildHoverRing();
    this.layers.groups.flush();
    this.layers.connectors.flush();
    this.layers.extras.flush();
    this.layers.jewelArt.flush();
    for (const l of this.artLayers()) l.flush();

    this.app.render();
    this.dirty = false;

    this.frameMs = performance.now() - t0;
    const inst = dt > 0 ? 1 / dt : 60;
    this.fpsSmoothed += (inst - this.fpsSmoothed) * 0.08;

    if (moving) {
      this.emit('viewport', {
        zoom: this.viewport.zoom,
        level: this.viewport.level,
        x: this.viewport.x,
        y: this.viewport.y,
        scale: this.viewport.scale,
      });
    }
    this.emit('frame', {
      fps: this.fpsSmoothed,
      drawnNodes: this.layers.icon.visibleNodes + this.layers.masteryIcon.visibleNodes,
      drawnConnectors: this.layers.connectors.quads,
      ms: this.frameMs,
    });
  }

  /** True while a shader-side animation needs a fresh frame every tick. */
  private animatesContinuously(): boolean {
    if (this.opts.reducedMotion) return false;
    if (this.hoverIndex >= 0) return true;
    const m = this.model;
    return !!m && m.powerVisible && !m.powerStats.done;
  }

  private stepScales(dt: number): void {
    const layers = this.artLayers();
    const k = 1 - Math.exp(-dt / 0.06);
    let moving = false;
    for (let i = 0; i < this.nodeScale.length; i++) {
      const target = this.nodeScaleTarget[i];
      const cur = this.nodeScale[i];
      if (Math.abs(target - cur) < 0.002) {
        if (cur !== target) {
          this.nodeScale[i] = target;
          for (const l of layers) l.setScale(i, target);
        }
        continue;
      }
      const next = cur + (target - cur) * k;
      this.nodeScale[i] = next;
      for (const l of layers) l.setScale(i, next);
      moving = true;
    }
    this.scaleAnimating = moving;
    if (moving) this.dirty = true;
  }

  /** Snapshot for a perf HUD. */
  stats(): {
    nodes: number;
    connectors: number;
    drawnConnectors: number;
    drawCalls: number;
    fps: number;
    frameMs: number;
    grid: ReturnType<SpatialGrid['stats']> | null;
  } {
    const l = this.layers;
    return {
      nodes: this.model?.nodes.length ?? 0,
      connectors: this.model?.geometry.connectors.length ?? 0,
      drawnConnectors: l?.connectors.quads ?? 0,
      drawCalls: l
        ? l.extras.drawCalls +
          l.groups.drawCalls +
          l.connectors.drawCalls +
          l.icon.drawCalls +
          l.frame.drawCalls +
          l.effect.drawCalls +
          l.masteryIcon.drawCalls +
          l.masteryFrame.drawCalls +
          l.masteryEffect.drawCalls +
          4
        : 0,
      fps: this.fpsSmoothed,
      frameMs: this.frameMs,
      grid: this.grid?.stats() ?? null,
    };
  }

  private disposeTree(): void {
    this.ascendancyText.clear();
    this.groupAscendancy = [];
    this.backdrop?.destroy();
    this.backdrop = null;
    if (!this.layers) return;
    this.world.removeChildren();
    for (const l of Object.values(this.layers)) l.destroy();
    this.layers = null;
    this.atlas?.destroy();
    this.atlas = null;
    this.model = null;
    this.grid = null;
    this.hoverIndex = -1;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stop();
    this.unbindInput();
    this.ro?.disconnect();
    this.tooltip?.destroy();
    this.ascendancyText.destroy();
    this.disposeTree();
    this.app.destroy({ removeView: true }, { children: true });
    this.listeners.clear();
  }
}
