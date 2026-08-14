# @poe-planner/tree-renderer

A PixiJS v8 renderer for the Path of Exile passive tree. Standalone Vite library
with its own demo page, meant to be imported by the Tauri shell.

```bash
npm install
npm run dev        # demo on http://localhost:5273
npm test           # vitest
npm run build      # ES module + .d.ts into dist/
npm run fixture    # write a synthetic geometry JSON
```

## Using it

```ts
import { TreeView } from '@poe-planner/tree-renderer';

const view = await TreeView.create({ container: document.getElementById('tree')! });
await view.load(geometry, { baseUrl: '/TreeData' }); // TreeGeometry from tree.geometry

view.setAllocated(summary.allocated);
view.on('hover', (info) => info && view.setPathPreview(pathFor(info.node.id)));
view.on('click', ({ node }) => allocate(node.id));
```

`load()` must be re-run after any jewel change: per the schema, cluster jewels
synthesise nodes and connectors at runtime, so the geometry is not static.

### The five overlays

| Feature | API |
| --- | --- |
| Allocation | `setAllocated(ids)`, `setPathPreview(ids \| null)`, `setSelected(ids)` |
| Value-per-point heatmap | `expectPower(n)` → `addPower(batch)` × many → `finishPower(ms)`; `setPowerVisible(on, metric?)`, `clearPower()` |
| Search | `setSearch(ids \| null)`, `focusNodes(ids)` |
| Compare | `setCompare(base, other)`, `setCompare(null, null)` to clear |
| Jewel radii | `setJewelRadii([{ nodeId, radii, colour }])` |

Tooltips are on by default; `setTooltipExtra(html \| element \| null)` fills the
slot at the bottom for the app's live stat delta.

Events: `hover`, `click`, `viewport`, `frame`. Each `on()` returns an unsubscribe.

### Heatmap streaming

`tree.power` takes ~18 s for a full pass and streams `tree.power.progress`
ordered by path distance, so the map is always partial for most of its life.
Wire it straight through:

```ts
const { requested } = await rpc('tree.power', { metric: 'offence', maxDepth: 6 });
view.expectPower(requested);
view.setPowerVisible(true);
onNotification('tree.power.progress', (p) => view.addPower(p.nodes, p));
onNotification('tree.power.done',     (p) => view.finishPower(p.elapsedMs));
```

Nodes the engine has not reached yet are rendered dim and slate with an animated
dashed ring (shown once a node is large enough on screen to read it), so
"unscored" never gets confused with "scored low". Colour normalisation uses the
2nd/98th percentile of everything received so far, not min/max — a single
outlier keystone arriving late cannot flatten the rest of the map. Allocated
nodes switch to a cool white while the map is up, because the normal allocated
gold is close enough to the hot end of the ramp to be misread.

The ramp itself is inferno-style (near-black → purple → red → yellow) and
increases monotonically in lightness, so it survives greyscale and red/green
colour deficiency. `heatColour(t)` and `heatGradientCss()` are exported for
legends.

## How it renders

**Connectors are quads with independent UVs per corner.** Orbit arcs are curved,
and PoB draws them by mapping a slice of an arc sprite onto a rotated quad —
something Canvas 2D's `drawImage` cannot express. `TreeConnector.verts` and
`.uvs` go into the vertex buffer verbatim; nothing is reinterpreted.

Draw order follows PoB's layer numbering: group backgrounds → masteries (15) →
connectors (20) → node art (25) → frames → highlight rings → jewel radii →
hover. The whole scene is **11 draw calls** — one textured mesh per atlas sheet
per layer, plus four procedural ring meshes.

Three custom shader programs (GLSL for WebGL, WGSL alongside it):

- **static quads** — connectors and group art; per-vertex colour drives every
  state change without touching geometry.
- **node quads** — centre and corner offset are separate attributes, so a hover
  "pop" is one float per vertex rather than four recomputed corners.
- **rings** — analytic signed-distance fields. Solid, animated-dashed, soft glow
  and filled disc. A 1500-unit jewel radius circle is exactly as crisp as a
  30-unit hover ring, at any zoom, because the shape is evaluated per pixel
  instead of sampled from a scaled bitmap.

Attributes live in separate buffers with per-attribute dirty high-water marks,
so recolouring the tree re-uploads ~50 KB rather than the whole vertex block.
Sheets get trilinear mipmaps when they are power-of-two, which is the single
biggest quality win when zoomed out.

**Hit testing is a uniform spatial hash**, not the linear scan over every node
that `PassiveTreeView.lua:297-307` does on every frame. `minGrabPx` keeps a
constant on-screen grab radius as nodes shrink, and overlapping nodes resolve in
favour of the smaller one so a notable on top of a socket stays clickable.

## Measured

Chrome/WebGL, 1600×1000, synthetic tree of **3,242 nodes / 7,403 connector
quads / 167 groups**, 11 draw calls.

| | |
| --- | --- |
| Pan, whole tree visible | **0.027 ms/frame** |
| Pan, zoomed in | **0.044 ms/frame** |
| Pan with heatmap + pending rings | **0.018 ms/frame** |
| Hit test | **0.23 µs/pick** |
| Hit test, PoB-style linear scan | 5.21 µs/pick (**23× slower**) |
| Full restyle (recolour every node and connector) | 3.7 ms |
| Rebuild every decoration ring | 0.30 ms |
| Merge one power batch + restyle + redraw | 8.9 ms |

Steady-state pan/zoom is ~0.03 ms of the 16.7 ms frame budget, so 60 fps is not
in question; the costs that matter are the state-change passes, and the worst of
them (a power batch) still fits twice over in one frame. The renderer idles
without redrawing when nothing is moving and no shader animation is live.

## Synthetic fixtures

Track 1 owns the real `fixtures/geometry-3_29.json`. Until it lands,
`generateTree()` builds a tree with the same *shape* — groups on concentric
rings, nodes on discrete orbit slots, orbit arcs as rotated quads sampling an
arc sprite — and `paintAtlas()` paints its atlas sheets in the browser, so the
demo needs no binary assets. `simulatePower()` and `growAllocation()` fake the
engine well enough to exercise the streaming path.

The generator deliberately emits **pixel** UVs, the riskier reading of the
schema, so the normalisation path is exercised by default.

## Notes on the schema

`schema/rpc.d.ts` was not edited. Three things came up:

1. **`TreeConnector` cannot express its own state variants.** It carries one
   `state` and one `uvs` set, but the renderer is required to "swap per
   allocation state" — and there is no way to derive the other two variants'
   UVs from the contract. Without them the renderer tints the delivered art,
   which looks fine but is not PoB's `LineConnector{Normal,Intermediate,Active}`
   art swap. `setConnectorVariants()` accepts the missing UVs as a side channel;
   the clean fix is for the connector to carry all three, e.g.
   `uvs: Record<ConnectorState, [Point,Point,Point,Point]>`.

2. **UV units are unspecified.** `sprites` are clearly pixel rects, but
   `TreeConnector.uvs` says only "matching texture coordinates into `sheet`".
   The renderer sniffs it: any component outside 0..1 means pixels. Worth
   pinning down in the contract.

3. **`TreeNode.radius` and the sprite size can disagree.** The comment says the
   radius is "derived from the node's art width", but nothing enforces it. The
   renderer defaults to `fitSpriteToRadius`, scaling art so its width is exactly
   `2 * radius`, which guarantees what you can click is what you can see. Set
   `fitSpriteToRadius: false` to draw sprites at their native pixel size.

Minor: `Notifications['tree.power.progress']` has `done`/`total`, but
`Methods['tree.power'].result` only has `requested` — the renderer treats
`requested` as the expected total and lets `total` override it later.
