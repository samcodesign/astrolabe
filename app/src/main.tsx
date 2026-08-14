import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./styles.css";
import { App } from "./App";
import { EngineSession } from "./engine/session";
import { MockTransport } from "./rpc/mock/mock-transport";
import { isTauri, TauriTransport } from "./rpc/tauri-transport";
import type { Transport } from "./rpc/transport";

/**
 * Inside Tauri we talk to the real sidecar. In a plain browser — `npm run dev`
 * without the shell — we fall back to the mock engine, which reproduces the
 * measured latencies so the startup and heatmap UX can be judged honestly.
 *
 * `VITE_MOCK=1` forces the mock even inside the desktop app, which is how the
 * UI is worked on while Track 1's `serve` mode is still landing.
 */
function makeTransport(): Transport {
  const forceMock = import.meta.env["VITE_MOCK"] === "1";
  if (!forceMock && isTauri()) return new TauriTransport();
  return new MockTransport({ speed: "real" });
}

const session = new EngineSession(makeTransport());

// Handy in the devtools console: `__session.store.getState()`.
(window as unknown as { __session: EngineSession }).__session = session;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App session={session} />
  </StrictMode>,
);
