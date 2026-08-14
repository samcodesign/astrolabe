import { describe, expect, it } from 'vitest';

import {
  adjacencyFrom,
  adjacencyFromNodes,
  allocNode,
  buildPaths,
  pathToNode,
} from '../src/pob/pathing';
import type { NodeId, TreeNode } from '../src/types';

function n(id: NodeId, type: TreeNode['type'] = 'normal', ascendancy?: string): TreeNode {
  return {
    id,
    name: `n${id}`,
    type,
    stats: [],
    radius: 50,
    linked: [],
    x: id * 10,
    y: 0,
    icon: {},
    frame: {},
    ...(ascendancy ? { ascendancy } : {}),
  } as TreeNode;
}

/** `1-2 2-3` → adjacency. */
function links(spec: string) {
  return adjacencyFrom(
    spec.split(' ').map((pair) => {
      const [from, to] = pair.split('-').map(Number);
      return { from, to };
    }),
  );
}

describe('buildPaths — PoB BuildPathFromNode', () => {
  it('walks outward from the allocated tree', () => {
    const nodes = [n(1), n(2), n(3), n(4)];
    const found = buildPaths(nodes, links('1-2 2-3 3-4'), new Set([1]));

    expect(found.get(2)!.pathDist).toBe(1);
    expect(found.get(3)!.pathDist).toBe(2);
    expect(found.get(4)!.pathDist).toBe(3);
    // Target first, walking back toward the tree; the root is excluded.
    expect(found.get(3)!.path).toEqual([3, 2]);
  });

  it('counts points spent, not hops — allocated nodes are free', () => {
    // 1 =(long allocated corridor)= 4 =unallocated= 5, versus 1 =2 hops= 5.
    const nodes = [n(1), n(2), n(3), n(4), n(5), n(9)];
    const linked = links('1-2 2-3 3-4 4-5 1-9 9-5');
    const allocated = new Set([1, 2, 3, 4]);

    const found = buildPaths(nodes, linked, allocated);
    // Through the corridor: only node 5 is unpaid → 1 point.
    // Through 9: node 9 and node 5 are both unpaid → 2 points.
    expect(found.get(5)!.pathDist).toBe(1);
    expect(found.get(5)!.path).toEqual([5]);
  });

  it('never routes away from a mastery', () => {
    // The only way from 1 to 3 is through the mastery at 2.
    const nodes = [n(1), n(2, 'mastery'), n(3)];
    const found = buildPaths(nodes, links('1-2 2-3'), new Set([1]));

    expect(found.get(2)).toBeDefined(); // reachable as a dead end
    expect(found.get(3)).toBeUndefined(); // but not through it
  });

  it('never passes through a class start', () => {
    const nodes = [n(1), n(2, 'classStart'), n(3)];
    const found = buildPaths(nodes, links('1-2 2-3'), new Set([1]));
    expect(found.get(3)).toBeUndefined();
  });

  it('never passes through an ascendancy start', () => {
    // The type that used to be collapsed into `ascendancy`, losing this rule.
    const nodes = [n(1), n(2, 'ascendClassStart'), n(3)];
    const found = buildPaths(nodes, links('1-2 2-3'), new Set([1]));
    expect(found.get(3)).toBeUndefined();
  });

  it('will not cross from the main tree into an ascendancy', () => {
    const nodes = [n(1), n(2, 'normal', 'Slayer')];
    const found = buildPaths(nodes, links('1-2'), new Set([1]));
    expect(found.get(2)).toBeUndefined();
  });

  it('will not cross between two ascendancies', () => {
    const nodes = [n(1, 'normal', 'Slayer'), n(2, 'normal', 'Champion')];
    const found = buildPaths(nodes, links('1-2'), new Set([1]));
    expect(found.get(2)).toBeUndefined();
  });

  it('lets an allocated ascendancy node step out into the main tree', () => {
    // Rule 2's exception, which is what makes Ascendant's Path of the X work:
    // permitted only on the first hop, where curDist is still 0.
    const nodes = [n(1, 'normal', 'Ascendant'), n(2)];
    const found = buildPaths(nodes, links('1-2'), new Set([1]));
    expect(found.get(2)!.pathDist).toBe(1);
  });

  it('reports nothing for a disconnected node', () => {
    const nodes = [n(1), n(2), n(3)];
    const found = buildPaths(nodes, links('1-2'), new Set([1]));
    expect(found.get(3)).toBeUndefined();
  });

  it('finds no path when nothing is allocated', () => {
    expect(buildPaths([n(1), n(2)], links('1-2'), new Set()).size).toBe(0);
  });
});

describe('allocNode — PoB AllocNode', () => {
  it('allocates every node along the path, not just the target', () => {
    const nodes = [n(1), n(2), n(3), n(4)];
    const next = allocNode(4, nodes, links('1-2 2-3 3-4'), new Set([1]));
    expect([...next].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  });

  it('allocates nothing when the target is unreachable', () => {
    const nodes = [n(1), n(2, 'mastery'), n(3)];
    const before = new Set([1]);
    const next = allocNode(3, nodes, links('1-2 2-3'), before);
    expect([...next]).toEqual([1]);
  });

  it('reaches a mastery itself even though it cannot be routed through', () => {
    const nodes = [n(1), n(2, 'mastery')];
    const next = allocNode(2, nodes, links('1-2'), new Set([1]));
    expect(next.has(2)).toBe(true);
  });

  it('honours an explicit trace path over the shortest route', () => {
    // PoB's shift-trace: the player picks a deliberately longer way round.
    const nodes = [n(1), n(2), n(3), n(4)];
    const next = allocNode(4, nodes, links('1-2 2-4 1-3 3-4'), new Set([1]), [3, 4]);
    expect(next.has(3)).toBe(true);
    expect(next.has(2)).toBe(false);
  });

  it('is a no-op for an already-allocated node', () => {
    const nodes = [n(1), n(2)];
    expect(pathToNode(1, nodes, links('1-2'), new Set([1]))).toEqual({ path: [], pathDist: 0 });
  });
});

describe('adjacencyFromNodes — why connectors are not enough', () => {
  it('links masteries, which have no drawn connector at all', () => {
    // PassiveTree.lua:610-613 refuses to draw a line when either end is a
    // Mastery, so a mastery is reachable in the graph but invisible in the
    // connector list. Adjacency built from connectors makes it unallocatable.
    const nodes = [
      { id: 1, linked: [2] },
      { id: 2, type: 'mastery', linked: [1] },
    ];
    const fromNodes = adjacencyFromNodes(nodes);
    expect(fromNodes.get(1)).toEqual([2]);

    const fromConnectors = adjacencyFrom([]); // masteries yield no connectors
    expect(fromConnectors.get(1)).toBeUndefined();
  });

  it('lets a mastery actually be allocated', () => {
    const nodes = [n(1), n(2, 'mastery')];
    nodes[0].linked = [2];
    nodes[1].linked = [1];
    const next = allocNode(2, nodes, adjacencyFromNodes(nodes), new Set([1]));
    expect(next.has(2)).toBe(true);
  });

  it('ignores links pointing at nodes that no longer exist', () => {
    // Cluster-jewel rebuilds can leave stale ids behind.
    const linked = adjacencyFromNodes([{ id: 1, linked: [2, 999] }, { id: 2, linked: [1] }]);
    expect(linked.get(1)).toEqual([2]);
  });

  it('is symmetric even when only one side declares the link', () => {
    const linked = adjacencyFromNodes([{ id: 1, linked: [2] }, { id: 2, linked: [] }]);
    expect(linked.get(2)).toEqual([1]);
  });
});
