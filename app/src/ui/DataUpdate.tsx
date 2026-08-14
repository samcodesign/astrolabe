/**
 * Applying a game-data update while the app is running.
 *
 * PoB's maintainers republish game data every league, and the whole reason the
 * data is fetched rather than bundled is so that arrives on its own. The check
 * runs in the background once the tree is up; this is what the user sees when
 * it finds something.
 */

import { useState } from "react";
import type { EngineSession } from "../engine/session";
import {
  type DataProgress,
  type UpdateInfo,
  installData,
  treeVersionLabel,
} from "../platform/gamedata";
import { DataProgressView, formatBytes } from "./DataProgress";
import { Banner, Button, Modal } from "./primitives";

/**
 * Same manifest version on both sides means nothing was published upstream;
 * what changed is the copy on disk, so this is a repair rather than an update.
 */
export function isRepairOnly(info: UpdateInfo): boolean {
  return info.localVersion !== null && info.localVersion === info.remoteVersion;
}

/** The non-modal notice. Persistent state, so not a toast. */
export function UpdateChip({ info, onOpen }: { info: UpdateInfo; onOpen: () => void }) {
  const repair = isRepairOnly(info);
  return (
    <button
      className="update-chip"
      onClick={onOpen}
      title={
        repair
          ? "Some Path of Building game data is missing or has changed"
          : "New Path of Building game data is available"
      }
    >
      <span className="dot dot--busy" />
      {repair ? "Repair data" : "Update available"}
    </button>
  );
}

type Phase = "idle" | "working" | "failed" | "done";

export function UpdateDialog({
  info,
  session,
  onClose,
  onApplied,
}: {
  info: UpdateInfo;
  session: EngineSession;
  onClose: () => void;
  onApplied: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<DataProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setPhase("working");
    setError(null);
    try {
      // The versions this copy already vendors, not today's default — a user
      // who added an older tree must not silently lose it to an update.
      await installData(info.treeVersions, setProgress);
      setPhase("done");
      // Files on disk mean nothing until the engine re-reads them. The session
      // captures the build, restarts, and restores it.
      await session.reloadEngine("New game data installed. Restarting the engine…");
      onApplied();
    } catch (e) {
      setError(String(e));
      setPhase("failed");
    }
  }

  const size = info.bytes > 0 ? formatBytes(info.bytes) : null;
  const versions = info.treeVersions.map(treeVersionLabel).join(", ");
  const isRepair = isRepairOnly(info);

  return (
    <Modal
      title={isRepair ? "Repair game data" : "Game data update"}
      onClose={phase === "working" ? () => {} : onClose}
      footer={
        phase === "working" ? null : (
          <>
            <Button variant="ghost" onClick={onClose}>
              {phase === "done" ? "Close" : "Not now"}
            </Button>
            {phase !== "done" && (
              <Button variant="primary" onClick={() => void run()}>
                {phase === "failed" ? "Try again" : isRepair ? "Repair" : "Update"}
              </Button>
            )}
          </>
        )
      }
    >
      {phase === "working" ? (
        <DataProgressView progress={progress} />
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {/* Two different situations reach this dialog. Usually PoB has
              published a new version. But files can also go missing or be
              corrupted locally, and then the manifest version matches while
              the copy is still incomplete — calling that "new data" would be
              a lie about what is happening. */}
          <p>
            {isRepair
              ? "Some Path of Building game data is missing or has changed on disk."
              : `Path of Building published new game data${
                  info.remoteVersion ? ` (${info.remoteVersion})` : ""
                }${info.localVersion ? `; you have ${info.localVersion}` : ""}.`}
          </p>
          <p className="muted">
            {info.files} file{info.files === 1 ? "" : "s"} to download
            {size ? `, ${size}` : ""}
            {info.deletes > 0 ? `, ${info.deletes} to remove` : ""}
            {versions ? ` · tree ${versions}` : ""}
          </p>
          <p className="muted">
            The engine restarts to load it. Your build is saved and restored automatically.
          </p>
        </div>
      )}

      {error && (
        <div style={{ marginTop: 12 }}>
          <Banner kind="error" detail={error}>
            The update did not finish. Verified files were kept, so trying again resumes rather
            than starting over — and nothing was replaced, so the current data still works.
          </Banner>
        </div>
      )}
    </Modal>
  );
}
