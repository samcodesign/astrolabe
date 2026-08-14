/**
 * The byte pipe under the RPC client.
 *
 * Implementations: `TauriTransport` (real sidecar, over Tauri IPC) and
 * `MockTransport` (an in-process fake engine, used by tests and by
 * `npm run dev` in a plain browser).
 */

export type HostState =
  /** No process. */
  | { phase: "stopped" }
  /** A spawn is in progress; nothing is writable yet. */
  | { phase: "starting"; attempt: number }
  /**
   * Spawned with pipes attached, so requests may be written. The engine still
   * needs ~4.2 s before it answers the first one — that wait belongs to the
   * splash, and completion is signalled by `host.info` returning, not by this.
   */
  | { phase: "ready" }
  /** Process gone. `code` is the exit status, null if killed by a signal. */
  | { phase: "exited"; code: number | null; stderrTail: string; willRestart: boolean }
  /** Restart backoff exhausted, or spawn itself failed. */
  | { phase: "failed"; reason: string };

export type Unsubscribe = () => void;

export interface Transport {
  /** Spawn (or connect to) the host. Resolves once the process is live. */
  start(): Promise<void>;
  /** Write one newline-delimited JSON frame. */
  send(frame: string): Promise<void>;
  /** Every inbound line, already JSON-parsed. */
  onMessage(cb: (msg: unknown) => void): Unsubscribe;
  /** Process lifecycle. The client turns `exited` into in-flight rejections. */
  onState(cb: (s: HostState) => void): Unsubscribe;
  /** Anything the host wrote to stderr, for the diagnostics pane. */
  onStderr(cb: (line: string) => void): Unsubscribe;
  /** Kill the process; do not restart. */
  stop(): Promise<void>;
  /**
   * Stop and start again, keeping the supervisor's restart policy.
   *
   * Needed because the host loads Path of Building's data at boot: a game-data
   * update changes nothing until the process re-reads it.
   */
  restart(): Promise<void>;
  readonly state: HostState;
}

/** Small typed event emitter, so implementations do not each grow one. */
export class Emitter<T> {
  #listeners = new Set<(value: T) => void>();

  on(cb: (value: T) => void): Unsubscribe {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  emit(value: T): void {
    // Copy first: a listener may unsubscribe during dispatch.
    for (const cb of [...this.#listeners]) {
      try {
        cb(value);
      } catch (err) {
        console.error("[transport] listener threw", err);
      }
    }
  }

  clear(): void {
    this.#listeners.clear();
  }

  get size(): number {
    return this.#listeners.size;
  }
}
