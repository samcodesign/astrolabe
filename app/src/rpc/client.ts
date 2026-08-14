/**
 * Typed JSON-RPC 2.0 client for the engine host.
 *
 * Types come straight from `schema/rpc.d.ts` — this file deliberately declares
 * no method shapes of its own, so a schema change is a compile error here
 * rather than a runtime surprise.
 */

import type {
  Methods,
  Notifications,
  Request as WireRequest,
  Response as WireResponse,
  Notification as WireNotification,
  RpcError as WireError,
} from "@schema/rpc";

import {
  ClientErrorCode,
  RpcRemoteError,
  RpcTransportError,
} from "./errors";
import type { HostState, Transport, Unsubscribe } from "./transport";
import { Emitter } from "./transport";

export type MethodName = keyof Methods;
export type NotificationName = keyof Notifications;
export type Params<M extends MethodName> = Methods[M]["params"];
export type Result<M extends MethodName> = Methods[M]["result"];

/**
 * Per-method deadlines, in ms. These come from the measured costs documented
 * at the top of the schema, with generous headroom:
 *   host.info    — answered after a ~4.2 s boot
 *   build.load   — up to ~5 s of tree parsing on a cold tree version
 *   recompute    — ~78 ms, so a 10 s ceiling is already absurd
 */
export const DEFAULT_TIMEOUT_MS = 10_000;

const METHOD_TIMEOUTS: Partial<Record<MethodName, number>> = {
  "host.info": 45_000,
  "build.load": 60_000,
  "tree.geometry": 60_000,
  // These return immediately with an acknowledgement; the work streams after.
  "tree.power": 15_000,
  "tree.optimise": 15_000,
};

export interface CallOptions {
  /** Overrides the per-method default. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Invoked for every notification whose `id` matches this request, wired
   * before the frame is written so no early progress event is missed.
   */
  onProgress?: (method: NotificationName, params: unknown) => void;
}

interface Pending {
  id: number;
  method: MethodName;
  resolve: (value: never) => void;
  reject: (err: unknown) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  onProgress?: CallOptions["onProgress"];
  cleanup: () => void;
}

export interface RpcClientOptions {
  /** Defaults to `Date.now`-independent monotonic ids starting at 1. */
  startId?: number;
  /** Overrides for tests. */
  timeouts?: Partial<Record<MethodName, number>>;
  /** Called for frames that are neither a valid response nor a notification. */
  onMalformed?: (raw: unknown, reason: string) => void;
}

export class RpcClient {
  #transport: Transport;
  #pending = new Map<number, Pending>();
  #nextId: number;
  #timeouts: Partial<Record<MethodName, number>>;
  #onMalformed: (raw: unknown, reason: string) => void;
  #notifications = new Map<NotificationName, Emitter<unknown>>();
  #stateEmitter = new Emitter<HostState>();
  #unsubs: Unsubscribe[] = [];
  #disposed = false;

  constructor(transport: Transport, opts: RpcClientOptions = {}) {
    this.#transport = transport;
    this.#nextId = opts.startId ?? 1;
    this.#timeouts = { ...METHOD_TIMEOUTS, ...opts.timeouts };
    this.#onMalformed =
      opts.onMalformed ??
      ((raw, reason) => console.warn("[rpc] dropped frame:", reason, raw));

    this.#unsubs.push(transport.onMessage((msg) => this.#receive(msg)));
    this.#unsubs.push(
      transport.onState((s) => {
        // A dead host can never answer anything that is already in flight.
        if (s.phase === "exited" || s.phase === "failed") {
          this.#failAll(
            new RpcTransportError(
              s.phase === "exited"
                ? `engine host exited (code ${s.code ?? "signal"})`
                : `engine host failed: ${s.reason}`,
              ClientErrorCode.HOST_DIED,
              { retryable: true },
            ),
          );
        }
        this.#stateEmitter.emit(s);
      }),
    );
  }

  get state(): HostState {
    return this.#transport.state;
  }

  /** Number of requests awaiting a response. Exposed for tests and the UI. */
  get inFlight(): number {
    return this.#pending.size;
  }

  onStateChange(cb: (s: HostState) => void): Unsubscribe {
    return this.#stateEmitter.on(cb);
  }

  /** Subscribe to a notification regardless of which request produced it. */
  on<N extends NotificationName>(
    method: N,
    cb: (params: Notifications[N]) => void,
  ): Unsubscribe {
    let emitter = this.#notifications.get(method);
    if (!emitter) {
      emitter = new Emitter<unknown>();
      this.#notifications.set(method, emitter);
    }
    return emitter.on(cb as (v: unknown) => void);
  }

  async call<M extends MethodName>(
    method: M,
    params: Params<M>,
    opts: CallOptions = {},
  ): Promise<Result<M>> {
    if (this.#disposed) {
      throw new RpcTransportError(
        "rpc client disposed",
        ClientErrorCode.DISPOSED,
        { method },
      );
    }
    const state = this.#transport.state;
    if (state.phase === "stopped" || state.phase === "failed") {
      throw new RpcTransportError(
        "engine host is not running",
        ClientErrorCode.HOST_NOT_RUNNING,
        { method },
      );
    }
    if (opts.signal?.aborted) {
      throw new RpcTransportError("aborted", ClientErrorCode.CANCELLED, {
        method,
      });
    }

    const id = this.#nextId++;
    const request: WireRequest<M> = { jsonrpc: "2.0", id, method, params };

    return await new Promise<Result<M>>((resolve, reject) => {
      const timeoutMs = opts.timeoutMs ?? this.#timeouts[method] ?? DEFAULT_TIMEOUT_MS;

      const onAbort = () => {
        this.#settle(id, () =>
          reject(
            new RpcTransportError("aborted", ClientErrorCode.CANCELLED, {
              method,
            }),
          ),
        );
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });

      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.#settle(id, () =>
                reject(
                  new RpcTransportError(
                    `${method} timed out after ${timeoutMs} ms`,
                    ClientErrorCode.TIMEOUT,
                    { method },
                  ),
                ),
              );
            }, timeoutMs)
          : undefined;

      const entry: Pending = {
        id,
        method,
        resolve: resolve as (v: never) => void,
        reject,
        timer,
        onProgress: opts.onProgress,
        cleanup: () => {
          if (timer) clearTimeout(timer);
          opts.signal?.removeEventListener("abort", onAbort);
        },
      };
      // Registered before the write so a synchronous mock transport that
      // answers inside send() still finds its pending entry.
      this.#pending.set(id, entry);

      this.#transport.send(JSON.stringify(request) + "\n").catch((err) => {
        this.#settle(id, () =>
          reject(
            new RpcTransportError(
              `could not write to engine host: ${String(err)}`,
              ClientErrorCode.HOST_DIED,
              { method },
            ),
          ),
        );
      });
    });
  }

  /**
   * The id the next `call` will use. Lets a caller wire up notification
   * filtering before issuing the request, without racing the transport.
   */
  peekNextId(): number {
    return this.#nextId;
  }

  dispose(): void {
    this.#disposed = true;
    this.#failAll(
      new RpcTransportError("rpc client disposed", ClientErrorCode.DISPOSED),
    );
    for (const u of this.#unsubs) u();
    this.#unsubs = [];
    for (const e of this.#notifications.values()) e.clear();
    this.#notifications.clear();
    this.#stateEmitter.clear();
  }

  // -------------------------------------------------------------------------

  #settle(id: number, run: () => void): void {
    const entry = this.#pending.get(id);
    if (!entry) return; // already settled — late response, double abort, etc.
    this.#pending.delete(id);
    entry.cleanup();
    run();
  }

  #failAll(err: unknown): void {
    const ids = [...this.#pending.keys()];
    for (const id of ids) {
      const entry = this.#pending.get(id);
      if (!entry) continue;
      this.#settle(id, () => entry.reject(err));
    }
  }

  #receive(msg: unknown): void {
    if (typeof msg !== "object" || msg === null) {
      this.#onMalformed(msg, "frame is not an object");
      return;
    }
    const frame = msg as Record<string, unknown>;

    if (frame["jsonrpc"] !== "2.0") {
      this.#onMalformed(msg, "missing or wrong jsonrpc version");
      return;
    }

    // A notification has a method and no id at the envelope level; the request
    // it belongs to is named by `params.id` (see schema/rpc.d.ts).
    if (typeof frame["method"] === "string" && frame["id"] === undefined) {
      this.#dispatchNotification(frame as unknown as WireNotification);
      return;
    }

    if (typeof frame["id"] !== "number") {
      this.#onMalformed(msg, "response has no numeric id");
      return;
    }

    const response = frame as unknown as WireResponse;
    const entry = this.#pending.get(response.id);
    if (!entry) {
      // Late answer to something we already timed out or cancelled. Dropping
      // it is correct; warn so a systematic mismatch is visible.
      this.#onMalformed(msg, `no pending request with id ${response.id}`);
      return;
    }

    if (response.error !== undefined && response.error !== null) {
      const err = response.error as WireError;
      this.#settle(response.id, () =>
        entry.reject(
          new RpcRemoteError(err.message ?? "engine error", err.code ?? -32603, {
            data: err.data,
            method: entry.method,
          }),
        ),
      );
      return;
    }

    if (!("result" in response)) {
      this.#settle(response.id, () =>
        entry.reject(
          new RpcTransportError(
            "response had neither result nor error",
            ClientErrorCode.MALFORMED,
            { method: entry.method },
          ),
        ),
      );
      return;
    }

    this.#settle(response.id, () => entry.resolve(response.result as never));
  }

  #dispatchNotification(note: WireNotification): void {
    const method = note.method as NotificationName;
    const params = note.params as unknown;

    // Correlated progress goes to the originating call first.
    const id =
      params && typeof params === "object" && "id" in params
        ? (params as { id: unknown }).id
        : undefined;
    if (typeof id === "number") {
      const entry = this.#pending.get(id);
      entry?.onProgress?.(method, params);
    }

    this.#notifications.get(method)?.emit(params);
  }
}
