import type { MasteryEffect, NodeId, TreeNode } from '../types';

const STYLE_ID = 'poe-mastery-chooser-style';

/**
 * Deliberately a separate component from `Tooltip`, not an extension of it.
 *
 * The tooltip follows the cursor and is `pointer-events: none` so it can never
 * steal a click from the tree — which makes it structurally incapable of
 * holding a control. Path of Building splits these the same way: hovering a
 * mastery shows its options, clicking one opens a popup you choose from
 * (`TreeTab:OpenMasteryPopup`).
 */
const CSS = `
.poe-mc {
  position: absolute;
  z-index: 30;
  pointer-events: auto;
  width: 21rem;
  border-radius: 11px;
  background: color-mix(in oklab, #10141d 96%, transparent);
  border: 1px solid #2b3446;
  box-shadow: 0 18px 48px -10px rgba(0,0,0,.8), 0 0 0 1px rgba(255,255,255,.03) inset;
  backdrop-filter: blur(10px) saturate(1.2);
  color: #d7deeb;
  font: 400 12.5px/1.5 ui-sans-serif, -apple-system, "Segoe UI", Inter, system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
  opacity: 0;
  transform: translate3d(0, 5px, 0) scale(.985);
  transition: opacity .12s ease-out, transform .12s cubic-bezier(.2,.7,.3,1);
  overflow: hidden;
}
.poe-mc[data-open="1"] { opacity: 1; transform: translate3d(0,0,0) scale(1); }

.poe-mc__head {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 12px 9px; border-bottom: 1px solid #1d2432;
}
.poe-mc__name { font-size: 14px; font-weight: 600; letter-spacing: -.01em; color: #f2f5fa; flex: 1; }
.poe-mc__tag {
  font-size: 10px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase;
  padding: 2px 6px; border-radius: 999px; background: #16303a; color: #6fd0e6;
}
.poe-mc__close {
  all: unset; cursor: pointer; width: 20px; height: 20px; border-radius: 6px;
  display: grid; place-items: center; color: #7d8aa1; font-size: 14px; line-height: 1;
}
.poe-mc__close:hover { background: #1b2231; color: #d7deeb; }

.poe-mc__list { padding: 6px; display: grid; gap: 2px; max-height: 21rem; overflow-y: auto; }

.poe-mc__opt {
  all: unset; box-sizing: border-box; cursor: pointer;
  display: grid; grid-template-columns: 18px 1fr; gap: 9px; align-items: start;
  padding: 8px 9px; border-radius: 7px; color: #93b7e8;
  transition: background .1s ease-out, color .1s ease-out;
}
.poe-mc__opt:hover:not([data-disabled="1"]) { background: #171e2b; color: #cfe0f7; }
.poe-mc__opt:focus-visible { outline: 2px solid #4d8fd6; outline-offset: -2px; }
.poe-mc__opt[data-selected="1"] { background: #16283c; color: #e8f1ff; }
.poe-mc__opt[data-disabled="1"] { cursor: not-allowed; color: #55607a; }

/* Radio, not checkbox: exactly one effect per mastery. */
.poe-mc__mark {
  margin-top: 2px; width: 15px; height: 15px; border-radius: 50%;
  border: 1.5px solid #3a4459; display: grid; place-items: center;
}
.poe-mc__opt[data-selected="1"] .poe-mc__mark { border-color: #6fd0e6; }
.poe-mc__mark > i {
  width: 7px; height: 7px; border-radius: 50%; background: #6fd0e6;
  transform: scale(0); transition: transform .12s cubic-bezier(.2,.9,.3,1.4);
}
.poe-mc__opt[data-selected="1"] .poe-mc__mark > i { transform: scale(1); }
.poe-mc__opt[data-disabled="1"] .poe-mc__mark { border-color: #2b3242; }

.poe-mc__text > span { display: block; }
.poe-mc__why { margin-top: 3px; font-size: 11px; color: #6b7590; font-style: italic; }

.poe-mc__foot {
  padding: 7px 12px 9px; border-top: 1px solid #1d2432; background: #0d1119;
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
}
.poe-mc__hint { font-size: 11px; color: #6b7590; }
.poe-mc__clear {
  all: unset; cursor: pointer; font-size: 11px; font-weight: 550; color: #ff9aa2;
  padding: 3px 7px; border-radius: 6px;
}
.poe-mc__clear:hover { background: #2a171b; }
.poe-mc__clear[hidden] { display: none; }
`;

function ensureStyle(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

export interface MasteryChooserData {
  node: TreeNode;
  effects: MasteryEffect[];
  /** Currently chosen effect id, or null. */
  selected: number | null;
}

/** `null` clears the mastery. */
export type MasteryChooseHandler = (node: NodeId, effect: number | null) => void;

/** Fired on every open/close transition, not on a re-`show` of an open panel. */
export type MasteryOpenChangeHandler = (open: boolean) => void;

/**
 * The chooser for a mastery node.
 *
 * A mastery is not allocated by clicking it: you pick exactly one of its
 * effects, and the node only counts as allocated once you have
 * (`PassiveSpec.lua:283`). An effect can be used on only one mastery in the
 * whole tree, so effects already spent elsewhere arrive with `available:false`
 * and are shown disabled with the reason rather than hidden — hiding them
 * makes the list change shape for no visible reason.
 */
export class MasteryChooser {
  readonly el: HTMLDivElement;
  private readonly host: HTMLElement;
  private readonly listEl: HTMLDivElement;
  private readonly nameEl: HTMLSpanElement;
  private readonly clearEl: HTMLButtonElement;
  private onChoose: MasteryChooseHandler | null = null;
  private onOpenChange: MasteryOpenChangeHandler | null = null;
  private current: MasteryChooserData | null = null;
  private open = false;
  private readonly onDocPointerDown: (e: PointerEvent) => void;
  private readonly onKeyDown: (e: KeyboardEvent) => void;

  constructor(host: HTMLElement) {
    ensureStyle();
    this.host = host;

    this.el = document.createElement('div');
    this.el.className = 'poe-mc';
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-modal', 'false');
    this.el.hidden = true;

    const head = document.createElement('div');
    head.className = 'poe-mc__head';
    this.nameEl = document.createElement('span');
    this.nameEl.className = 'poe-mc__name';
    const tag = document.createElement('span');
    tag.className = 'poe-mc__tag';
    tag.textContent = 'Mastery';
    const close = document.createElement('button');
    close.className = 'poe-mc__close';
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.textContent = '✕';
    close.addEventListener('click', () => this.hide());
    head.append(this.nameEl, tag, close);

    this.listEl = document.createElement('div');
    this.listEl.className = 'poe-mc__list';
    this.listEl.setAttribute('role', 'radiogroup');

    const foot = document.createElement('div');
    foot.className = 'poe-mc__foot';
    const hint = document.createElement('span');
    hint.className = 'poe-mc__hint';
    hint.textContent = 'Pick one effect';
    this.clearEl = document.createElement('button');
    this.clearEl.className = 'poe-mc__clear';
    this.clearEl.type = 'button';
    this.clearEl.textContent = 'Clear selection';
    this.clearEl.addEventListener('click', () => this.choose(null));
    foot.append(hint, this.clearEl);

    this.el.append(head, this.listEl, foot);
    host.appendChild(this.el);

    // Click anywhere outside closes, but the click that opened this must not
    // immediately close it — hence pointerdown on the document, and the guard
    // that the target is not inside our own element.
    this.onDocPointerDown = (e: PointerEvent) => {
      if (!this.open) return;
      if (e.target instanceof Node && this.el.contains(e.target)) return;
      this.hide();
    };
    this.onKeyDown = (e: KeyboardEvent) => {
      if (!this.open) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        this.hide();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        this.moveFocus(e.key === 'ArrowDown' ? 1 : -1);
      }
    };
  }

  get isOpen(): boolean {
    return this.open;
  }

  get nodeId(): NodeId | null {
    return this.current?.node.id ?? null;
  }

  /** Called with `null` when the user clears the mastery. */
  setHandler(handler: MasteryChooseHandler | null): void {
    this.onChoose = handler;
  }

  /**
   * Notified whenever the panel opens or closes.
   *
   * The chooser covers the node that opened it, and the tooltip is
   * `pointer-events: none`, so the cursor never leaves that node and the
   * tooltip stays up behind the panel with its stat lines showing below.
   * Wire this to `TreeView.setTooltipSuppressed`.
   */
  setOpenChangeHandler(handler: MasteryOpenChangeHandler | null): void {
    this.onOpenChange = handler;
  }

  show(data: MasteryChooserData, x: number, y: number): void {
    this.current = data;
    this.render(data);
    this.el.hidden = false;
    this.position(x, y);

    if (!this.open) {
      this.open = true;
      document.addEventListener('pointerdown', this.onDocPointerDown, true);
      document.addEventListener('keydown', this.onKeyDown, true);
      // Next frame, so the transition has a start state to animate from.
      requestAnimationFrame(() => this.el.setAttribute('data-open', '1'));
      this.onOpenChange?.(true);
    }

    const first = this.listEl.querySelector<HTMLElement>(
      '.poe-mc__opt[data-selected="1"]:not([data-disabled="1"]), .poe-mc__opt:not([data-disabled="1"])',
    );
    first?.focus({ preventScroll: true });
  }

  hide(): void {
    if (!this.open) return;
    this.open = false;
    this.current = null;
    this.el.removeAttribute('data-open');
    document.removeEventListener('pointerdown', this.onDocPointerDown, true);
    document.removeEventListener('keydown', this.onKeyDown, true);
    // Leave it in the DOM until the fade finishes, then take it out of hit
    // testing so it cannot swallow clicks meant for the tree.
    window.setTimeout(() => {
      if (!this.open) this.el.hidden = true;
    }, 140);
    this.onOpenChange?.(false);
  }

  destroy(): void {
    document.removeEventListener('pointerdown', this.onDocPointerDown, true);
    document.removeEventListener('keydown', this.onKeyDown, true);
    this.el.remove();
  }

  // -- internals ------------------------------------------------------------

  private choose(effect: number | null): void {
    const node = this.current?.node.id;
    if (node === undefined) return;
    this.onChoose?.(node, effect);
    this.hide();
  }

  private moveFocus(delta: number): void {
    const opts = [
      ...this.listEl.querySelectorAll<HTMLElement>('.poe-mc__opt:not([data-disabled="1"])'),
    ];
    if (opts.length === 0) return;
    const at = opts.indexOf(document.activeElement as HTMLElement);
    const next = at < 0 ? 0 : (at + delta + opts.length) % opts.length;
    opts[next]?.focus({ preventScroll: true });
  }

  private render(data: MasteryChooserData): void {
    this.nameEl.textContent = data.node.name;
    this.listEl.replaceChildren();

    for (const effect of data.effects) {
      const selected = effect.id === data.selected;
      // An effect spent on another mastery is still shown, just disabled —
      // silently omitting it would make the list change size for no reason.
      const disabled = !effect.available && !selected;

      const opt = document.createElement('button');
      opt.className = 'poe-mc__opt';
      opt.type = 'button';
      opt.setAttribute('role', 'radio');
      opt.setAttribute('aria-checked', String(selected));
      if (selected) opt.dataset.selected = '1';
      if (disabled) {
        opt.dataset.disabled = '1';
        opt.disabled = true;
      }

      const mark = document.createElement('span');
      mark.className = 'poe-mc__mark';
      mark.append(document.createElement('i'));

      const text = document.createElement('span');
      text.className = 'poe-mc__text';
      for (const line of effect.stats) {
        const s = document.createElement('span');
        s.textContent = line;
        text.append(s);
      }
      if (disabled) {
        const why = document.createElement('span');
        why.className = 'poe-mc__why';
        why.textContent = 'Already used on another mastery';
        text.append(why);
      }

      opt.append(mark, text);
      if (!disabled) {
        opt.addEventListener('click', () => this.choose(selected ? null : effect.id));
      }
      this.listEl.append(opt);
    }

    this.clearEl.hidden = data.selected === null;
  }

  private position(x: number, y: number): void {
    const hostRect = this.host.getBoundingClientRect();
    const rect = this.el.getBoundingClientRect();
    const pad = 12;
    const gap = 16;

    // Prefer to the right of the node, flip left when it would overflow.
    let left = x + gap;
    if (left + rect.width > hostRect.width - pad) left = x - gap - rect.width;
    left = Math.max(pad, Math.min(left, hostRect.width - rect.width - pad));

    let top = y - rect.height / 3;
    top = Math.max(pad, Math.min(top, hostRect.height - rect.height - pad));

    this.el.style.left = `${Math.round(left)}px`;
    this.el.style.top = `${Math.round(top)}px`;
  }
}
