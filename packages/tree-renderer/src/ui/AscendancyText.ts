/**
 * Ported from Path of Building Community.
 *
 *   src/Classes/PassiveTreeView.lua — ascendancy flavour text inside
 *                                     `renderGroup` (596-625): anchor re-basing,
 *                                     the 2.5 zoom cutoff, `52 * scale` font
 *                                     size, LEFT alignment, "FONTIN ITALIC",
 *                                     and the halved colour bytes for an
 *                                     ascendancy that is not selected.
 *
 * Copyright (c) 2016 David Gowor and contributors. MIT — see NOTICE.md.
 *
 * PoB draws this with an immediate-mode `DrawString`. Here it is DOM, for the
 * same reason as the tooltip: real font rendering at any zoom and no glyph
 * atlas to keep in sync with the sheet loader.
 */
import { FLAVOUR_TEXT_FONT_SIZE, FLAVOUR_TEXT_MIN_ZOOM, dimFlavourColour } from '../pob/nodeArt';
import type { Point } from '../types';

const STYLE_ID = 'poe-tree-flavour-style';

const CSS = `
.poe-flavour {
  position: absolute;
  inset: 0;
  z-index: 5;
  pointer-events: none;
  overflow: hidden;
}
.poe-flavour > i {
  position: absolute;
  left: 0;
  top: 0;
  display: block;
  /* PoB keeps the leading spaces and embedded newlines verbatim. */
  white-space: pre;
  font-style: italic;
  font-weight: 400;
  font-family: "Fontin", "Fontin SmallCaps", Georgia, "Times New Roman", serif;
  line-height: 1.15;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.85);
  transform-origin: 0 0;
  will-change: transform;
}
`;

function ensureStyle(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

export interface FlavourLabel {
  /** Ascendancy id, matched against the selected set. */
  id: string;
  /** Tree-space anchor of the text's top-left corner. */
  x: number;
  y: number;
  text: string;
  /** Six hex digits, no leading '#'. */
  colour: string;
}

interface Entry {
  label: FlavourLabel;
  el: HTMLElement;
  dim: string;
  lastSelected: boolean | null;
}

/**
 * The italic flavour line painted across each ascendancy wheel.
 *
 * Hidden below `FLAVOUR_TEXT_MIN_ZOOM` exactly as PoB hides it: at fit-to-screen
 * zoom the text would be a single illegible smear over the whole tree.
 */
export class AscendancyText {
  readonly el: HTMLDivElement;
  private entries: Entry[] = [];
  private selected: ReadonlySet<string> = new Set();
  private visible = false;

  constructor(host: HTMLElement) {
    ensureStyle();
    this.el = document.createElement('div');
    this.el.className = 'poe-flavour';
    this.el.hidden = true;
    host.appendChild(this.el);
  }

  setLabels(labels: readonly FlavourLabel[]): void {
    this.entries = labels.map((label) => {
      const el = document.createElement('i');
      el.textContent = label.text;
      return { label, el, dim: dimFlavourColour(label.colour), lastSelected: null };
    });
    this.el.replaceChildren(...this.entries.map((e) => e.el));
  }

  /** Ascendancy ids drawn at full brightness; everything else is halved. */
  setSelected(ids: ReadonlySet<string>): void {
    this.selected = ids;
    for (const e of this.entries) e.lastSelected = null;
  }

  /**
   * @param project  tree-space -> CSS px, relative to the host box.
   * @param zoom     PoB's `1.2 ^ level`, compared against the 2.5 cutoff.
   * @param scale    tree-space -> CSS px scale, for the `52 * scale` font size.
   */
  update(project: (p: Point, out: Point) => Point, zoom: number, scale: number): void {
    const show = this.entries.length > 0 && zoom >= FLAVOUR_TEXT_MIN_ZOOM;
    if (show !== this.visible) {
      this.visible = show;
      this.el.hidden = !show;
    }
    if (!show) return;

    const out: Point = { x: 0, y: 0 };
    const size = FLAVOUR_TEXT_FONT_SIZE * scale;
    for (const e of this.entries) {
      project(e.label, out);
      e.el.style.transform = `translate(${out.x.toFixed(1)}px, ${out.y.toFixed(1)}px)`;
      e.el.style.fontSize = `${size.toFixed(2)}px`;
      const sel = this.selected.has(e.label.id);
      if (sel !== e.lastSelected) {
        e.lastSelected = sel;
        e.el.style.color = `#${sel ? e.label.colour : e.dim}`;
      }
    }
  }

  clear(): void {
    this.entries = [];
    this.el.replaceChildren();
    this.visible = false;
    this.el.hidden = true;
  }

  destroy(): void {
    this.el.remove();
  }
}
