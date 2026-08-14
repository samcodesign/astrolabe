// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import { Tooltip } from '../src/ui/Tooltip';
import type { JewelItem, TooltipData, TreeNode } from '../src/index';

function node(id = 7): TreeNode {
  return {
    id,
    name: 'Fangs of the Viper',
    type: 'notable',
    stats: ['+20 to Dexterity'],
    radius: 45,
    x: 0,
    y: 0,
    icon: {},
    frame: {},
    linked: [],
  };
}

const data = (id = 7): TooltipData => ({ node: node(id), alloc: 'unallocated' });

function mount() {
  document.body.innerHTML = '';
  const host = document.createElement('div');
  document.body.appendChild(host);
  return new Tooltip(host);
}

describe('Tooltip suppression', () => {
  let tt: Tooltip;
  beforeEach(() => {
    tt = mount();
  });

  it('opens normally when nothing is suppressing it', () => {
    tt.show(data(), 10, 10);
    expect(tt.el.dataset.open).toBe('1');
    expect(tt.nodeId).toBe(7);
  });

  it('closes on the spot when suppression is turned on', () => {
    tt.show(data(), 10, 10);
    tt.setSuppressed(true);
    expect(tt.el.dataset.open).toBe('0');
    expect(tt.nodeId).toBeNull();
  });

  it('refuses to reopen while suppressed', () => {
    // The chooser covers the hovered node, so the pointer never leaves it and
    // the view keeps calling show() on every mouse move.
    tt.setSuppressed(true);
    tt.show(data(), 10, 10);
    tt.show(data(), 12, 14);
    expect(tt.el.dataset.open).not.toBe('1');
    expect(tt.el.textContent).toBe('');
  });

  it('opens again once suppression is lifted', () => {
    tt.setSuppressed(true);
    tt.show(data(), 10, 10);
    tt.setSuppressed(false);
    expect(tt.isSuppressed).toBe(false);
    tt.show(data(), 10, 10);
    expect(tt.el.dataset.open).toBe('1');
    expect(tt.el.textContent).toContain('Fangs of the Viper');
  });

  it('is idempotent, so a repeated close does not clobber a fresh hover', () => {
    tt.setSuppressed(true);
    tt.setSuppressed(false);
    tt.show(data(), 1, 1);
    tt.setSuppressed(false);
    expect(tt.el.dataset.open).toBe('1');
  });
});

describe('socketed jewel', () => {
  const socket = (): TreeNode => ({
    ...node(99),
    name: 'Jewel Socket',
    type: 'socket',
    stats: [],
  });

  const hubris: JewelItem = {
    rarity: 'UNIQUE',
    name: 'Elegant Hubris',
    base: 'Timeless Jewel',
    radiusLabel: 'Large',
    mods: [
      { group: 'explicit', line: 'Commissioned 137300 coins to commemorate Caspiro', kind: 'normal' },
      { group: 'explicit', line: 'Passives in radius are Conquered by the Eternal Empire', kind: 'normal' },
    ],
  };

  it('shows the jewel in place of the socket, as PoB does', () => {
    const tt = mount();
    tt.show({ node: socket(), alloc: 'allocated', jewel: hubris }, 10, 10);
    const text = tt.el.textContent ?? '';
    expect(text).toContain('Elegant Hubris');
    expect(text).toContain('Timeless Jewel');
    // The seed is the whole point: two Elegant Hubrises differ only here, and
    // it decides which passives get conquered.
    expect(text).toContain('Commissioned 137300 coins to commemorate Caspiro');
    expect(text).toContain('Radius: Large');
    // PoB replaces the socket's own tooltip rather than appending to it.
    expect(text).not.toContain('Jewel Socket');
  });

  it('still shows the socket itself when nothing is in it', () => {
    const tt = mount();
    tt.show({ node: socket(), alloc: 'allocated' }, 10, 10);
    expect(tt.el.textContent).toContain('Jewel Socket');
  });

  it('colours a crafted mod differently from a rolled one', () => {
    const tt = mount();
    tt.show(
      {
        node: socket(),
        alloc: 'allocated',
        jewel: {
          name: 'Rapture Solace',
          rarity: 'RARE',
          mods: [
            { group: 'enchant', line: 'Adds 8 Passive Skills', kind: 'crafted' },
            { group: 'explicit', line: '1 Added Passive Skill is Rotten Claws', kind: 'normal' },
          ],
        },
      },
      10,
      10,
    );
    const lines = [...tt.el.querySelectorAll('li')] as HTMLLIElement[];
    const crafted = lines.find((li) => li.textContent?.includes('Adds 8'));
    const rolled = lines.find((li) => li.textContent?.includes('Rotten Claws'));
    // PoB's CRAFTED colour; a rolled mod inherits the tooltip's stat colour.
    expect(crafted?.style.color).not.toBe('');
    expect(rolled?.style.color).toBe('');
  });

  it('lists a cluster jewel\'s notables with their stats', () => {
    const tt = mount();
    tt.show(
      {
        node: socket(),
        alloc: 'allocated',
        jewel: {
          name: 'Rapture Solace',
          mods: [],
          clusterNodes: [{ name: 'Primordial Bond', stats: ['Golems have 25% increased Maximum Life'] }],
        },
      },
      10,
      10,
    );
    const text = tt.el.textContent ?? '';
    expect(text).toContain('Primordial Bond');
    expect(text).toContain('Golems have 25% increased Maximum Life');
  });
});
