import {
  MasteryChooser,
  TreeView,
  adjacencyFromNodes,
  allocNode,
  pathToNode,
  heatGradientCss,
  nodeMatchesSearch,
  parseSearchQuery,
  type MasteryEffect,
  type NodeId,
  type NodePower,
  type TreeGeometry,
} from '../src/index';

const stage = document.getElementById('stage') as HTMLElement;
const hud = document.getElementById('hud') as HTMLElement;
const toast = document.getElementById('toast') as HTMLElement;

interface BuildSummary {
  name: string;
  className: string;
  ascendClassName: string;
  level: number;
  allocated: NodeId[];
  pointsUsed: number;
  pointsTotal: number;
  masterySelections: Record<string, number>;
}

toast.hidden = false;
toast.textContent = 'loading the 3.29 tree…';

const [geometry, build] = await Promise.all([
  fetch('/fixtures/geometry-3_29.json').then((r) => r.json() as Promise<TreeGeometry>),
  fetch('/fixtures/build-summary.json').then((r) => r.json() as Promise<BuildSummary>),
]);

// Adjacency for the client-side path preview. The real client asks the engine
// (`tree.path`); this stands in so the demo works without it.
//
// Built from the nodes' own link lists, NOT from the drawn connectors: PoB
// draws no line when either end is a Mastery, so deriving adjacency from
// connectors leaves all 315 masteries unreachable.
const adjacency = adjacencyFromNodes(geometry.nodes);

const missing: string[] = [];
const view = await TreeView.create({ container: stage, minGrabPx: 10 });
await view.load(geometry, {
  baseUrl: '/treedata',
  onSheetError: (sheet) => missing.push(sheet),
});

let allocated = new Set<NodeId>(build.allocated);
view.setAllocated(allocated);
view.setClass({ className: build.className, ascendClassName: build.ascendClassName });
view.setMasterySelections(
  Object.fromEntries(Object.entries(build.masterySelections ?? {}).map(([k, v]) => [Number(k), v])),
);

// --------------------------------------------------------------- allocation

/**
 * Uses PoB's own rules rather than a plain shortest-hop search. A generic BFS
 * happily routes through masteries and class starts, crosses ascendancy
 * boundaries, and counts hops instead of points — so it produces routes the
 * game would never allow. See src/pob/pathing.ts.
 */
function pathTo(to: NodeId): NodeId[] {
  return pathToNode(to, geometry.nodes, adjacency, allocated)?.path ?? [];
}

function refreshAllocInfo(): void {
  const cls =
    build.ascendClassName && build.ascendClassName !== 'None'
      ? build.ascendClassName
      : build.className;
  document.getElementById('allocInfo')!.textContent =
    `${allocated.size} allocated · ${cls} lv ${build.level}`;
}
refreshAllocInfo();

view.on('hover', (info) => {
  if (!info) {
    view.setPathPreview(null);
    view.setTooltipExtra(null);
    return;
  }
  const path = pathTo(info.node.id);
  view.setPathPreview(path);

  // The slot the app owns: in the real client this is a live stat delta from
  // the engine. Here it is a plausible stand-in so the wiring is visible.
  if (path.length) {
    const dps = Math.round((info.power?.offence ?? 40) * 12);
    view.setTooltipExtra(
      `<div class="delta-grid">
         <div class="delta-row"><span>Total DPS</span><span class="up">+${dps.toLocaleString()}</span></div>
         <div class="delta-row"><span>Cost</span><span>${path.length} pt${path.length === 1 ? '' : 's'}</span></div>
       </div>`,
    );
  } else {
    view.setTooltipExtra(null);
  }
});

view.on('click', ({ node, ctrl }) => {
  if (allocated.has(node.id)) {
    if (!ctrl) return;
    allocated.delete(node.id);
  } else {
    allocated = allocNode(node.id, geometry.nodes, adjacency, allocated);
  }
  view.setAllocated(allocated);
  view.setPathPreview(null);
  refreshAllocInfo();
  if (compareOn) applyCompare();
});

/**
 * Move the ascendancy start node, which is what actually opens the wheel.
 *
 * `PassiveSpec:SelectAscendClass` deallocates the previous ascendancy's start
 * node and allocates the new one (PassiveSpec.lua:587-613). That node is the
 * wheel's only entrance: pathing may begin at an `ascendClassStart` but never
 * route through one, so until it is allocated every node in the wheel is
 * unreachable and clicking one silently does nothing.
 *
 * The real client gets this for free — the engine runs `SelectAscendClass` and
 * returns the new allocation set. The demo has no engine, so it does it here.
 */
function selectAscendancy(ascendancy: string | undefined, from: Set<NodeId>): Set<NodeId> {
  const next = new Set(from);
  for (const a of geometry.ascendancies ?? []) {
    if (a.startNodeId === undefined) continue;
    if (a.id === ascendancy) next.add(a.startNodeId);
    else next.delete(a.startNodeId);
  }
  return next;
}

/**
 * Change base class, the way `PassiveSpec:SelectClass` does
 * (PassiveSpec.lua:560-585): drop the old class's start node, clear the
 * ascendancy, and allocate the new class's start.
 *
 * PoB resets the tree outright when the current allocation cannot reach the new
 * class, and offers to route a path when it can (PassiveTreeView.lua:473-491).
 * The demo has no engine to ask, so it always resets — which is PoB's
 * "Continue" branch, the destructive one, hence the warning in the panel.
 */
function selectClass(className: string): void {
  const cls = (geometry.classes ?? []).find((c) => c.name === className);
  if (!cls) return;
  build.className = className;
  build.ascendClassName = 'None';
  allocated = new Set<NodeId>([cls.startNodeId]);
  view.setClass({ className, ascendClassName: 'None' });
  view.setAllocated(allocated);
  view.setPathPreview(null);
  refreshAllocInfo();
  syncClassControls();
}

const classSel = document.getElementById('classSel') as HTMLSelectElement;
const ascendSel = document.getElementById('ascendSel') as HTMLSelectElement;

/** Redraw both dropdowns from `build`; the ascendancy list is class-dependent. */
function syncClassControls(): void {
  const classes = geometry.classes ?? [];
  classSel.innerHTML = '';
  for (const c of classes) {
    const opt = document.createElement('option');
    opt.value = c.name;
    opt.textContent = c.name;
    opt.selected = c.name === build.className;
    classSel.append(opt);
  }

  // "None" first, exactly as PoB's dropdown has it (PassiveTree.lua:160).
  ascendSel.innerHTML = '';
  const none = document.createElement('option');
  none.value = 'None';
  none.textContent = 'None';
  none.selected = build.ascendClassName === 'None';
  ascendSel.append(none);
  for (const a of geometry.ascendancies ?? []) {
    if (a.className !== build.className) continue;
    const opt = document.createElement('option');
    opt.value = a.id;
    opt.textContent = a.name;
    opt.selected = a.name === build.ascendClassName || a.id === build.ascendClassName;
    ascendSel.append(opt);
  }
}

classSel.addEventListener('change', () => selectClass(classSel.value));
ascendSel.addEventListener('change', () => {
  const id = ascendSel.value;
  const asc = (geometry.ascendancies ?? []).find((a) => a.id === id);
  build.ascendClassName = asc ? asc.name : 'None';
  allocated = selectAscendancy(asc?.id, allocated);
  view.setClass({ className: build.className, ascendClassName: build.ascendClassName });
  view.setAllocated(allocated);
  refreshAllocInfo();
});
syncClassControls();

// Clicking an unallocated node of another ascendancy is a class switch, not an
// allocation. The real client sends this to `build.setClass` and, when the
// engine reports a conflict, prompts before resetting the tree; the demo has no
// engine, so it takes the same-class case only and narrates the rest.
view.on('ascendancySelect', ({ node, ascendancyName, className, sameClass }) => {
  if (!sameClass) {
    toast.hidden = false;
    toast.textContent =
      `${ascendancyName} belongs to ${className}. The app asks the engine ` +
      `(build.setClass) here, because changing class can reset the tree.`;
    setTimeout(() => (toast.hidden = true), 5000);
    return;
  }
  build.ascendClassName = ascendancyName;
  syncClassControls();
  view.setClass({ className: build.className, ascendClassName: ascendancyName });
  allocated = selectAscendancy(node.ascendancy, allocated);
  allocated = allocNode(node.id, geometry.nodes, adjacency, allocated);
  view.setAllocated(allocated);
  view.setPathPreview(null);
  refreshAllocInfo();
});

// Clicking a mastery opens the chooser rather than allocating it: a mastery
// only counts as allocated once one of its effects is picked.
const chooser = new MasteryChooser(stage);

// The chooser covers the node the cursor is still on, so the tooltip would
// otherwise stay open behind it and spill its stat lines past the panel.
chooser.setOpenChangeHandler((open) => view.setTooltipSuppressed(open));

chooser.setHandler((nodeId, effectId) => {
  // Mirrors TreeTab:SaveMasteryPopup — the selection is recorded first, then
  // the node is allocated only if it is not already, and allocation brings the
  // whole path with it via AllocNode.
  if (effectId === null) {
    view.setMastery(nodeId, null);
  } else {
    view.setMastery(nodeId, effectId);
    if (!allocated.has(nodeId)) {
      allocated = allocNode(nodeId, geometry.nodes, adjacency, allocated);
      view.setAllocated(allocated);
      view.setPathPreview(null);
    }
  }

  // An effect may be used on only one mastery, so picking here can free or
  // consume an option elsewhere. The engine returns the refreshed table from
  // `tree.setMastery`; the demo recomputes it locally against the fixture.
  view.setMasteryEffects(recomputeMasteryAvailability());
  refreshAllocInfo();
  if (compareOn) applyCompare();
});

view.on('mastery', ({ node, effects, selected, screen }) => {
  chooser.show({ node, effects, selected }, screen.x, screen.y);
});

/** Mark every effect already spent on a *different* mastery as unavailable. */
function recomputeMasteryAvailability(): Record<number, MasteryEffect[]> {
  const takenBy = new Map<number, number>();
  for (const node of geometry.nodes) {
    if (node.type !== 'mastery') continue;
    const chosen = view.masterySelection(node.id);
    if (chosen !== null) takenBy.set(chosen, node.id);
  }

  const table: Record<number, MasteryEffect[]> = {};
  for (const node of geometry.nodes) {
    if (node.type !== 'mastery' || !node.masteryEffects) continue;
    table[node.id] = node.masteryEffects.map((effect) => {
      const owner = takenBy.get(effect.id);
      return { ...effect, available: owner === undefined || owner === node.id };
    });
  }
  return table;
}

// -------------------------------------------------------------- power stream

let powerTimer: number | null = null;

function stopPower(): void {
  if (powerTimer !== null) clearInterval(powerTimer);
  powerTimer = null;
}

/** A stand-in `tree.power` stream, ordered by path distance as the engine is. */
function fakePower(): NodePower[] {
  const dist = new Map<NodeId, number>();
  const queue: NodeId[] = [...allocated];
  for (const id of allocated) dist.set(id, 0);
  for (let h = 0; h < queue.length; h++) {
    const d = dist.get(queue[h])!;
    for (const nb of adjacency.get(queue[h]) ?? []) {
      if (dist.has(nb)) continue;
      dist.set(nb, d + 1);
      queue.push(nb);
    }
  }
  const out: NodePower[] = [];
  for (const n of geometry.nodes) {
    const cost = dist.get(n.id);
    if (cost === undefined || cost === 0) continue;
    const s =
      Math.sin(n.x * 0.00042 + 1.3) * Math.cos(n.y * 0.00042 - 0.7) +
      0.55 * Math.sin(n.x * 0.00097) * Math.cos(n.y * 0.00097);
    const weight = n.type === 'keystone' ? 3.4 : n.type === 'notable' ? 2.1 : 1;
    const gain = Math.max(0, (s + 1.3) * 34 * weight);
    const offence = gain * 0.6;
    out.push({ id: n.id, offence, defence: gain - offence, pathCost: cost, perPoint: gain / cost });
  }
  out.sort((a, b) => a.pathCost - b.pathCost || b.perPoint - a.perPoint);
  return out;
}

function runPower(): void {
  stopPower();
  const all = fakePower();
  view.clearPower();
  view.expectPower(all.length);
  view.setPowerVisible(true);

  const progress = document.getElementById('powerProgress')!;
  const legend = document.getElementById('powerLegend')!;
  const bar = document.getElementById('powerBar') as HTMLElement;
  const txt = document.getElementById('powerTxt')!;
  progress.hidden = false;
  legend.hidden = false;
  (document.getElementById('powerRamp') as HTMLElement).style.background = heatGradientCss(14);

  const started = performance.now();
  const totalMs = 9000; // half engine speed so the demo is watchable
  let sent = 0;
  powerTimer = window.setInterval(() => {
    const t = Math.min(1, (performance.now() - started) / totalMs);
    const target = Math.floor(all.length * Math.pow(t, 0.72));
    if (target > sent) {
      view.addPower(all.slice(sent, target), { done: target, total: all.length });
      sent = target;
    }
    bar.style.width = `${Math.round((sent / all.length) * 100)}%`;
    txt.textContent = `${sent} / ${all.length}`;
    if (t >= 1) {
      stopPower();
      view.addPower(all.slice(sent));
      view.finishPower(performance.now() - started);
      txt.textContent = `${all.length} scored`;
    }
  }, 120);
}

// -------------------------------------------------------------------- search

const searchInput = document.getElementById('search') as HTMLInputElement;
searchInput.addEventListener('input', () => {
  const info = document.getElementById('searchInfo')!;
  const terms = parseSearchQuery(searchInput.value);
  if (!terms.length) {
    view.setSearch(null);
    info.textContent = 'rings matches, dims the rest';
    return;
  }
  const hits = geometry.nodes.filter((n) => nodeMatchesSearch(n, terms)).map((n) => n.id);
  view.setSearch(hits);
  info.textContent = `${hits.length} match${hits.length === 1 ? '' : 'es'}`;
  if (hits.length && hits.length < 400) view.focusNodes(hits);
});

// ------------------------------------------------------------------- compare

let compareOn = false;

function applyCompare(): void {
  const list = [...allocated];
  const keep = new Set(list.slice(0, Math.ceil(list.length * 0.68)));
  const frontier: NodeId[] = [];
  for (const id of keep) for (const nb of adjacency.get(id) ?? []) if (!keep.has(nb)) frontier.push(nb);
  let i = 0;
  while (keep.size < list.length + 8 && frontier.length) {
    const id = frontier.splice((i = (i + 7) % frontier.length), 1)[0];
    if (keep.has(id)) continue;
    keep.add(id);
    for (const nb of adjacency.get(id) ?? []) if (!keep.has(nb)) frontier.push(nb);
  }
  const variant = [...keep];
  view.setCompare(list, variant);
  const added = variant.filter((id) => !allocated.has(id)).length;
  const removed = list.filter((id) => !keep.has(id)).length;
  document.getElementById('compareInfo')!.textContent = `+${added} added · −${removed} removed`;
}

// ------------------------------------------------------------------ controls

let jewelsOn = false;

document.getElementById('panel')!.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('button');
  if (!btn) return;
  switch (btn.dataset.act) {
    case 'alloc-demo':
      allocated = new Set(build.allocated);
      view.setAllocated(allocated);
      refreshAllocInfo();
      break;
    case 'alloc-clear':
      allocated = new Set(
        geometry.nodes.filter((n) => n.type === 'classStart').slice(0, 1).map((n) => n.id),
      );
      view.setAllocated(allocated);
      refreshAllocInfo();
      break;
    case 'power-run':
      runPower();
      break;
    case 'power-off':
      stopPower();
      view.setPowerVisible(false);
      document.getElementById('powerProgress')!.hidden = true;
      document.getElementById('powerLegend')!.hidden = true;
      break;
    case 'compare-on':
      compareOn = true;
      applyCompare();
      break;
    case 'compare-off':
      compareOn = false;
      view.setCompare(null, null);
      document.getElementById('compareInfo')!.textContent = 'green added · red removed';
      break;
    case 'zoom-in':
      view.zoomBy(1);
      break;
    case 'zoom-out':
      view.zoomBy(-1);
      break;
    case 'reset':
      view.resetView();
      break;
    case 'jewels': {
      jewelsOn = !jewelsOn;
      btn.dataset.on = jewelsOn ? '1' : '0';
      if (!jewelsOn) {
        view.setJewelRadii([]);
      } else {
        // The real radii, from PoB's `data.jewelRadius` for 3.16+ (Data.lua:610).
        // The last entry is a Thread of Hope-style annulus, which is why one of
        // these has a non-zero inner bound.
        const shapes = [
          { outer: 960, colour: 0xbb6600, label: 'Small' },
          { outer: 1440, colour: 0x66ffcc, label: 'Medium' },
          { outer: 1800, colour: 0x2222cc, label: 'Large' },
          { inner: 1680, outer: 2040, colour: 0x2222cc, label: 'Variable' },
        ];
        view.setJewelRadii(
          geometry.nodes
            .filter((n) => n.type === 'socket')
            .slice(0, 4)
            .map((n, i) => ({ nodeId: n.id, ...shapes[i % shapes.length] })),
        );
      }
      break;
    }
  }
});

// ----------------------------------------------------------------------- hud

document.getElementById('treeInfo')!.textContent =
  `${geometry.version} · ${geometry.nodes.length.toLocaleString()} nodes · ${geometry.connectors.length.toLocaleString()} connector quads`;

let lastHud = 0;
view.on('frame', () => {
  const now = performance.now();
  if (now - lastHud < 250) return;
  lastHud = now;
  const s = view.stats();
  const p = view.powerProgress;
  hud.innerHTML =
    `<b>${s.fps.toFixed(0)}</b> fps   <b>${s.frameMs.toFixed(2)}</b> ms/frame\n` +
    `${s.nodes.toLocaleString()} nodes · ${s.drawnConnectors.toLocaleString()} links drawn\n` +
    `${s.drawCalls} draw calls · zoom ${view.viewport.zoom.toFixed(2)}×\n` +
    `grid ${s.grid?.cells ?? 0} cells · max bucket ${s.grid?.maxBucket ?? 0}` +
    (p.expected ? `\npower ${p.received}/${p.expected}${p.done ? ' done' : ''}` : '') +
    (missing.length ? `\n${missing.length} sheets failed to load` : '');
});

toast.textContent = 'drag to pan · wheel to zoom · click to allocate · click a mastery to cycle its effect';
setTimeout(() => (toast.hidden = true), 6000);

Object.assign(globalThis as Record<string, unknown>, { view, geometry, build, runPower });
