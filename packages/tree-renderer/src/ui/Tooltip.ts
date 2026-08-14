import type { JewelItem, JewelMod, ModKind, NodePower, TreeNode } from '../types';
import type { AllocState } from '../types';

const STYLE_ID = 'poe-tree-tooltip-style';

/**
 * PoB's own item palette (`Data/Global.lua:7-60`), kept exact.
 *
 * These are not decoration — players read rarity and mod provenance by colour,
 * and a crafted mod that renders the same as a rolled one is a lie about the
 * item. `normal` is deliberately absent: it inherits the tooltip's stat colour.
 */
const RARITY_COLOUR: Record<string, string> = {
  NORMAL: '#c8c8c8',
  MAGIC: '#8888ff',
  RARE: '#ffff77',
  UNIQUE: '#af6025',
};

const MOD_COLOUR: Partial<Record<ModKind, string>> = {
  disabled: '#7f7f7f',
  unsupported: '#f05050',
  fractured: '#a29160',
  crafted: '#b8daf1',
  mutated: '#cd2285',
  scourge: '#ff6e25',
  custom: '#5cf0bb',
  crucible: '#ffa500',
};

const CSS = `
.poe-tt {
  position: absolute;
  z-index: 20;
  pointer-events: none;
  max-width: 22rem;
  min-width: 12rem;
  padding: 0;
  border-radius: 10px;
  background: color-mix(in oklab, #10141d 92%, transparent);
  border: 1px solid #262e3f;
  box-shadow: 0 12px 34px -8px rgba(0,0,0,.75), 0 0 0 1px rgba(255,255,255,.02) inset;
  backdrop-filter: blur(9px) saturate(1.2);
  color: #d7deeb;
  font: 400 12.5px/1.5 ui-sans-serif, -apple-system, "Segoe UI", Inter, system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
  opacity: 0;
  transform: translate3d(0, 3px, 0);
  transition: opacity .11s ease-out, transform .11s ease-out;
  overflow: hidden;
}
.poe-tt[data-open="1"] { opacity: 1; transform: translate3d(0,0,0); }
.poe-tt__head { padding: 9px 12px 8px; border-bottom: 1px solid #1d2432; }
.poe-tt__name { font-size: 14px; font-weight: 600; letter-spacing: -.01em; color: #f2f5fa; }
.poe-tt__meta { display: flex; gap: 6px; align-items: center; margin-top: 4px; flex-wrap: wrap; }
.poe-tt__tag {
  font-size: 10px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase;
  padding: 2px 6px; border-radius: 999px; background: #1b2231; color: #8ea0bd;
}
.poe-tt__tag[data-k="keystone"] { background: #3a2a16; color: #f0b060; }
.poe-tt__tag[data-k="notable"]  { background: #2b2540; color: #b79cf5; }
.poe-tt__tag[data-k="mastery"]  { background: #16303a; color: #6fd0e6; }
.poe-tt__tag[data-k="socket"]   { background: #143026; color: #62d69c; }
.poe-tt__tag[data-alloc="allocated"] { background: #3a2f14; color: #ffd98a; }
.poe-tt__tag[data-alloc="path"] { background: #16283c; color: #7fc4ff; }
.poe-tt__stats { margin: 0; padding: 8px 12px; list-style: none; display: grid; gap: 3px; }
.poe-tt__stats li { color: #93b7e8; }
.poe-tt__stats li::marker { content: ''; }
.poe-tt__rows { padding: 7px 12px 9px; border-top: 1px solid #1d2432; display: grid; gap: 4px; }
.poe-tt__row { display: flex; justify-content: space-between; gap: 12px; font-variant-numeric: tabular-nums; }
.poe-tt__row span:first-child { color: #7d8aa1; }
.poe-tt__row span:last-child { color: #e6ecf6; font-weight: 550; }
.poe-tt__bar { height: 3px; border-radius: 2px; background: #1d2432; overflow: hidden; margin-top: 2px; }
.poe-tt__bar > i { display: block; height: 100%; border-radius: 2px; }
.poe-tt__extra { padding: 8px 12px; border-top: 1px solid #1d2432; background: #0d1119; }
.poe-tt__extra:empty { display: none; }
.poe-tt__pending { color: #8792a6; font-style: italic; }
.poe-tt__delta-pos { color: #5fdc98; }
.poe-tt__delta-neg { color: #ff7b83; }
`;

function ensureStyle(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

export interface TooltipData {
  node: TreeNode;
  alloc: AllocState;
  power?: NodePower;
  /** 0..1 rank among everything scored so far. */
  percentile?: number | null;
  /** Power mode is on but this node has not been scored. */
  pending?: boolean;
  /** Colour for the heat bar, as CSS. */
  heatCss?: string;
  /** Path cost from the engine, when known. */
  pathCost?: number | null;
  /**
   * The jewel socketed here. PoB replaces a socket's tooltip with the whole
   * item (`PassiveTreeView.lua:1478-1484`) rather than showing "Jewel Socket".
   */
  jewel?: JewelItem;
}

/**
 * DOM tooltip.
 *
 * Text stays in the DOM rather than the canvas on purpose: subpixel-hinted
 * system font rendering at any zoom, selectable-by-devtools markup, and no
 * font atlas to keep in sync. It is `pointer-events: none` so it can never
 * steal a click from the tree.
 */
export class Tooltip {
  readonly el: HTMLDivElement;
  private readonly host: HTMLElement;
  private extraEl: HTMLDivElement;
  private open = false;
  private currentId: number | null = null;
  private suppressed = false;

  constructor(host: HTMLElement) {
    ensureStyle();
    this.host = host;
    this.el = document.createElement('div');
    this.el.className = 'poe-tt';
    this.el.setAttribute('role', 'tooltip');
    this.extraEl = document.createElement('div');
    this.extraEl.className = 'poe-tt__extra';
    host.appendChild(this.el);
  }

  get nodeId(): number | null {
    return this.currentId;
  }

  /**
   * Hold the tooltip closed while something else owns the pointer — the
   * mastery chooser, which opens over the node you are still hovering. The
   * tooltip is `pointer-events: none`, so hovering the chooser does not move
   * the cursor off the node and the tooltip stays up, spilling its stat lines
   * out from under the panel.
   */
  setSuppressed(on: boolean): void {
    if (this.suppressed === on) return;
    this.suppressed = on;
    if (on) this.hide();
  }

  get isSuppressed(): boolean {
    return this.suppressed;
  }

  show(data: TooltipData, x: number, y: number): void {
    if (this.suppressed) return;
    if (data.node.id !== this.currentId) {
      this.render(data);
      this.currentId = data.node.id;
    }
    this.position(x, y);
    if (!this.open) {
      this.open = true;
      this.el.dataset.open = '1';
    }
  }

  hide(): void {
    if (!this.open) return;
    this.open = false;
    this.currentId = null;
    this.el.dataset.open = '0';
  }

  /**
   * Slot the application owns — live stat deltas from the engine land here.
   * Safe to call while the tooltip is open; it does not re-render the rest.
   */
  setExtra(content: string | HTMLElement | null): void {
    if (content == null) {
      this.extraEl.replaceChildren();
      return;
    }
    if (typeof content === 'string') this.extraEl.innerHTML = content;
    else this.extraEl.replaceChildren(content);
  }

  /**
   * A socketed jewel, in place of the node's own name and stats.
   *
   * PoB does exactly this substitution: a socket with a jewel in it shows the
   * item, not the socket (`PassiveTreeView.lua:1478-1484`). Mod groups are
   * separated by a rule the way `AddItemTooltip` separates them.
   */
  private renderJewel(item: JewelItem): DocumentFragment {
    const frag = document.createDocumentFragment();

    const head = document.createElement('div');
    head.className = 'poe-tt__head';
    const name = document.createElement('div');
    name.className = 'poe-tt__name';
    name.textContent = item.name;
    const colour = item.rarity ? RARITY_COLOUR[item.rarity] : undefined;
    if (colour) name.style.color = colour;
    head.appendChild(name);
    if (item.base) {
      const base = document.createElement('div');
      base.className = 'poe-tt__name';
      base.textContent = item.base;
      if (colour) base.style.color = colour;
      head.appendChild(base);
    }

    const meta = document.createElement('div');
    meta.className = 'poe-tt__meta';
    for (const text of [
      item.radiusLabel ? `Radius: ${item.radiusLabel}` : null,
      item.limit ? `Limited to: ${item.limit}` : null,
      item.corrupted ? 'Corrupted' : null,
    ]) {
      if (!text) continue;
      const tag = document.createElement('span');
      tag.className = 'poe-tt__tag';
      tag.textContent = text;
      meta.appendChild(tag);
    }
    if (meta.childElementCount) head.appendChild(meta);
    frag.appendChild(head);

    let group: JewelMod['group'] | null = null;
    let ul: HTMLUListElement | null = null;
    for (const mod of item.mods) {
      if (mod.group !== group || !ul) {
        group = mod.group;
        ul = document.createElement('ul');
        ul.className = 'poe-tt__stats';
        frag.appendChild(ul);
      }
      const li = document.createElement('li');
      li.textContent = mod.line;
      const c = MOD_COLOUR[mod.kind];
      if (c) li.style.color = c;
      ul.appendChild(li);
    }

    for (const node of item.clusterNodes ?? []) {
      const sub = document.createElement('div');
      sub.className = 'poe-tt__head';
      const label = document.createElement('div');
      label.className = 'poe-tt__name';
      label.textContent = node.name;
      label.style.color = MOD_COLOUR.crafted ?? '';
      sub.appendChild(label);
      frag.appendChild(sub);
      if (node.stats.length) {
        const list = document.createElement('ul');
        list.className = 'poe-tt__stats';
        for (const stat of node.stats) {
          const li = document.createElement('li');
          li.textContent = stat;
          list.appendChild(li);
        }
        frag.appendChild(list);
      }
    }

    return frag;
  }

  private render(d: TooltipData): void {
    const n = d.node;
    const head = document.createElement('div');
    head.className = 'poe-tt__head';

    const name = document.createElement('div');
    name.className = 'poe-tt__name';
    name.textContent = n.name || `Node ${n.id}`;
    head.appendChild(name);

    const meta = document.createElement('div');
    meta.className = 'poe-tt__meta';
    const kind = document.createElement('span');
    kind.className = 'poe-tt__tag';
    kind.dataset.k = n.type;
    kind.textContent = n.type;
    meta.appendChild(kind);

    if (d.alloc !== 'unallocated') {
      const a = document.createElement('span');
      a.className = 'poe-tt__tag';
      a.dataset.alloc = d.alloc;
      a.textContent = d.alloc === 'allocated' ? 'allocated' : 'on path';
      meta.appendChild(a);
    }
    if (n.ascendancy) {
      const a = document.createElement('span');
      a.className = 'poe-tt__tag';
      a.textContent = n.ascendancy;
      meta.appendChild(a);
    }
    if (n.synthetic) {
      const a = document.createElement('span');
      a.className = 'poe-tt__tag';
      a.textContent = 'from jewel';
      meta.appendChild(a);
    }
    head.appendChild(meta);

    const frag = document.createDocumentFragment();

    // A socket with a jewel in it shows the jewel, not "Jewel Socket" — the
    // socket's own name and stats say nothing (`PassiveTreeView.lua:1478-1484`).
    // Everything below this, the power and path rows, still applies.
    if (d.jewel) {
      frag.appendChild(this.renderJewel(d.jewel));
    } else {
      frag.appendChild(head);
      if (n.stats?.length) {
        const ul = document.createElement('ul');
        ul.className = 'poe-tt__stats';
        for (const s of n.stats) {
          const li = document.createElement('li');
          li.textContent = s;
          ul.appendChild(li);
        }
        frag.appendChild(ul);
      }
    }

    const rows = document.createElement('div');
    rows.className = 'poe-tt__rows';
    let hasRows = false;

    const addRow = (label: string, value: string, cls?: string) => {
      const r = document.createElement('div');
      r.className = 'poe-tt__row';
      const a = document.createElement('span');
      a.textContent = label;
      const b = document.createElement('span');
      b.textContent = value;
      if (cls) b.className = cls;
      r.append(a, b);
      rows.appendChild(r);
      hasRows = true;
    };

    const cost = d.pathCost ?? d.power?.pathCost ?? null;
    if (cost != null) addRow('Path cost', `${cost} point${cost === 1 ? '' : 's'}`);

    if (d.power) {
      addRow('Value / point', formatNum(d.power.perPoint));
      if (d.power.offence) addRow('Offence', formatNum(d.power.offence));
      if (d.power.defence) addRow('Defence', formatNum(d.power.defence));
      if (d.percentile != null) {
        addRow('Rank', `top ${Math.max(1, Math.round((1 - d.percentile) * 100))}%`);
        const bar = document.createElement('div');
        bar.className = 'poe-tt__bar';
        const fill = document.createElement('i');
        fill.style.width = `${Math.round(d.percentile * 100)}%`;
        fill.style.background = d.heatCss ?? '#7fc4ff';
        bar.appendChild(fill);
        rows.appendChild(bar);
      }
    } else if (d.pending) {
      const p = document.createElement('div');
      p.className = 'poe-tt__row poe-tt__pending';
      p.textContent = 'Not evaluated yet';
      rows.appendChild(p);
      hasRows = true;
    }

    if (hasRows) frag.appendChild(rows);
    frag.appendChild(this.extraEl);

    this.el.replaceChildren(frag);
  }

  /** Keep the tooltip inside the host box, flipping sides when it would clip. */
  private position(x: number, y: number): void {
    const pad = 14;
    const hostRect = this.host.getBoundingClientRect();
    const w = this.el.offsetWidth || 240;
    const h = this.el.offsetHeight || 120;
    let left = x + pad;
    let top = y + pad;
    if (left + w > hostRect.width - 8) left = x - w - pad;
    if (top + h > hostRect.height - 8) top = y - h - pad;
    left = Math.max(8, Math.min(left, hostRect.width - w - 8));
    top = Math.max(8, Math.min(top, hostRect.height - h - 8));
    // left/top rather than transform: `transform` is reserved for the open
    // transition, and mixing the two cancels the slide-in.
    this.el.style.left = `${Math.round(left)}px`;
    this.el.style.top = `${Math.round(top)}px`;
  }

  destroy(): void {
    this.el.remove();
  }
}

function formatNum(v: number): string {
  const a = Math.abs(v);
  if (a >= 1000) return v.toFixed(0);
  if (a >= 100) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  return v.toFixed(3);
}
