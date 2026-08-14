// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MasteryChooser } from '../src/ui/MasteryChooser';
import type { MasteryEffect, TreeNode } from '../src/types';

function node(overrides: Partial<TreeNode> = {}): TreeNode {
  return {
    id: 42,
    name: 'Damage Over Time Mastery',
    type: 'mastery',
    stats: [],
    radius: 70,
    x: 0,
    y: 0,
    icon: {},
    frame: {},
    ...overrides,
  } as TreeNode;
}

const EFFECTS: MasteryEffect[] = [
  { id: 1, stats: ['30% increased Effect of Cruelty'], available: true },
  { id: 2, stats: ['+10% to Damage over Time Multiplier if you have Killed Recently'], available: true },
  { id: 3, stats: ['15% increased Duration of Ailments on Enemies'], available: false },
];

function mount() {
  document.body.innerHTML = '';
  const host = document.createElement('div');
  host.style.position = 'relative';
  document.body.append(host);
  return { host, chooser: new MasteryChooser(host) };
}

function options(chooser: MasteryChooser): HTMLButtonElement[] {
  return [...chooser.el.querySelectorAll<HTMLButtonElement>('.poe-mc__opt')];
}

describe('MasteryChooser', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('lists every effect as a radio option', () => {
    const { chooser } = mount();
    chooser.show({ node: node(), effects: EFFECTS, selected: null }, 100, 100);

    const opts = options(chooser);
    expect(opts).toHaveLength(3);
    expect(opts.every((o) => o.getAttribute('role') === 'radio')).toBe(true);
    expect(opts[0].textContent).toContain('30% increased Effect of Cruelty');
  });

  it('is clickable — unlike the tooltip, which is pointer-events:none', () => {
    const { chooser } = mount();
    chooser.show({ node: node(), effects: EFFECTS, selected: null }, 100, 100);
    // The whole point of a separate component: the hover tooltip cannot hold a
    // control because it must never intercept clicks meant for the tree.
    expect(chooser.el.className).toBe('poe-mc');
    expect(chooser.el.hidden).toBe(false);
  });

  it('reports the chosen effect and closes', () => {
    const { chooser } = mount();
    const onChoose = vi.fn();
    chooser.setHandler(onChoose);
    chooser.show({ node: node(), effects: EFFECTS, selected: null }, 100, 100);

    options(chooser)[1].click();

    expect(onChoose).toHaveBeenCalledWith(42, 2);
    expect(chooser.isOpen).toBe(false);
  });

  it('marks the current selection and lets it be toggled off', () => {
    const { chooser } = mount();
    const onChoose = vi.fn();
    chooser.setHandler(onChoose);
    chooser.show({ node: node(), effects: EFFECTS, selected: 2 }, 100, 100);

    const opts = options(chooser);
    expect(opts[1].dataset.selected).toBe('1');
    expect(opts[1].getAttribute('aria-checked')).toBe('true');

    opts[1].click();
    expect(onChoose).toHaveBeenCalledWith(42, null);
  });

  it('disables effects already spent on another mastery, and says why', () => {
    const { chooser } = mount();
    const onChoose = vi.fn();
    chooser.setHandler(onChoose);
    chooser.show({ node: node(), effects: EFFECTS, selected: null }, 100, 100);

    const third = options(chooser)[2];
    expect(third.disabled).toBe(true);
    expect(third.dataset.disabled).toBe('1');
    expect(third.textContent).toContain('Already used on another mastery');

    third.click();
    expect(onChoose).not.toHaveBeenCalled();
  });

  it('keeps the current selection usable even when flagged unavailable', () => {
    // The engine marks an effect unavailable because *this* node holds it;
    // it must stay selectable so the player can clear it.
    const { chooser } = mount();
    chooser.show(
      { node: node(), effects: [{ id: 3, stats: ['x'], available: false }], selected: 3 },
      100,
      100,
    );
    const only = options(chooser)[0];
    expect(only.disabled).toBe(false);
    expect(only.dataset.selected).toBe('1');
  });

  it('offers a clear action only when something is selected', () => {
    const { chooser } = mount();
    const clear = () => chooser.el.querySelector<HTMLButtonElement>('.poe-mc__clear')!;

    chooser.show({ node: node(), effects: EFFECTS, selected: null }, 100, 100);
    expect(clear().hidden).toBe(true);

    chooser.show({ node: node(), effects: EFFECTS, selected: 1 }, 100, 100);
    expect(clear().hidden).toBe(false);
  });

  it('closes on Escape', () => {
    const { chooser } = mount();
    chooser.show({ node: node(), effects: EFFECTS, selected: null }, 100, 100);
    expect(chooser.isOpen).toBe(true);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(chooser.isOpen).toBe(false);
  });

  it('closes on a click outside but not on a click inside', () => {
    const { chooser } = mount();
    chooser.show({ node: node(), effects: EFFECTS, selected: null }, 100, 100);

    chooser.el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(chooser.isOpen).toBe(true);

    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(chooser.isOpen).toBe(false);
  });

  it('tracks which node it is showing', () => {
    const { chooser } = mount();
    expect(chooser.nodeId).toBeNull();
    chooser.show({ node: node({ id: 7 }), effects: EFFECTS, selected: null }, 10, 10);
    expect(chooser.nodeId).toBe(7);
    chooser.hide();
    expect(chooser.nodeId).toBeNull();
  });

  it('announces open and close, so the tooltip can be held shut', () => {
    const { chooser } = mount();
    const seen: boolean[] = [];
    chooser.setOpenChangeHandler((open) => seen.push(open));

    chooser.show({ node: node(), effects: EFFECTS, selected: null }, 100, 100);
    // Re-showing an open panel on another node is not a transition.
    chooser.show({ node: node({ id: 9 }), effects: EFFECTS, selected: null }, 120, 100);
    expect(seen).toEqual([true]);

    chooser.hide();
    expect(seen).toEqual([true, false]);
    // hide() on an already-closed panel returns early.
    chooser.hide();
    expect(seen).toEqual([true, false]);
  });

  it('announces the close that picking an effect causes', () => {
    const { chooser } = mount();
    const seen: boolean[] = [];
    chooser.setOpenChangeHandler((open) => seen.push(open));
    chooser.show({ node: node(), effects: EFFECTS, selected: null }, 100, 100);
    options(chooser)[0].click();
    expect(seen).toEqual([true, false]);
  });

  it('detaches its document listeners on destroy', () => {
    const { chooser } = mount();
    chooser.show({ node: node(), effects: EFFECTS, selected: null }, 100, 100);
    chooser.destroy();
    // Would throw or mutate state if the handlers were still bound.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('.poe-mc')).toBeNull();
  });
});
