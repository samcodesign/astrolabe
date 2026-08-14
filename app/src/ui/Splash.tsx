/**
 * Startup.
 *
 * The host takes ~4.2 s to boot before it answers anything, and the first
 * `build.load` for a tree version adds ~5 s on top. A spinner for nine seconds
 * reads as a hang, so this screen names each step, times it, and mirrors what
 * the engine says it is doing via `host.busy`.
 */

import { useEffect, useState } from "react";
import type { AppState, ConnectionPhase } from "../engine/session";
import { Banner, Button } from "./primitives";

interface StepDef {
  id: string;
  label: string;
  /** Phases during which this step is the one in progress. */
  active: ConnectionPhase[];
  done: (s: AppState) => boolean;
  /** Roughly how long it takes, so the wait feels bounded. */
  expect?: string;
}

const STEPS: StepDef[] = [
  {
    id: "spawn",
    label: "Starting the calculation engine",
    active: ["idle", "spawning"],
    done: (s) => s.connection !== "idle" && s.connection !== "spawning",
  },
  {
    id: "boot",
    label: "Loading Path of Building modules",
    active: ["handshake"],
    done: (s) => s.hostInfo !== null,
    expect: "~4 s",
  },
  {
    id: "ready",
    label: "Ready",
    active: [],
    done: (s) => s.connection === "ready",
  },
];

export function Splash({
  state,
  onRetry,
  onRepairData,
  repairNote,
}: {
  state: AppState;
  onRetry: () => void;
  /**
   * Offered alongside "Try again" when the engine will not start.
   *
   * The most likely reason it will not start is that its game data is
   * incomplete — delete one file PoB loads at boot and the host dies during
   * init. Retrying re-runs the same broken load forever, and the repair the app
   * already knows how to do is only reachable from the toolbar, which needs a
   * *running* engine. That is a dead end with no way out; this is the way out.
   */
  onRepairData?: () => void;
  /** Result of a repair attempt, when it had nothing to fix or itself failed. */
  repairNote?: string | null;
}) {
  const elapsed = useElapsed(state.connection !== "ready" && state.connection !== "failed");
  const failed = state.connection === "failed";

  let activeIndex = STEPS.findIndex((s) => !s.done(state));
  if (activeIndex < 0) activeIndex = STEPS.length - 1;

  return (
    <div className="splash">
      <div className="splash__card">
        <div className="splash__mark" />
        <div>
          <h1 className="splash__title">PoE Planner</h1>
          <p className="splash__sub">
            {failed
              ? "The calculation engine could not be started."
              : "Path of Building's calculation engine runs as a separate process. It boots once, then every edit recomputes in about 80 ms."}
          </p>
        </div>

        {!failed && (
          <div className="splash__steps">
            {STEPS.map((step, i) => {
              const done = step.done(state);
              const isActive = !done && i === activeIndex;
              return (
                <div
                  key={step.id}
                  className={`step ${done ? "step--done" : ""} ${isActive ? "step--active" : ""}`}
                >
                  <span className="step__mark">
                    {done ? "✓" : isActive ? <span className="spinner" /> : ""}
                  </span>
                  <span>{step.label}</span>
                  <span className="step__time">
                    {isActive
                      ? `${(elapsed / 1000).toFixed(1)}s${step.expect ? ` / ${step.expect}` : ""}`
                      : done
                        ? ""
                        : (step.expect ?? "")}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {!failed && (
          <div className="splash__busy">
            {state.busy ? (
              <>
                <span className="dot dot--busy" />
                {state.busy.what} — {(state.busy.elapsedMs / 1000).toFixed(1)}s
              </>
            ) : null}
          </div>
        )}

        {failed && (
          <div className="splash__error">
            <Banner kind="error" detail={state.log.slice(-12).join("\n") || undefined}>
              {state.connectionError ?? "Unknown failure."}
            </Banner>
          </div>
        )}

        {state.log.length > 0 && !failed && (
          <div className="splash__log selectable">
            {state.log.slice(-6).map((line, i) => (
              <div key={i}>{line}</div>
            ))}
          </div>
        )}

        {failed && repairNote && (
          <div className="splash__error">
            <Banner kind="info">{repairNote}</Banner>
          </div>
        )}

        {failed && (
          <div className="splash__actions">
            <Button variant="primary" onClick={onRetry}>
              Try again
            </Button>
            {onRepairData && (
              <Button variant="ghost" onClick={onRepairData}>
                Repair game data
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function useElapsed(running: boolean): number {
  const [ms, setMs] = useState(0);
  useEffect(() => {
    if (!running) return;
    const started = Date.now();
    const t = setInterval(() => setMs(Date.now() - started), 100);
    return () => clearInterval(t);
  }, [running]);
  return ms;
}
