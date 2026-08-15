/**
 * The tree area: the renderer, plus the heatmap controls.
 *
 * The heatmap is the one operation where the UI has to be honest about time.
 * A full pass is ~18 s at ~9 ms per node, but results stream back ordered by
 * path distance, so the nodes within a few points arrive in the first couple of
 * seconds. The bar therefore shows progress *and* the running best list, and
 * cancelling is always one click away.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { NodeId, TreeGeometry } from "@schema/rpc";
import {
  createTreeRenderer,
  IS_STUB,
  type AscendancySelection,
  type TreeRenderer,
} from "@poe-planner/tree-renderer";
import type { ClassChangeConflict, EngineSession } from "../engine/session";
import { useStore } from "../state/store";
import { compactNumber } from "../format/stat-format";
import { Button, Modal, Segmented } from "./primitives";

type Metric = "offence" | "defence";

/** A class change the engine refused to make unasked, plus what provoked it. */
interface PendingClassChange {
  target: AscendancySelection;
  conflict: ClassChangeConflict;
}

export function TreeStage({ session }: { session: EngineSession }) {
  const { build, heatmap, connection } = useStore(session.store, (s) => ({
    build: s.build,
    heatmap: s.heatmap,
    connection: s.connection,
  }));
  const [metric, setMetric] = useState<Metric>("offence");
  const [depth, setDepth] = useState(3);
  const [geometry, setGeometry] = useState<TreeGeometry | null>(null);
  const [pendingClass, setPendingClass] = useState<PendingClassChange | null>(null);
  const [classBusy, setClassBusy] = useState(false);
  const [search, setSearch] = useState("");

  const hostRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<TreeRenderer | null>(null);

  // Geometry has to be re-fetched after any jewel change (cluster jewels
  // synthesise nodes at runtime), so it is keyed on the tree version only for
  // now — jewel edits are not implemented in this track.
  useEffect(() => {
    if (connection !== "ready" || !build) return;
    let cancelled = false;
    void session.client
      .call("tree.geometry", {})
      .then((g) => {
        if (!cancelled) setGeometry(g);
      })
      .catch(() => {
        /* the stub renders fine without geometry */
      });
    return () => {
      cancelled = true;
    };
  }, [connection, build?.treeVersion, session]);

  useEffect(() => {
    if (!hostRef.current) return;
    const renderer = createTreeRenderer();
    renderer.mount(hostRef.current);
    rendererRef.current = renderer;

    // A hidden tab panel measures 0x0, and resizing the canvas to that is worse
    // than doing nothing: it discards the viewport and there is nothing to draw
    // into. Skip it and keep the last good size, which is the one we want back
    // when the tab returns anyway.
    const onResize = () => {
      const box = hostRef.current?.getBoundingClientRect();
      if (!box || box.width < 1 || box.height < 1) return;
      renderer.resize();
    };

    // Clicking an unallocated node of an ascendancy the build does not have is
    // a class switch. The engine will not make a destructive one unasked, so a
    // conflict comes back here as a prompt rather than a silent reset.
    const offAscendancy = renderer.on("ascendancySelect", (target) => {
      void session.selectAscendancy(target).then((res) => {
        if (res.kind === "conflict") setPendingClass({ target, conflict: res.conflict });
      });
    });

    // Left click allocates, and takes the whole route with it; clicking a node
    // you already own removes it and anything that only hung off it, which the
    // engine reports back as `orphaned`. PoB's own binding
    // (PassiveTreeView.lua:389-392).
    const offClick = renderer.on("nodeClick", (id) => {
      const owned = session.store.getState().build?.allocated ?? [];
      if (owned.includes(id)) void session.deallocate([id]);
      else void session.allocate([id]);
      renderer.setPathPreview(null);
    });

    // Hovering an unallocated node previews the route a click would take. The
    // engine already has the path cached on the node, so `tree.path` is a read
    // rather than a recompute — but hovers arrive faster than round trips, so
    // stale answers are dropped instead of painting the wrong route.
    let hoverSeq = 0;
    const offHover = renderer.on("nodeHover", (id) => {
      const seq = ++hoverSeq;
      if (id === null) {
        renderer.setPathPreview(null);
        return;
      }
      const owned = session.store.getState().build?.allocated ?? [];
      if (owned.includes(id)) {
        renderer.setPathPreview(null);
        return;
      }
      void session.client
        .call("tree.path", { to: id })
        .then((res) => {
          if (seq === hoverSeq) renderer.setPathPreview(res.path);
        })
        .catch(() => {
          // Unreachable nodes are an error from the engine, not a failure:
          // there is simply no route to preview.
          if (seq === hoverSeq) renderer.setPathPreview(null);
        });
    });

    // Clicking a mastery opens the renderer's chooser rather than allocating;
    // the pick lands here. The engine returns refreshed availability for every
    // mastery, because taking an effect can remove it from another's list —
    // each effect may be used only once across the tree (TreeTab.lua:1019).
    const offMastery = renderer.on("masterySelect", ({ node, effect }) => {
      void session.setMastery(node, effect).then((table) => {
        if (table) renderer.setMasteryEffects(table);
      });
    });

    window.addEventListener("resize", onResize);

    // The window is not the only thing that resizes the canvas. The tree lives
    // in a tab panel that is hidden rather than unmounted, so it goes to 0x0
    // and back without the window changing size at all; on the way back the
    // canvas would keep the dead viewport and draw nothing. Observing the host
    // covers that and any future layout change for free.
    const observer = new ResizeObserver(onResize);
    observer.observe(hostRef.current);

    return () => {
      window.removeEventListener("resize", onResize);
      observer.disconnect();
      offAscendancy();
      offClick();
      offHover();
      offMastery();
      renderer.destroy();
      rendererRef.current = null;
    };
  }, [session]);

  useEffect(() => {
    if (geometry) rendererRef.current?.setGeometry(geometry);
  }, [geometry]);

  useEffect(() => {
    rendererRef.current?.setAllocated(build?.allocated ?? []);
  }, [build?.allocated]);

  useEffect(() => {
    rendererRef.current?.setMasterySelections(build?.masterySelections ?? {});
  }, [build?.masterySelections]);

  // Jewel radii depend on what is socketed *and* on which sockets are
  // allocated — PoB only draws a jewel's radius on an allocated socket
  // (PassiveTreeView.lua:1235) — so this re-runs with the allocation set.
  useEffect(() => {
    if (connection !== "ready" || !build) return;
    let cancelled = false;
    void session.jewelRadii().then((res) => {
      if (cancelled || !res) return;
      rendererRef.current?.setJewelRadii(
        res.sockets
          // A socket with a jewel but no radius still gets its own art — a
          // cluster jewel makes a subgraph rather than a radius — so the
          // filter is "allocated and interesting", not "allocated and round".
          // PoB gates the socket tooltip on the socket being allocated
          // (`PassiveTreeView.lua:1479`), so this does too. `item` is in the
          // test because a jewel whose base has no overlay art still has a
          // tooltip worth showing.
          .filter((s) => s.allocated && (s.outer !== undefined || s.socketArt || s.item))
          .map((s) => ({
            nodeId: s.node,
            outer: s.outer,
            socketArt: s.socketArt,
            inner: s.inner ?? 0,
            colour: s.colour ? Number.parseInt(s.colour, 16) : undefined,
            label: s.label,
            // The jewel's ring artwork, already resolved by the engine: which
            // rings, how big, at what angle, and where.
            rings: s.rings,
            // The socket's tooltip is the jewel's tooltip, as in PoB. Dropping
            // this left every socket reading "Jewel Socket" with no way to see
            // which jewel — or which timeless seed — was actually in it.
            item: s.item,
          })),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [connection, build?.allocated, session]);

  // Without this the renderer cannot tell one of your own ascendancy's nodes
  // from a foreign one, and every ascendancy click reads as a class switch.
  useEffect(() => {
    rendererRef.current?.setClass(
      build ? { className: build.className, ascendClassName: build.ascendClassName } : null,
    );
  }, [build?.className, build?.ascendClassName]);

  /** Answer the engine's prompt and let the original click finish. */
  const resolveClassChange = async (onConflict: "connect" | "reset") => {
    if (!pendingClass) return;
    setClassBusy(true);
    const res = await session.selectAscendancy(pendingClass.target, onConflict);
    setClassBusy(false);
    // A second conflict would mean the engine changed its mind mid-prompt;
    // keep the dialog up rather than dismissing it on an unapplied change.
    if (res.kind !== "conflict") setPendingClass(null);
  };

  // Normalise the streamed power values to 0..1 for the renderer.
  useEffect(() => {
    if (!heatmap) return;
    const max = heatmap.nodes[0]?.perPoint ?? 0;
    const map = new Map<NodeId, number>();
    if (max > 0) {
      for (const n of heatmap.nodes) map.set(n.id, n.perPoint / max);
    }
    rendererRef.current?.setPower(map);
  }, [heatmap]);

  const nodeNames = useMemo(() => {
    const m = new Map<NodeId, string>();
    for (const n of geometry?.nodes ?? []) m.set(n.id, n.name);
    return m;
  }, [geometry]);

  // PoB searches as you type, but its matcher runs in-process; ours is a round
  // trip over the sidecar that walks all 2,900 nodes, so it is debounced.
  useEffect(() => {
    if (connection !== "ready") return;
    const q = search.trim();
    if (!q) {
      rendererRef.current?.setHighlight([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      void session.search(q).then((ids) => {
        if (!cancelled) rendererRef.current?.setHighlight(ids);
      });
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [search, connection, build?.allocated, session]);

  const pct = heatmap && heatmap.total > 0 ? (heatmap.done / heatmap.total) * 100 : 0;

  return (
    <div className="stage">
      <div className="stage__canvas" ref={hostRef} />

      <div className="heatbar">
        <input
          className="input"
          style={{ width: 190, height: 30, fontSize: 12.5 }}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search nodes…"
          aria-label="Search passive nodes"
        />
        <span className="heatbar__label">Value per point</span>
        <Segmented<Metric>
          value={metric}
          options={[
            { value: "offence", label: "Offence" },
            { value: "defence", label: "Defence" },
          ]}
          onChange={(m) => {
            setMetric(m);
            if (heatmap?.running) session.startHeatmap(m, depth);
          }}
        />
        <select
          className="select"
          style={{ width: 128, height: 30, fontSize: 12.5 }}
          value={depth}
          onChange={(e) => setDepth(Number(e.target.value))}
          title="How far from the allocated tree to search"
        >
          <option value={2}>Within 2 points</option>
          <option value={3}>Within 3 points</option>
          <option value={5}>Within 5 points</option>
          <option value={99}>Whole tree (~18 s)</option>
        </select>

        {heatmap?.running ? (
          <>
            <div className="heatbar__progress">
              <div className="heatbar__fill" style={{ width: `${pct}%` }} />
            </div>
            <span className="heatbar__count">
              {heatmap.done.toLocaleString()} / {heatmap.total.toLocaleString()}
            </span>
            <Button size="sm" onClick={() => session.cancelHeatmap()}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            <div style={{ flex: 1 }} />
            {heatmap?.elapsedMs != null && (
              <span className="heatbar__count">
                done in {(heatmap.elapsedMs / 1000).toFixed(1)}s
              </span>
            )}
            {heatmap?.error && (
              <span className="heatbar__count" style={{ color: "var(--bad)" }}>
                {heatmap.error}
              </span>
            )}
            <Button
              size="sm"
              variant="primary"
              disabled={connection !== "ready" || !build}
              onClick={() => session.startHeatmap(metric, depth)}
            >
              {heatmap ? "Recalculate" : "Find best nodes"}
            </Button>
          </>
        )}
      </div>

      {heatmap && heatmap.nodes.length > 0 && (
        <div className="heat-results">
          {heatmap.nodes.slice(0, 40).map((n, i) => (
            <div className="heat-row" key={`${n.id}-${i}`}>
              <span className="heat-row__rank">{i + 1}</span>
              <span className="heat-row__name">
                {nodeNames.get(n.id) ?? `Node ${n.id}`}
              </span>
              <span className="heat-row__cost">
                {n.pathCost} pt{n.pathCost === 1 ? "" : "s"}
              </span>
              <span className="heat-row__value">{compactNumber(n.perPoint)}</span>
            </div>
          ))}
          {IS_STUB && (
            <div className="field__hint" style={{ padding: "8px 10px" }}>
              Node names come from <code>tree.geometry</code>; the highlight overlay lands
              with the real renderer.
            </div>
          )}
        </div>
      )}

      {pendingClass && (
        <Modal
          title="Class Change"
          onClose={() => setPendingClass(null)}
          footer={
            <>
              <Button onClick={() => setPendingClass(null)} disabled={classBusy}>
                Cancel
              </Button>
              {/* PoB offers these two, in this order, and phrases them exactly
                  so (PassiveTreeView.lua:473-491). "Continue" is the
                  destructive one, which is why it is not the primary button. */}
              <Button onClick={() => void resolveClassChange("reset")} busy={classBusy}>
                Continue
              </Button>
              <Button
                variant="primary"
                onClick={() => void resolveClassChange("connect")}
                busy={classBusy}
              >
                Connect Path
              </Button>
            </>
          }
        >
          {/* The engine writes this message, newline and all; it names the
              class and both ways out, so the UI adds nothing to it. */}
          <p style={{ whiteSpace: "pre-wrap", lineHeight: 1.6 }}>
            {pendingClass.conflict.message}
          </p>
        </Modal>
      )}
    </div>
  );
}
