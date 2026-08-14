/**
 * Engine diagnostics.
 *
 * Exists because "it broke" is not a bug report. Shows the handshake result,
 * the supervisor's view of the process, and the host's stderr — which is where
 * a Lua traceback ends up.
 */

import type { EngineSession } from "../engine/session";
import { useStore } from "../state/store";
import { copyToClipboard } from "../platform/files";
import { Button, Modal } from "./primitives";

export function Diagnostics({
  session,
  onClose,
}: {
  session: EngineSession;
  onClose: () => void;
}) {
  const { hostInfo, hostState, connection, log, build } = useStore(session.store, (s) => ({
    hostInfo: s.hostInfo,
    hostState: s.hostState,
    connection: s.connection,
    log: s.log,
    build: s.build,
  }));

  const report = [
    `connection: ${connection}`,
    `process: ${JSON.stringify(hostState)}`,
    `host: ${hostInfo ? `${hostInfo.hostVersion}, PoB ${hostInfo.pobVersion} @ ${hostInfo.pobCommit}` : "unknown"}`,
    `boot: ${hostInfo ? `${hostInfo.bootMs} ms` : "—"}`,
    `build: ${build ? `${build.className}/${build.ascendClassName} lvl ${build.level}, ${build.pointsUsed}/${build.pointsTotal} points` : "none"}`,
    "",
    ...log,
  ].join("\n");

  return (
    <Modal
      title="Engine diagnostics"
      onClose={onClose}
      footer={
        <>
          <Button onClick={() => void copyToClipboard(report)}>Copy report</Button>
          <Button variant="primary" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      <dl className="kv">
        <dt>Connection</dt>
        <dd>{connection}</dd>
        <dt>Process</dt>
        <dd>
          {hostState.phase}
          {hostState.phase === "exited" && ` (code ${hostState.code ?? "signal"})`}
          {hostState.phase === "starting" && ` (attempt ${hostState.attempt})`}
        </dd>
        <dt>Host version</dt>
        <dd>{hostInfo?.hostVersion ?? "—"}</dd>
        <dt>Path of Building</dt>
        <dd>
          {hostInfo ? `${hostInfo.pobVersion} @ ${hostInfo.pobCommit.slice(0, 10)}` : "—"}
        </dd>
        <dt>Boot time</dt>
        <dd>{hostInfo ? `${(hostInfo.bootMs / 1000).toFixed(2)} s` : "—"}</dd>
        <dt>Tree versions</dt>
        <dd>{hostInfo?.treeVersions.join(", ") ?? "—"}</dd>
        <dt>Requests in flight</dt>
        <dd>{session.client.inFlight}</dd>
      </dl>

      <div>
        <div className="field__label" style={{ marginBottom: 8 }}>
          Host output
        </div>
        <pre className="logbox selectable">
          {log.length ? log.join("\n") : "nothing yet"}
        </pre>
      </div>
    </Modal>
  );
}
