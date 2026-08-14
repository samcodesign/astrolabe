/**
 * First run: fetching Path of Building's game data.
 *
 * The installer ships no game data, so on a fresh machine this is the very
 * first thing the app does — before the engine can even start. It is a ~240 MB
 * download that takes tens of seconds, which reads as a hang unless the screen
 * says what is happening and how far along it is.
 */

import { useEffect, useState } from "react";
import {
  availableTreeVersions,
  type DataProgress,
  type DataStatus,
  installData,
  treeVersionLabel,
} from "../platform/gamedata";
import { DataProgressView } from "./DataProgress";
import { Banner, Button } from "./primitives";

/**
 * Only until the real list arrives, and only so the screen has something to say
 * before the network answers. Pulling every version would turn a 240 MB first
 * run into 554 MB of history nobody asked for, so this stays a single tree.
 */
const FALLBACK_TREE_VERSION = "3_29";

type Phase = "idle" | "working" | "failed";

export function FirstRun({
  status,
  onReady,
}: {
  status: DataStatus;
  onReady: (next: DataStatus) => void;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<DataProgress | null>(null);
  // Two very different failures share this slot: a download that broke, which
  // resumes on retry, and a configuration that makes the download pointless,
  // which retrying will not fix. They need different words.
  const [error, setError] = useState<{ headline: string; detail: string } | null>(null);
  // Resolved from upstream so the app is never pinned to a version by a literal.
  // Null until the list arrives; the fallback covers a check that never answers.
  const [latest, setLatest] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void availableTreeVersions()
      .then((v) => {
        if (!cancelled && v[0]) setLatest(v[0]);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const treeVersion = latest ?? FALLBACK_TREE_VERSION;

  // Nothing to decide when the updater is missing — that is a broken install,
  // not a choice.
  const blocked = !status.updaterAvailable;

  async function run() {
    setPhase("working");
    setError(null);
    setProgress(null);
    try {
      const next = await installData([treeVersion], setProgress);
      if (!next.ready) {
        // The download succeeded and the app still cannot start, which happens
        // for exactly one reason: POB_PATH is set and points somewhere that is
        // not a usable Path of Building. It wins the search deliberately — an
        // explicit override should not be quietly overruled — so the only way
        // out is to say so and name the path, rather than sit on "Done".
        setError({
          headline: "The data downloaded, but POB_PATH points somewhere else.",
          detail: [
            `Installed to ${next.managedRoot ?? "the app data directory"}`,
            `POB_PATH is ${next.root ?? "set to another location"}, which is not a usable Path of Building.`,
            "Unset POB_PATH and restart, or point it at a real checkout.",
          ].join("\n"),
        });
        setPhase("failed");
        return;
      }
      onReady(next);
    } catch (e) {
      setError({
        headline:
          "The download did not finish. Verified files were kept, so trying again resumes rather than starting over.",
        detail: String(e),
      });
      setPhase("failed");
    }
  }

  return (
    <div className="splash">
      <div className="splash__card">
        <div className="splash__mark" />
        <div>
          <h1 className="splash__title">PoE Planner</h1>
          <p className="splash__sub">
            {blocked
              ? "This installation is missing the updater, so it cannot fetch game data."
              : phase === "working"
                ? "Fetching Path of Building's game data. This happens once."
                : "Before the first build, the app needs Path of Building's game data — the passive trees, skills, uniques and mod definitions the calculations are built on."}
          </p>
        </div>

        {phase === "working" && <DataProgressView progress={progress} />}

        {phase !== "working" && !blocked && (
          <div className="splash__busy">
            About 240 MB, once. Tree {treeVersionLabel(treeVersion)}.
          </div>
        )}

        {/* A dev checkout or POB_PATH is in use. Downloading would not update it
            — it installs our own copy alongside and then takes precedence — so
            say that instead of offering a bare "Download". */}
        {!status.updatable && status.ready && (
          <div className="splash__error">
            <Banner kind="info" detail={status.root ?? undefined}>
              Using an existing Path of Building on this machine. Downloading will install a
              separate managed copy and use that instead.
            </Banner>
          </div>
        )}

        {error && (
          <div className="splash__error">
            <Banner kind="error" detail={error.detail}>
              {error.headline}
            </Banner>
          </div>
        )}

        {!blocked && phase !== "working" && (
          <Button variant="primary" onClick={() => void run()}>
            {phase === "failed" ? "Try again" : "Download game data"}
          </Button>
        )}
      </div>
    </div>
  );
}
