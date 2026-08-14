/**
 * App chrome: who the character is, how many points they have spent, whether
 * the engine is alive, and the save/load verbs.
 */

import { useState, type ReactNode } from "react";
import type { EngineSession } from "../engine/session";
import { useStore } from "../state/store";
import { copyToClipboard, saveTextFile } from "../platform/files";
import { openTextFile } from "../platform/files";
import { isTauri } from "../rpc/tauri-transport";
import { Button, Modal } from "./primitives";

export function TopBar({
  session,
  onDiagnostics,
  onImport,
  updateSlot,
}: {
  session: EngineSession;
  onDiagnostics: () => void;
  onImport: () => void;
  /** The game-data update chip, when there is one. Owned by `App`. */
  updateSlot?: ReactNode;
}) {
  const { build, connection, hostState, busy } = useStore(session.store, (s) => ({
    build: s.build,
    connection: s.connection,
    hostState: s.hostState,
    busy: s.busy,
  }));
  const [exporting, setExporting] = useState<null | { as: "code" | "xml"; data: string }>(null);
  const [saving, setSaving] = useState(false);

  const pointsOver = build ? build.pointsUsed > build.pointsTotal : false;
  const pointsPct = build
    ? Math.min(100, (build.pointsUsed / Math.max(1, build.pointsTotal)) * 100)
    : 0;

  const savePlan = async () => {
    setSaving(true);
    try {
      const text = await session.serialisePlan();
      const name = `${(build?.name ?? "build").replace(/[^\w\- ]+/g, "")}.poeplan`;
      const path = await saveTextFile({
        contents: text,
        defaultName: name,
        title: "Save plan",
        filters: [{ name: "PoE Planner plan", extensions: ["poeplan"] }],
      });
      if (path) {
        session.setBanner({ kind: "success", text: `Saved to ${path}` });
      }
    } catch (e) {
      session.setBanner({
        kind: "error",
        text: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSaving(false);
    }
  };

  const openPlan = async () => {
    try {
      const picked = await openTextFile({
        title: "Open plan",
        filters: [
          { name: "Plans and builds", extensions: ["poeplan", "json", "xml"] },
          { name: "All files", extensions: ["*"] },
        ],
      });
      if (!picked) return;
      const isXml = picked.contents.trimStart().startsWith("<");
      const ok = isXml
        ? await session.loadXml(picked.contents)
        : await session.openPlan(picked.contents);
      if (!ok) {
        session.setBanner({ kind: "error", text: "That file could not be opened." });
      }
    } catch (e) {
      session.setBanner({
        kind: "error",
        text: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const exportAs = async (as: "code" | "xml") => {
    try {
      const data = await session.exportBuild(as);
      setExporting({ as, data });
    } catch (e) {
      session.setBanner({
        kind: "error",
        text: e instanceof Error ? e.message : String(e),
      });
    }
  };

  return (
    <header className="topbar">
      <div className="topbar__identity">
        <span className="topbar__name">{build?.name || "Untitled build"}</span>
        <span className="topbar__class">
          {build ? (
            <>
              Level {build.level}{" "}
              <strong>
                {build.ascendClassName && build.ascendClassName !== "None"
                  ? build.ascendClassName
                  : build.className}
              </strong>
              {build.ascendClassName && build.ascendClassName !== "None"
                ? ` (${build.className})`
                : ""}{" "}
              · tree {build.treeVersion.replace(/_/g, ".")}
            </>
          ) : (
            "no build loaded"
          )}
        </span>
      </div>

      <div className="topbar__divider" />

      <div className="stat-chip">
        <span className="stat-chip__label">Points</span>
        <span className="stat-chip__value">
          {build?.pointsUsed ?? 0}
          <small> / {build?.pointsTotal ?? 0}</small>
        </span>
        <div className="points-bar">
          <div
            className={`points-bar__fill ${pointsOver ? "points-bar__fill--over" : ""}`}
            style={{ width: `${pointsPct}%` }}
          />
        </div>
      </div>

      <div className="stat-chip">
        <span className="stat-chip__label">Ascendancy</span>
        <span className="stat-chip__value">
          {build?.ascendancyPointsUsed ?? 0}
          <small> / 8</small>
        </span>
      </div>

      <div className="topbar__spacer" />

      <button className="host-status" onClick={onDiagnostics} title="Engine diagnostics">
        <span
          className={`dot ${
            connection === "ready"
              ? busy
                ? "dot--busy"
                : "dot--live"
              : connection === "recovering" || hostState.phase === "starting"
                ? "dot--busy"
                : connection === "failed"
                  ? "dot--dead"
                  : ""
          }`}
        />
        {connection === "ready"
          ? busy
            ? busy.what
            : "Engine ready"
          : connection === "recovering"
            ? "Restarting engine…"
            : connection === "failed"
              ? "Engine down"
              : "Connecting…"}
      </button>

      {updateSlot}

      <div className="topbar__divider" />

      <div className="topbar__actions">
        <Button size="sm" variant="ghost" onClick={onImport}>
          Import
        </Button>
        {isTauri() && (
          <Button size="sm" variant="ghost" onClick={() => void openPlan()}>
            Open
          </Button>
        )}
        <Button size="sm" busy={saving} onClick={() => void savePlan()}>
          Save
        </Button>
        <Button size="sm" onClick={() => void exportAs("code")}>
          Export code
        </Button>
      </div>

      {exporting && (
        <Modal
          title={exporting.as === "code" ? "Build code" : "Build XML"}
          onClose={() => setExporting(null)}
          footer={
            <>
              <Button
                onClick={() =>
                  void saveTextFile({
                    contents: exporting.data,
                    defaultName: exporting.as === "code" ? "build.txt" : "build.xml",
                  })
                }
              >
                Save to file…
              </Button>
              <Button
                variant="primary"
                onClick={async () => {
                  const ok = await copyToClipboard(exporting.data);
                  session.setBanner({
                    kind: ok ? "success" : "error",
                    text: ok ? "Copied to clipboard." : "Could not access the clipboard.",
                  });
                }}
              >
                Copy
              </Button>
            </>
          }
        >
          <p className="field__hint">
            {exporting.as === "code"
              ? "Paste this into Path of Building, pobb.in, or anywhere that accepts a build code. It describes the active tree variant only."
              : "The full PoB build document."}
          </p>
          <pre className="logbox selectable">{exporting.data}</pre>
        </Modal>
      )}
    </header>
  );
}
