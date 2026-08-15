/**
 * "Selecting this gem will give you: …"
 *
 * PoB's signature affordance: hover a thing you might change and it tells you
 * what would happen, before you change it. One component serves all four
 * surfaces — a gem in the picker, a quality field, a gem's enable box, a config
 * option — because on the engine side they are all the same call.
 *
 * **Why this is debounced and not eager.** Each answer costs a full
 * recalculation of the build, and the engine produces it by editing the live
 * build and editing it back, so two in flight would interleave two mutations
 * over one build. `session.compare` serialises them and drops superseded ones;
 * the delay here is what stops a pointer sweeping down a gem list from queueing
 * forty calculations it will never read.
 *
 * PoB debounces the same way, by frame count rather than milliseconds
 * (`GemSelectControl.lua:573-580`).
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Methods, StatDelta } from "@schema/rpc";
import type { EngineSession } from "../engine/session";
import { groupThousands, printf, signedSpec } from "../format/stat-format";

type Change = Methods["stats.compare"]["params"]["change"];
type Result = Methods["stats.compare"]["result"];

/** Long enough that sweeping a list costs nothing, short enough to feel live. */
const HOVER_DELAY_MS = 220;

export function CompareTip({
  session,
  change,
  header,
  className,
  children,
}: {
  session: EngineSession;
  /** Omit to disable the tip — for a control that has nothing to compare. */
  change: Change | null;
  header: string;
  className?: string;
  children: ReactNode;
}) {
  const [result, setResult] = useState<Result | null>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const host = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The change object is rebuilt on every render, so it cannot be a dependency
  // of anything. It is only ever read at the moment a hover fires.
  const latest = useRef(change);
  latest.current = change;
  /** Which hover the pending answer belongs to. See `open`. */
  const hover = useRef(0);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const open = () => {
    const pending = latest.current;
    if (!pending) return;
    // The wrapper is `display: contents` so that putting a tip on a control
    // cannot change the row it sits in — which also means it generates no box
    // of its own, and its own rect is all zeroes. Measure the control instead.
    const rect = (host.current?.firstElementChild ?? host.current)?.getBoundingClientRect() ?? null;
    if (timer.current) clearTimeout(timer.current);
    // Bumped by every open *and* every close, so an answer that arrives after
    // the pointer has moved on is discarded. Without it the tip would appear
    // under a cursor that is somewhere else entirely, describing a control the
    // user is no longer looking at.
    const generation = ++hover.current;
    timer.current = setTimeout(() => {
      void session.compare(pending).then((res) => {
        if (generation !== hover.current) return;
        setAnchor(rect);
        setResult(res);
      });
    }, HOVER_DELAY_MS);
  };

  const close = () => {
    if (timer.current) clearTimeout(timer.current);
    hover.current++;
    setResult(null);
    setAnchor(null);
  };

  return (
    <span
      ref={host}
      className={`cmptip-host ${className ?? ""}`}
      onPointerEnter={open}
      onPointerLeave={close}
      onFocus={open}
      onBlur={close}
    >
      {children}
      {result && anchor && <TipPanel header={header} result={result} at={anchor} />}
    </span>
  );
}

/**
 * Rendered into `document.body` rather than in place: the panel is wider than
 * the gem rows and config rows it hangs off, and both of those live inside
 * scrolling containers that would clip it.
 */
function TipPanel({
  header,
  result,
  at,
}: {
  header: string;
  result: Result;
  at: DOMRect;
}) {
  const empty = result.stats.length === 0 && !result.minion?.length;

  // Flip above the anchor when there is not room below. A rough height is
  // enough — the panel is short and the only thing being avoided is a tip that
  // opens off the bottom of the window.
  const estimated = 40 + (result.stats.length + (result.minion?.length ?? 0)) * 20;
  const below = at.bottom + 6;
  const flip = below + estimated > window.innerHeight && at.top > estimated;

  const style: React.CSSProperties = {
    left: Math.min(at.left, Math.max(8, window.innerWidth - 340)),
    ...(flip ? { bottom: window.innerHeight - at.top + 6 } : { top: below }),
  };

  return createPortal(
    <div className="cmptip" role="tooltip" style={style}>
      <p className="cmptip__head">{header}</p>
      {empty ? (
        <p className="cmptip__none">No change.</p>
      ) : (
        <>
          <DeltaList rows={result.stats} />
          {result.minion?.length ? (
            <>
              <p className="cmptip__sub">Minion</p>
              <DeltaList rows={result.minion} />
            </>
          ) : null}
        </>
      )}
    </div>,
    document.body,
  );
}

function DeltaList({ rows }: { rows: StatDelta[] }) {
  return (
    <ul className="cmptip__rows">
      {rows.map((row) => (
        <li key={row.key} className={`cmptip__row cmptip__row--${row.better ? "good" : "bad"}`}>
          <span className="cmptip__delta">{formatDeltaValue(row)}</span>
          <span className="cmptip__label">{row.label}</span>
          {formatPercent(row) && <span className="cmptip__pct">{formatPercent(row)}</span>}
        </li>
      ))}
    </ul>
  );
}

/**
 * `+1,204` — the stat's own printf spec, forced to carry its sign.
 *
 * Infinities arrive as strings, because JSON has no way to spell them; they
 * pass through as-is rather than through a numeric format that would print
 * "NaN".
 */
function formatDeltaValue(row: StatDelta): string {
  if (typeof row.delta !== "number") return row.delta ?? "—";
  return groupThousands(printf(signedSpec(row.format), row.delta));
}

function formatPercent(row: StatDelta): string | null {
  if (typeof row.percent !== "number" || !Number.isFinite(row.percent)) return null;
  if (Math.abs(row.percent) < 0.05) return null;
  const text = row.percent.toFixed(1).replace(/\.0$/, "");
  return `${row.percent > 0 ? "+" : ""}${text}%`;
}
