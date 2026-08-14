/**
 * Transport backed by the Tauri sidecar supervisor in `src-tauri`.
 *
 * The Rust side owns the process, the restart policy and the line framing;
 * this class is only the JS end of the pipe. Event names must stay in sync
 * with `src-tauri/src/supervisor.rs`.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Emitter, type HostState, type Transport } from "./transport";

export const EVENT_MESSAGE = "engine://message";
export const EVENT_STATE = "engine://state";
export const EVENT_STDERR = "engine://stderr";

/** True when running inside the Tauri webview rather than a plain browser. */
export function isTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
  );
}

/** Mirrors the `HostState` enum serialised by Rust (serde tag = "phase"). */
type WireState = HostState;

export class TauriTransport implements Transport {
  #messages = new Emitter<unknown>();
  #states = new Emitter<HostState>();
  #stderr = new Emitter<string>();
  #state: HostState = { phase: "stopped" };
  #unlisten: UnlistenFn[] = [];
  #started = false;

  get state(): HostState {
    return this.#state;
  }

  onMessage(cb: (m: unknown) => void) {
    return this.#messages.on(cb);
  }
  onState(cb: (s: HostState) => void) {
    return this.#states.on(cb);
  }
  onStderr(cb: (l: string) => void) {
    return this.#stderr.on(cb);
  }

  async start(): Promise<void> {
    if (!this.#started) {
      this.#started = true;
      this.#unlisten.push(
        await listen<string>(EVENT_MESSAGE, (e) => {
          // Rust forwards the raw line; a parse failure here is a protocol bug
          // worth surfacing rather than swallowing.
          try {
            this.#messages.emit(JSON.parse(e.payload));
          } catch {
            this.#messages.emit({ __unparseable: e.payload });
          }
        }),
      );
      this.#unlisten.push(
        await listen<WireState>(EVENT_STATE, (e) => {
          this.#state = e.payload;
          this.#states.emit(e.payload);
        }),
      );
      this.#unlisten.push(
        await listen<string>(EVENT_STDERR, (e) => this.#stderr.emit(e.payload)),
      );
    }

    // Rust resolves this once the process is spawned and the reader thread is
    // attached; `ready` arrives separately, after the handshake.
    const state = await invoke<WireState>("engine_start");
    this.#state = state;
    this.#states.emit(state);
  }

  async send(frame: string): Promise<void> {
    await invoke("engine_send", { frame });
  }

  async stop(): Promise<void> {
    await invoke("engine_stop");
    for (const u of this.#unlisten) u();
    this.#unlisten = [];
    this.#started = false;
  }

  /** Force a supervised restart — used by the "reconnect" button. */
  async restart(): Promise<void> {
    await invoke("engine_restart");
  }
}
