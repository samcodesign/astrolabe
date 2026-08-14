/**
 * Top-level routing: the first-run download when there is no game data, splash
 * while the engine boots, import until a build exists, then the workspace.
 */

import { useEffect, useRef, useState } from "react";
import type { EngineSession } from "./engine/session";
import {
  checkForUpdate,
  dataStatus,
  type DataStatus,
  type UpdateInfo,
} from "./platform/gamedata";
import { useStore } from "./state/store";
import { UpdateChip, UpdateDialog } from "./ui/DataUpdate";
import { Diagnostics } from "./ui/Diagnostics";
import { FirstRun } from "./ui/FirstRun";
import { ImportScreen } from "./ui/ImportScreen";
import { SpecBar } from "./ui/SpecBar";
import { Splash } from "./ui/Splash";
import { StatPanel } from "./ui/StatPanel";
import { TopBar } from "./ui/TopBar";
import { TreeStage } from "./ui/TreeStage";
import { Banner } from "./ui/primitives";

export function App({ session }: { session: EngineSession }) {
  const state = useStore(session.store, (s) => s);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [forceImport, setForceImport] = useState(false);
  const [data, setData] = useState<DataStatus | null>(null);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [showUpdate, setShowUpdate] = useState(false);
  const checkedRef = useRef(false);

  // The engine loads Path of Building's data at boot, so there is no point
  // starting it before the data exists. On a fresh install this gate is the
  // first screen; on every later run it resolves in a millisecond and the user
  // never sees it.
  useEffect(() => {
    let cancelled = false;
    void dataStatus()
      .then((s) => {
        if (cancelled) return;
        setData(s);
        if (s.ready) void session.connect();
      })
      .catch(() => {
        // Asking failed, which is not the same as having no data. Fall through
        // and let the engine report the real problem rather than blocking on a
        // download the user may not need.
        if (cancelled) return;
        setData(null);
        void session.connect();
      });
    return () => {
      cancelled = true;
    };
  }, [session]);

  // Look for new game data once the app is actually usable, never before: this
  // is a network round-trip and it must not sit on the critical path to a
  // working tree. Once per session, and only for the copy we manage — a
  // POB_PATH or dev checkout belongs to the user and we do not write to it.
  useEffect(() => {
    if (checkedRef.current) return;
    if (state.connection !== "ready" || !data?.updatable) return;
    checkedRef.current = true;
    void checkForUpdate()
      .then((info) => setUpdate(info?.available ? info : null))
      // A failed check is not worth interrupting anyone over; the next launch
      // tries again.
      .catch(() => {});
  }, [state.connection, data?.updatable]);

  // A successful import replaces the build object; that is the signal to leave
  // the import screen, whether the user got there by choice or by having none.
  const lastBuild = useRef(state.build);
  useEffect(() => {
    if (state.build && state.build !== lastBuild.current) setForceImport(false);
    lastBuild.current = state.build;
  }, [state.build]);

  // Transient banners clear themselves; errors stay until dismissed.
  useEffect(() => {
    if (!state.banner || state.banner.kind === "error") return;
    const t = setTimeout(() => session.dismissBanner(), 6000);
    return () => clearTimeout(t);
  }, [state.banner, session]);

  if (data && !data.ready) {
    return (
      <FirstRun
        status={data}
        onReady={(next) => {
          setData(next);
          // The engine was never started — it had nothing to load — so this is
          // its first connect, not a reconnect.
          void session.connect();
        }}
      />
    );
  }

  const booting =
    state.connection === "idle" ||
    state.connection === "spawning" ||
    state.connection === "handshake" ||
    (state.connection === "failed" && !state.build);

  if (booting) {
    return (
      <Splash
        state={state}
        onRetry={() => {
          void session.connect();
        }}
      />
    );
  }

  const needsBuild = !state.build || forceImport;

  return (
    <>
      {needsBuild ? (
        <div className="shell" style={{ gridTemplateRows: "1fr" }}>
          <ImportScreen
            session={session}
            {...(state.build ? { onCancel: () => setForceImport(false) } : {})}
          />
        </div>
      ) : (
        <div className="shell">
          <TopBar
            session={session}
            onDiagnostics={() => setShowDiagnostics(true)}
            onImport={() => setForceImport(true)}
            {...(update
              ? { updateSlot: <UpdateChip info={update} onOpen={() => setShowUpdate(true)} /> }
              : {})}
          />
          <div className="body">
            <div className="stage" style={{ display: "flex", flexDirection: "column" }}>
              <SpecBar session={session} />
              <TreeStage session={session} />
            </div>
            <StatPanel session={session} />
          </div>
        </div>
      )}

      {state.banner && !needsBuild && (
        <div className="toast-host">
          <Banner
            kind={state.banner.kind}
            detail={state.banner.detail}
            onDismiss={() => session.dismissBanner()}
          >
            {state.banner.text}
          </Banner>
        </div>
      )}

      {showUpdate && update && (
        <UpdateDialog
          info={update}
          session={session}
          onClose={() => setShowUpdate(false)}
          onApplied={() => {
            setShowUpdate(false);
            setUpdate(null);
          }}
        />
      )}

      {showDiagnostics && (
        <Diagnostics session={session} onClose={() => setShowDiagnostics(false)} />
      )}
    </>
  );
}
