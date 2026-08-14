/**
 * Ported from Path of Building Community,
 * src/Classes/PassiveSpec.lua — `BuildPathFromNode` (896-940), the path reset
 * and seeding inside `BuildAllDependsAndPaths` (1594-1605), and `AllocNode`
 * (the path-allocation half).
 * Copyright (c) 2016 David Gowor and contributors. MIT — see NOTICE.md.
 *
 * A plain shortest-hop BFS gets this wrong in four separate ways, so the rules
 * are transcribed rather than reinvented:
 *
 *   1. Paths may not pass *through* class or ascendancy start nodes, though
 *      they may start from one.
 *   2. Paths may not cross between ascendancies, or between an ascendancy and
 *      the main tree — except starting from an ascendancy node into the main
 *      tree, which is what makes Ascendant's "Path of the X" nodes work.
 *   3. Paths may not lead *away* from a mastery. A mastery is a dead end: you
 *      can reach one, but never route through it.
 *   4. Cost is points spent, not hops — an already-allocated node is free.
 *      That makes this a 0-1 BFS, and it is why the route PoB picks often is
 *      not the one with the fewest nodes.
 */

import type { NodeId, TreeNode } from '../types';

/** Same sentinel PoB uses for "no path known yet". */
export const UNREACHABLE = 1000;

export interface NodePath {
  /**
   * The nodes to allocate, target first, walking back toward the allocated
   * tree. The already-allocated root is not included.
   */
  path: NodeId[];
  /** Points this costs — allocated nodes along the way are free. */
  pathDist: number;
}

/** Node types a path may never pass through. */
function isStartNode(node: TreeNode): boolean {
  return node.type === 'classStart' || node.type === 'ascendClassStart';
}

/**
 * Compute the cheapest path to every reachable node, from the whole allocated
 * set at once.
 *
 * Mirrors the reset-then-seed in `BuildAllDependsAndPaths`: allocated nodes
 * start at distance 0, everything else at {@link UNREACHABLE}, then a BFS runs
 * outward from each allocated node in turn.
 */
export function buildPaths(
  nodes: readonly TreeNode[],
  linked: ReadonlyMap<NodeId, readonly NodeId[]>,
  allocated: ReadonlySet<NodeId>,
): Map<NodeId, NodePath> {
  const byId = new Map<NodeId, TreeNode>();
  for (const n of nodes) byId.set(n.id, n);

  const dist = new Map<NodeId, number>();
  const path = new Map<NodeId, NodeId[]>();
  for (const n of nodes) dist.set(n.id, allocated.has(n.id) ? 0 : UNREACHABLE);

  for (const rootId of allocated) {
    const root = byId.get(rootId);
    if (!root) continue;

    dist.set(rootId, 0);
    path.set(rootId, []);

    // PoB's hand-rolled queue: an index pair over a growing array, never
    // shifted. Nodes can be enqueued more than once, which is what lets a
    // later, cheaper route overwrite an earlier one.
    const queue: NodeId[] = [rootId];
    for (let head = 0; head < queue.length; head++) {
      const nodeId = queue[head];
      const node = byId.get(nodeId);
      if (!node) continue;

      // Rule 3: never step away from a mastery.
      if (node.type === 'mastery') continue;

      const curDist = dist.get(nodeId) ?? UNREACHABLE;
      const nodePath = path.get(nodeId) ?? [];

      for (const otherId of linked.get(nodeId) ?? []) {
        const other = byId.get(otherId);
        if (!other) continue;

        // Rule 1.
        if (isStartNode(other)) continue;

        // Rule 2: same ascendancy, or stepping out of one on the first hop.
        const sameAscendancy = (node.ascendancy ?? null) === (other.ascendancy ?? null);
        if (!sameAscendancy && !(curDist === 0 && !other.ascendancy)) continue;

        const otherDist = dist.get(otherId) ?? UNREACHABLE;
        if (otherDist <= curDist) continue;

        // Rule 4: reaching an already-allocated node costs nothing.
        dist.set(otherId, curDist + (allocated.has(otherId) ? 0 : 1));
        path.set(otherId, [otherId, ...nodePath]);
        queue.push(otherId);
      }
    }
  }

  const out = new Map<NodeId, NodePath>();
  for (const [id, d] of dist) {
    if (d >= UNREACHABLE) continue;
    out.set(id, { path: path.get(id) ?? [], pathDist: d });
  }
  return out;
}

/** The cheapest path to one node, or null when it cannot be reached. */
export function pathToNode(
  target: NodeId,
  nodes: readonly TreeNode[],
  linked: ReadonlyMap<NodeId, readonly NodeId[]>,
  allocated: ReadonlySet<NodeId>,
): NodePath | null {
  if (allocated.has(target)) return { path: [], pathDist: 0 };
  return buildPaths(nodes, linked, allocated).get(target) ?? null;
}

/**
 * Allocate a node the way `PassiveSpec:AllocNode` does — every node along the
 * path, not just the target — and return the new allocation set.
 *
 * An unreachable node allocates nothing, matching PoB's early return when
 * `node.path` is nil. `altPath` mirrors PoB's shift-trace override, letting the
 * player take a deliberately longer route.
 */
export function allocNode(
  target: NodeId,
  nodes: readonly TreeNode[],
  linked: ReadonlyMap<NodeId, readonly NodeId[]>,
  allocated: ReadonlySet<NodeId>,
  altPath?: readonly NodeId[],
): Set<NodeId> {
  const next = new Set(allocated);
  if (altPath?.length) {
    for (const id of altPath) next.add(id);
    return next;
  }

  const found = pathToNode(target, nodes, linked, allocated);
  if (!found) return next;
  for (const id of found.path) next.add(id);
  next.add(target);
  return next;
}

/**
 * Adjacency for path finding, from the nodes' own link lists.
 *
 * Use this, not the connector array. PoB records a graph link for every
 * connected pair but declines to *draw* one when either end is a Mastery or a
 * ClassStart (`PassiveTree.lua:610-613`) — so all 315 masteries have zero
 * connectors while remaining perfectly reachable. Deriving adjacency from the
 * drawn lines silently makes every mastery unallocatable.
 */
export function adjacencyFromNodes(
  nodes: ReadonlyArray<{ id: NodeId; linked?: readonly NodeId[] }>,
): Map<NodeId, NodeId[]> {
  const known = new Set(nodes.map((n) => n.id));
  const out = new Map<NodeId, NodeId[]>();
  const push = (a: NodeId, b: NodeId) => {
    const list = out.get(a);
    if (!list) out.set(a, [b]);
    else if (!list.includes(b)) list.push(b);
  };
  for (const node of nodes) {
    for (const other of node.linked ?? []) {
      // Links can point at nodes a cluster-jewel rebuild has replaced.
      if (!known.has(other)) continue;
      push(node.id, other);
      push(other, node.id);
    }
  }
  return out;
}

/**
 * Adjacency from the drawn connector list, both directions.
 *
 * Only correct for things that care about drawn lines. For path finding use
 * {@link adjacencyFromNodes} — see the note there.
 */
export function adjacencyFrom(
  connectors: ReadonlyArray<{ from: NodeId; to: NodeId }>,
): Map<NodeId, NodeId[]> {
  const linked = new Map<NodeId, NodeId[]>();
  const push = (a: NodeId, b: NodeId) => {
    const list = linked.get(a);
    if (!list) linked.set(a, [b]);
    else if (!list.includes(b)) list.push(b);
  };
  for (const c of connectors) {
    push(c.from, c.to);
    push(c.to, c.from);
  }
  return linked;
}
