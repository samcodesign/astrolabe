import { describe, expect, it } from 'vitest';

import { TREE_VIEW_EVENTS } from '../src/index';

/**
 * The renderer emits, the app subscribes, and nothing connects the two but a
 * string. When they disagreed — the app listening for `ascendancySelect` while
 * the view emitted `ascendancy` — ascendancy selection silently did nothing,
 * and both suites stayed green because neither crosses the seam.
 *
 * So the seam is pinned here. `TREE_VIEW_EVENTS` is checked against
 * `TreeViewEvents` by the compiler, which leaves this file one job: fail loudly
 * if a name a consumer depends on is renamed or dropped.
 */
describe('the renderer event contract', () => {
  const PUBLISHED = [
    'hover',
    'click',
    'mastery',
    // Consumed by app/src/ui/TreeStage.tsx to drive `build.setClass`.
    'ascendancySelect',
    'viewport',
    'frame',
  ] as const;

  it('publishes exactly the documented names', () => {
    expect([...TREE_VIEW_EVENTS].sort()).toEqual([...PUBLISHED].sort());
  });

  it('has no name that differs only by case or a "select" suffix', () => {
    // `ascendancy` vs `ascendancySelect` and `mastery` vs `masterySelect` are
    // the exact shapes of the mistake; near-duplicates make it easy to repeat.
    const seen = new Set<string>();
    for (const name of TREE_VIEW_EVENTS) {
      const normalised = name.toLowerCase().replace(/select$/, '');
      expect(seen.has(normalised), `"${name}" collides with another event name`).toBe(false);
      seen.add(normalised);
    }
  });
});
