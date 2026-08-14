/**
 * Ported from Path of Building Community.
 *
 *   src/Classes/PassiveTree.lua      — `nodeOverlay` table (~line 423),
 *                                      hit radius `artWidth * 1.33` (470-474),
 *                                      `ProcessNode` sprite assignment (852-870).
 *   src/Classes/PassiveTreeView.lua  — node base/overlay/effect selection inside
 *                                      `Draw()` (805-900), connector `getState`
 *                                      (663-673), `GetCompareNodeColor` (166-185),
 *                                      `DrawAsset` sizing incl. its `isHalf`
 *                                      branch (1276-1294), group backdrop
 *                                      selection (628-635), ascendancy flavour
 *                                      text placement (596-625),
 *                                      draw-layer bands (`SetDrawLayer` calls).
 *
 * Copyright (c) 2016 David Gowor and contributors. MIT — see NOTICE.md.
 *
 * This is Lua immediate-mode drawing rewritten for retained-mode PixiJS, so the
 * shape differs: the tables, the state machine and the ordering are ported
 * faithfully, the `DrawImage` calls are replaced by variant selection against
 * the sprite refs our schema delivers.
 */

import type { AllocState, TreeNode, TreeNodeType } from '../types';

// ---------------------------------------------------------------------------
// PassiveTree.lua — sizing

/**
 * PoB scales every tree asset by 1.33 (`DrawAsset`, PassiveTreeView.lua:1287),
 * and derives a node's hit radius as `artWidth * 1.33` (PassiveTree.lua:470).
 */
export const ART_SCALE = 1.33;

/**
 * Tree units covered by a sprite `w` pixels wide.
 *
 * `DrawAsset` computes `width = data.width * scale * ART_SCALE` and then draws
 * into `(x - width, y - height, width * 2, height * 2)` — so the on-screen size
 * is twice that, and the tree-space size is `w * ART_SCALE * 2`.
 */
export function spriteTreeSize(w: number): number {
  return w * ART_SCALE * 2;
}

/** An axis-aligned box in tree units. */
export interface AssetRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * `DrawAsset`'s rectangle, in tree units (PassiveTreeView.lua:1276-1294).
 *
 * ```lua
 * local width  = data.width  * scale * 1.33
 * local height = data.height * scale * 1.33
 * DrawImage(data.handle, x - width, y - height, width * 2, height * 2, unpack(data))
 * ```
 *
 * So the asset is *centred* on (x, y) with a half-extent of `w * 1.33` — the
 * drawn box is `w * 2 * 1.33` across, matching {@link spriteTreeSize}. Using
 * `w / 2` instead leaves the art at 3/8 of its size: a 499px `Classes*` backdrop
 * draws 499 units wide rather than 1327, so the ascendancy ring of nodes ends up
 * outside its own wheel, and an ordinary `PSGroupBackground` shrinks to a speck
 * at the group origin.
 */
export function drawAssetRect(x: number, y: number, w: number, h: number): AssetRect {
  const hw = w * ART_SCALE;
  const hh = h * ART_SCALE;
  return { x0: x - hw, y0: y - hh, x1: x + hw, y1: y + hh };
}

/**
 * How many screen pixels one pixel of the tiled backdrop covers, at a given
 * viewport scale (PassiveTreeView.lua:542).
 *
 * ```lua
 * local bgSize = bg.width * scale * 1.33 * 2.5
 * ```
 *
 * `bgSize` is the on-screen size of one whole tile, so dividing out the tile's
 * own width leaves the per-pixel factor: the usual {@link ART_SCALE}, times a
 * further 2.5 that keeps the 256px texture from reading as a fine grid when the
 * tree is zoomed out. Unlike every other asset the backdrop is drawn in *screen*
 * space with scrolling UVs, so this is a texture scale rather than a rectangle.
 */
export const BACKDROP_TILE_ZOOM = 2.5;

/**
 * The painted class illustration, per base class (PassiveTreeView.lua:546-566).
 *
 * PoB draws exactly **one** of these — the class you are currently playing —
 * centred on a hardcoded tree coordinate, and Scion (class 0) gets none. Its
 * own comment calls this a hack: *"the position data doesn't seem to be in the
 * tree JSON yet"*.
 *
 * The position data is in fact shipped, as `sprites.lua`'s `extraImages`, with
 * a coordinate for all six. Drawing from that instead is tempting and wrong:
 * it puts every class's art on screen at once, so a Scion sees the Marauder and
 * Witch illustrations too, and at coordinates PoB never uses. Nothing in PoB
 * reads `extraImages` — outside `src/Export/` it appears in no source file.
 *
 * So this is PoB's table, verbatim, keyed by class name rather than the raw
 * class id.
 */
export interface ClassBackground {
  /** Key into `geometry.sprites`. */
  asset: string;
  x: number;
  y: number;
}

const CLASS_BACKGROUNDS: Record<string, ClassBackground> = {
  Marauder: { asset: 'BackgroundStr', x: -2750, y: 1600 },
  Ranger: { asset: 'BackgroundDex', x: 2550, y: 1600 },
  Witch: { asset: 'BackgroundInt', x: -250, y: -2200 },
  Duelist: { asset: 'BackgroundStrDex', x: -150, y: 2350 },
  Templar: { asset: 'BackgroundStrInt', x: -2100, y: -1500 },
  Shadow: { asset: 'BackgroundDexInt', x: 2350, y: -1950 },
};

/** The illustration for a class, or null — Scion and unknowns have none. */
export function classBackground(className: string | null | undefined): ClassBackground | null {
  if (!className) return null;
  return CLASS_BACKGROUNDS[className] ?? null;
}

export function backdropTileScale(viewportScale: number): number {
  return viewportScale * ART_SCALE * BACKDROP_TILE_ZOOM;
}

/**
 * `DrawAsset`'s `isHalf` branch, used for `PSGroupBackground3` and
 * `GroupBackgroundLargeHalfAlt` (PassiveTreeView.lua:1288-1290).
 *
 * ```lua
 * DrawImage(handle, x - width, y - height * 2, width * 2, height * 2)
 * DrawImage(handle, x - width, y,             width * 2, height * 2, 0, 1, 1, 0)
 * ```
 *
 * The art only holds the top half of the backdrop, so it is drawn twice around
 * y — the second copy V-flipped, which is what the `0, 1, 1, 0` texture
 * coordinates do. Returned top-first; the second rect must sample V inverted.
 */
export function drawAssetHalfRects(x: number, y: number, w: number, h: number): [AssetRect, AssetRect] {
  const hw = w * ART_SCALE;
  const hh = h * ART_SCALE;
  return [
    { x0: x - hw, y0: y - hh * 2, x1: x + hw, y1: y },
    { x0: x - hw, y0: y, x1: x + hw, y1: y + hh * 2 },
  ];
}

/** Group backdrops whose art is only the top half (PassiveTreeView.lua:632-633). */
export const HALF_GROUP_BACKGROUNDS: ReadonlySet<string> = new Set([
  'PSGroupBackground3',
  'GroupBackgroundLargeHalfAlt',
]);

// ---------------------------------------------------------------------------
// PassiveTreeView.lua:596-625 — ascendancy flavour text

/** Below this zoom (`1.2 ^ level`) PoB does not draw the flavour text at all. */
export const FLAVOUR_TEXT_MIN_ZOOM = 2.5;
/** Font size in tree-to-screen scale units: `DrawString(..., 52 * scale, ...)`. */
export const FLAVOUR_TEXT_FONT_SIZE = 52;

/**
 * Flavour text anchor relative to the ascendancy start group, in tree units.
 *
 * ```lua
 * local offsetX = rect.x - (isAlternateAscendancy and 744 or 650)
 * local offsetY = rect.y - (isAlternateAscendancy and 706 or 650)
 * ```
 *
 * The constants are half the drawn art size: normal ascendancy backdrops are
 * 1300x1300 and the alternate (bloodline) ones 1488x1412, so `flavourTextRect`
 * — which is expressed from the art's top-left corner — is re-based onto the
 * group origin. The text is drawn LEFT-aligned from this point.
 */
export function flavourTextOffset(
  rect: { x: number; y: number },
  alternate = false,
): { x: number; y: number } {
  return {
    x: rect.x - (alternate ? 744 : 650),
    y: rect.y - (alternate ? 706 : 650),
  };
}

/**
 * PoB halves each colour byte of an unselected ascendancy's flavour text:
 * `string.format("^x%02X%02X%02X", floor(r * 0.5), floor(g * 0.5), floor(b * 0.5))`.
 */
export function dimFlavourColour(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const v = parseInt(m[1], 16);
  const half = (c: number) => Math.floor(c * 0.5);
  return [half((v >> 16) & 0xff), half((v >> 8) & 0xff), half(v & 0xff)]
    .map((c) => c.toString(16).padStart(2, '0').toUpperCase())
    .join('');
}

/** PoB's frame-art table. Keys are its own, not our schema's. */
export interface NodeOverlayEntry {
  artWidth: number;
  alloc: string;
  path: string;
  unalloc: string;
  allocAscend?: string;
  pathAscend?: string;
  unallocAscend?: string;
  allocBlighted?: string;
  pathBlighted?: string;
  unallocBlighted?: string;
  allocAlt?: string;
  pathAlt?: string;
  unallocAlt?: string;
}

/**
 * `PassiveTree.lua:423`, transcribed. The 3.10+ asset names are used; the
 * pre-3.10 `PassiveSkillScreen*` aliases are dropped because the host only
 * ships trees we support.
 */
export const NODE_OVERLAY: Record<string, NodeOverlayEntry> = {
  Normal: {
    artWidth: 40,
    alloc: 'PSSkillFrameActive',
    path: 'PSSkillFrameHighlighted',
    unalloc: 'PSSkillFrame',
    allocAscend: 'AscendancyFrameSmallAllocated',
    pathAscend: 'AscendancyFrameSmallCanAllocate',
    unallocAscend: 'AscendancyFrameSmallNormal',
  },
  Notable: {
    artWidth: 58,
    alloc: 'NotableFrameAllocated',
    path: 'NotableFrameCanAllocate',
    unalloc: 'NotableFrameUnallocated',
    allocAscend: 'AscendancyFrameLargeAllocated',
    pathAscend: 'AscendancyFrameLargeCanAllocate',
    unallocAscend: 'AscendancyFrameLargeNormal',
    allocBlighted: 'BlightedNotableFrameAllocated',
    pathBlighted: 'BlightedNotableFrameCanAllocate',
    unallocBlighted: 'BlightedNotableFrameUnallocated',
  },
  Keystone: {
    artWidth: 84,
    alloc: 'KeystoneFrameAllocated',
    path: 'KeystoneFrameCanAllocate',
    unalloc: 'KeystoneFrameUnallocated',
    allocBlighted: 'KeystoneFrameAllocated',
    pathBlighted: 'KeystoneFrameCanAllocate',
    unallocBlighted: 'KeystoneFrameUnallocated',
  },
  Socket: {
    artWidth: 58,
    alloc: 'JewelFrameAllocated',
    path: 'JewelFrameCanAllocate',
    unalloc: 'JewelFrameUnallocated',
    allocAlt: 'JewelSocketAltActive',
    pathAlt: 'JewelSocketAltCanAllocate',
    unallocAlt: 'JewelSocketAltNormal',
  },
  Mastery: {
    artWidth: 65,
    alloc: 'AscendancyFrameLargeAllocated',
    path: 'AscendancyFrameLargeCanAllocate',
    unalloc: 'AscendancyFrameLargeNormal',
  },
};

/** Our schema's lower-case node types → PoB's capitalised keys. */
export const POB_TYPE: Record<TreeNodeType, string> = {
  normal: 'Normal',
  notable: 'Notable',
  keystone: 'Keystone',
  mastery: 'Mastery',
  socket: 'Socket',
  classStart: 'ClassStart',
  // PoB's nodeOverlay has no entry for either start type — they are drawn from
  // dedicated background art, not a node frame — but the mapping has to be
  // total, and the capitalised names are what PoB calls them.
  ascendClassStart: 'AscendClassStart',
  ascendancy: 'Normal',
};

/**
 * `size = artWidth * 1.33` (PassiveTree.lua:470-474), which PoB squares into
 * `rsq` for its hit test. Returns 0 for types with no frame entry.
 */
export function pobHitRadius(type: TreeNodeType): number {
  const entry = NODE_OVERLAY[POB_TYPE[type]];
  return entry ? entry.artWidth * ART_SCALE : 0;
}

// ---------------------------------------------------------------------------
// PassiveTreeView.lua — draw layers

/**
 * `SetDrawLayer` bands, verbatim. Higher draws later. Masteries deliberately
 * sit *below* the connectors; everything else about the ordering follows.
 */
export const DRAW_LAYER = {
  background: 0,
  groupBackground: 10,
  mastery: 15,
  masteryEffect: 15,
  connector: 20,
  node: 25,
  highlight: 30,
  jewelRadius: 30,
  tooltipShade: 99,
  tooltip: 100,
} as const;

// ---------------------------------------------------------------------------
// PassiveTreeView.lua:663-673 — connector state

export type PobConnectorState = 'Normal' | 'Intermediate' | 'Active';

export interface ConnectorStateInput {
  aAlloc: boolean;
  bAlloc: boolean;
  /** True when a path preview is being shown at all. */
  hoverPathActive: boolean;
  aOnHoverPath: boolean;
  bOnHoverPath: boolean;
}

/**
 * ```lua
 * local state = "Normal"
 * if n1.alloc and n2.alloc then state = "Active"
 * elseif hoverPath then
 *   if (n1.alloc or n1 == hoverNode or hoverPath[n1])
 *      and (n2.alloc or n2 == hoverNode or hoverPath[n2]) then
 *     state = "Intermediate"
 *   end
 * end
 * ```
 * The hovered node itself counts as on the path, which is why hovering a
 * candidate lights the whole route rather than stopping one link short.
 */
export function pobConnectorState(i: ConnectorStateInput): PobConnectorState {
  if (i.aAlloc && i.bAlloc) return 'Active';
  if (i.hoverPathActive) {
    const a = i.aAlloc || i.aOnHoverPath;
    const b = i.bAlloc || i.bOnHoverPath;
    if (a && b) return 'Intermediate';
  }
  return 'Normal';
}

export function toAllocState(s: PobConnectorState): AllocState {
  return s === 'Active' ? 'allocated' : s === 'Intermediate' ? 'path' : 'unallocated';
}

// ---------------------------------------------------------------------------
// PassiveTreeView.lua:805-900 — node art selection

export type PobFrameState = 'alloc' | 'path' | 'unalloc';

export interface ArtSelectionInput {
  /** `node.alloc or grantedPassives[id] or (compareNode and compareNode.alloc)`. */
  isAlloc: boolean;
  /** `self.showHeatMap`. */
  showHeatMap: boolean;
  /** `node == hoverNode`. */
  isHovered: boolean;
  /** `hoverPath and hoverPath[node]`. */
  onHoverPath: boolean;
  /** `self.traceMode and node == self.tracePath[#self.tracePath]`. */
  isTraceEnd?: boolean;
}

/**
 * ```lua
 * if self.showHeatMap or isAlloc or node == hoverNode
 *    or (self.traceMode and node == self.tracePath[#self.tracePath]) then
 *   state = "alloc"          -- "Show node as allocated if it is being hovered over
 *                            --  Also if the heat map is turned on (makes the nodes more visible)"
 * elseif hoverPath and hoverPath[node] then
 *   state = "path"
 * else
 *   state = "unalloc"
 * end
 * ```
 *
 * The heatmap branch is not a bug: PoB deliberately promotes every node to the
 * bright frame while the map is up, because a dim frame swallows the colour it
 * is trying to show.
 */
export function pobFrameState(i: ArtSelectionInput): PobFrameState {
  if (i.showHeatMap || i.isAlloc || i.isHovered || i.isTraceEnd) return 'alloc';
  if (i.onHoverPath) return 'path';
  return 'unalloc';
}

/**
 * The frame asset key, from the `nodeOverlay` lookup in `Draw()`:
 * `overlayKey = state .. (node.ascendancyName and "Ascend" or "")
 *                     .. (node.isBlighted and "Blighted" or "")`
 * and, for sockets, `state .. (node.expansionJewel and "Alt" or "")`.
 */
export function pobOverlayKey(
  state: PobFrameState,
  opts: { ascendancy?: boolean; blighted?: boolean; expansionJewel?: boolean } = {},
): string {
  if (opts.expansionJewel) return `${state}Alt`;
  return `${state}${opts.ascendancy ? 'Ascend' : ''}${opts.blighted ? 'Blighted' : ''}`;
}

export function pobOverlayAsset(type: TreeNodeType, key: string): string | undefined {
  const entry = NODE_OVERLAY[POB_TYPE[type]];
  if (!entry) return undefined;
  return (entry as unknown as Record<string, string | undefined>)[key] ?? entry[
    key.replace(/(Ascend|Blighted|Alt)$/, '') as 'alloc' | 'path' | 'unalloc'
  ];
}

/** What `Draw()` decided to put on screen for one node. */
export interface NodeArtPlan {
  /** The node's own icon. `null` for a ClassStart, which is frame-only. */
  icon: 'active' | 'inactive' | null;
  /** The frame around it, or null when the node type has none. */
  frame: PobFrameState | null;
  /** Whether the mastery/tattoo effect glow is drawn. */
  effect: boolean;
  /** `SetDrawLayer` band for the icon. */
  layer: number;
  /**
   * Sockets draw the *frame* as their base art and reserve the overlay slot for
   * the socketed jewel, so the renderer must not also draw an icon under it.
   */
  frameIsBase: boolean;
}

export interface NodePlanInput extends ArtSelectionInput {
  type: TreeNodeType;
  /** Mastery only: an effect has been chosen (PassiveSpec.lua:283). */
  masteryChosen?: boolean;
  /** Mastery only: the node offers a chooser at all. */
  hasMasteryEffects?: boolean;
  /** Tattooed node with `effectSprites`. */
  isTattoo?: boolean;
}

/**
 * The whole of `Draw()`'s per-node art decision, 805-900, as one pure function.
 *
 * Mapping onto our schema, which flattens PoB's sprite map:
 *   `sprites[type..(isAlloc and "Active" or "Inactive")]` → `icon.active` / `icon.inactive`
 *   `node.overlay[overlayKey]`                            → `frame.allocated` / `.path` / `.unallocated`
 *   `masterySprites.activeEffectImage.masteryActiveEffect` → `effect`
 *
 * One PoB variant has no home in the schema: a mastery under the cursor uses
 * `masteryConnected`, a third icon between inactive and active-selected. We
 * render the inactive icon with the hover pulse instead, which is the closest
 * the contract allows.
 */
export function planNodeArt(i: NodePlanInput): NodeArtPlan {
  const state = pobFrameState(i);

  if (i.type === 'classStart') {
    // `overlay = isAlloc and node.startArt or "PSStartNodeBackgroundInactive"` —
    // no base art at all.
    return { icon: null, frame: state, effect: false, layer: DRAW_LAYER.node, frameIsBase: true };
  }

  if (i.type === 'socket') {
    // `base = tree.assets[node.overlay[state .. (expansionJewel and "Alt" or "")]]`
    // The frame *is* the base; the overlay slot belongs to the socketed jewel.
    return { icon: null, frame: state, effect: false, layer: DRAW_LAYER.node, frameIsBase: true };
  }

  if (i.type === 'mastery') {
    // `SetDrawLayer(nil, 15)` — masteries render beneath the connectors.
    if (i.hasMasteryEffects) {
      const chosen = i.isAlloc && i.masteryChosen !== false;
      return {
        icon: chosen ? 'active' : 'inactive',
        frame: state,
        effect: chosen,
        layer: DRAW_LAYER.mastery,
        frameIsBase: false,
      };
    }
    // A mastery with no effects uses the plain `mastery` sprite and never glows.
    return {
      icon: 'inactive',
      frame: state,
      effect: false,
      layer: DRAW_LAYER.mastery,
      frameIsBase: false,
    };
  }

  // Normal, notable, keystone, ascendancy.
  return {
    icon: i.isAlloc ? 'active' : 'inactive',
    frame: state,
    effect: !!i.isTattoo && i.isAlloc,
    layer: DRAW_LAYER.node,
    frameIsBase: false,
  };
}

/** Map PoB's frame state onto our schema's `frame` keys. */
export function frameFieldFor(state: PobFrameState): 'allocated' | 'path' | 'unallocated' {
  return state === 'alloc' ? 'allocated' : state === 'path' ? 'path' : 'unallocated';
}

// ---------------------------------------------------------------------------
// PassiveTreeView.lua:166-185 — compare colouring

export type PobCompareResult = 'same' | 'added' | 'removed' | 'changed';

/**
 * ```lua
 * if compareNode.alloc and not node.alloc then return 0, 1, 0   -- green
 * elseif not compareNode.alloc and node.alloc then return 1, 0, 0 -- red
 * elseif node.type == "Mastery" and both alloc and node.sd ~= compareNode.sd then return 0, 0, 1
 * elseif node.type == "Socket" and both alloc and jewels differ then return 0, 0, 1
 * end
 * ```
 *
 * The blue "changed" case is easy to miss and matters: a mastery allocated in
 * both builds but with a *different effect chosen* is a real difference, and
 * colouring it the same as "unchanged" hides it.
 */
export function pobCompareNodeColour(args: {
  type: TreeNodeType;
  baseAlloc: boolean;
  otherAlloc: boolean;
  /** Mastery: the chosen effect differs. Socket: the socketed jewel differs. */
  contentsDiffer?: boolean;
}): PobCompareResult {
  if (args.otherAlloc && !args.baseAlloc) return 'added';
  if (!args.otherAlloc && args.baseAlloc) return 'removed';
  if (
    args.baseAlloc &&
    args.otherAlloc &&
    args.contentsDiffer &&
    (args.type === 'mastery' || args.type === 'socket')
  ) {
    return 'changed';
  }
  return 'same';
}

// ---------------------------------------------------------------------------
// PassiveTreeView.lua:1323 — search

/**
 * `DoesNodeMatchSearchParams`, ported.
 *
 * Every term must match somewhere: the node name first, then each stat line,
 * then the node type. Quoted phrases match literally; everything else is a
 * substring match (PoB uses `matchOrPattern`, which falls back to a plain find
 * when the Lua pattern fails to compile).
 *
 * Class starts and masteries with no effects are skipped outright, exactly as
 * PoB does — they are not things you can search for.
 */
export function parseSearchQuery(query: string): string[] {
  const terms: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(query)) !== null) {
    const t = (m[1] ?? m[2] ?? '').trim().toLowerCase();
    if (t) terms.push(t);
  }
  return terms;
}

export function nodeMatchesSearch(node: TreeNode, terms: readonly string[]): boolean {
  if (!terms.length) return false;
  if (node.type === 'classStart') return false;
  if (node.type === 'mastery' && !node.masteryEffects?.length) return false;

  const need = new Set(terms);
  const consume = (haystack: string) => {
    if (!haystack) return;
    const h = haystack.toLowerCase();
    for (const t of [...need]) if (h.includes(t)) need.delete(t);
  };

  consume(node.name);
  if (!need.size) return true;
  for (const line of node.stats ?? []) {
    consume(line);
    if (!need.size) return true;
  }
  // Masteries are searchable through the effects their chooser offers.
  for (const eff of node.masteryEffects ?? []) {
    for (const line of eff.stats) {
      consume(line);
      if (!need.size) return true;
    }
  }
  consume(node.type);
  return need.size === 0;
}
