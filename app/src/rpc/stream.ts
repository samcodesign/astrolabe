/**
 * Streaming calls: `tree.power` and `tree.optimise`.
 *
 * These do not fit `call()`'s request/response shape. The response arrives
 * almost immediately (it only acknowledges how many nodes were queued) and the
 * actual work then arrives as notifications for up to ~18 s. So the id must be
 * known *before* the request is written, and the subscription has to outlive
 * the response.
 */

import type { NodeId, NodePower, Notifications } from "@schema/rpc";
import type { RpcClient } from "./client";
import { ClientErrorCode, RpcTransportError } from "./errors";

/** No progress for this long with no `done` means the stream is wedged. */
export const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

export interface PowerStreamHandlers {
  /** Called per batch, highest value first, ordered by path distance. */
  onBatch(nodes: NodePower[], progress: { done: number; total: number }): void;
  onDone?(summary: { total: number; elapsedMs: number }): void;
  onError?(err: unknown): void;
}

export interface StreamHandle {
  /** The JSON-RPC id backing this stream. */
  readonly id: number;
  /** Resolves when the host sends `done`; rejects on error/cancel/idle. */
  readonly finished: Promise<void>;
  /** Asks the host to stop, then settles `finished` as cancelled. */
  cancel(): Promise<void>;
}

/**
 * Start a heatmap pass.
 *
 * `maxDepth` defaults to the schema's default of 3 on the host side; the near
 * nodes (1-3 s) are what the UI actually needs, so callers should stay low
 * unless the user explicitly asks for a full pass.
 */
export function startPowerStream(
  client: RpcClient,
  params: { metric: string; maxDepth?: number },
  handlers: PowerStreamHandlers,
  opts: { idleTimeoutMs?: number } = {},
): StreamHandle {
  const id = client.peekNextId();
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

  let settled = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveFinished!: () => void;
  let rejectFinished!: (e: unknown) => void;

  const finished = new Promise<void>((res, rej) => {
    resolveFinished = res;
    rejectFinished = rej;
  });
  // Nothing forces a caller to await `finished`; without this an idle timeout
  // would surface as an unhandled rejection.
  finished.catch(() => {});

  const unsubs: Array<() => void> = [];

  const teardown = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
    for (const u of unsubs) u();
    unsubs.length = 0;
  };

  const fail = (err: unknown) => {
    if (settled) return;
    settled = true;
    teardown();
    handlers.onError?.(err);
    rejectFinished(err);
  };

  const succeed = (summary: { total: number; elapsedMs: number }) => {
    if (settled) return;
    settled = true;
    teardown();
    handlers.onDone?.(summary);
    resolveFinished();
  };

  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (idleTimeoutMs <= 0) return;
    idleTimer = setTimeout(() => {
      fail(
        new RpcTransportError(
          `no heatmap progress for ${idleTimeoutMs} ms`,
          ClientErrorCode.TIMEOUT,
          { method: "tree.power" },
        ),
      );
    }, idleTimeoutMs);
  };

  // Subscribe before sending: the host may emit its first batch between the
  // write and the response.
  unsubs.push(
    client.on("tree.power.progress", (p: Notifications["tree.power.progress"]) => {
      if (p.id !== id) return;
      armIdle();
      handlers.onBatch(p.nodes ?? [], { done: p.done, total: p.total });
    }),
  );
  unsubs.push(
    client.on("tree.power.done", (p: Notifications["tree.power.done"]) => {
      if (p.id !== id) return;
      succeed({ total: p.total, elapsedMs: p.elapsedMs });
    }),
  );
  unsubs.push(client.onStateChange((s) => {
    if (s.phase === "exited" || s.phase === "failed") {
      fail(
        new RpcTransportError(
          "engine host stopped during the heatmap pass",
          ClientErrorCode.HOST_DIED,
          { method: "tree.power" },
        ),
      );
    }
  }));

  armIdle();

  client
    .call("tree.power", { metric: params.metric, maxDepth: params.maxDepth })
    .catch((err) => fail(err));

  return {
    id,
    finished,
    async cancel() {
      if (settled) return;
      try {
        await client.call("tree.powerCancel", {});
      } catch {
        // The host may already be gone; the local teardown below still stands.
      }
      fail(
        new RpcTransportError("heatmap cancelled", ClientErrorCode.CANCELLED, {
          method: "tree.power",
        }),
      );
    },
  };
}

export interface OptimiseStreamHandlers {
  onBest(best: { nodes: NodeId[]; gain: number; pointsUsed: number }, explored: number): void;
  onDone?(best: { nodes: NodeId[]; gain: number }): void;
  onError?(err: unknown): void;
}

export function startOptimiseStream(
  client: RpcClient,
  params: { budget: number; metric: string; beamWidth?: number },
  handlers: OptimiseStreamHandlers,
  opts: { idleTimeoutMs?: number } = {},
): StreamHandle {
  const id = client.peekNextId();
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  let settled = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveFinished!: () => void;
  let rejectFinished!: (e: unknown) => void;
  const finished = new Promise<void>((res, rej) => {
    resolveFinished = res;
    rejectFinished = rej;
  });
  finished.catch(() => {});
  const unsubs: Array<() => void> = [];

  const teardown = () => {
    if (idleTimer) clearTimeout(idleTimer);
    for (const u of unsubs) u();
    unsubs.length = 0;
  };
  const fail = (err: unknown) => {
    if (settled) return;
    settled = true;
    teardown();
    handlers.onError?.(err);
    rejectFinished(err);
  };
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (idleTimeoutMs <= 0) return;
    idleTimer = setTimeout(
      () =>
        fail(
          new RpcTransportError(
            `no optimiser progress for ${idleTimeoutMs} ms`,
            ClientErrorCode.TIMEOUT,
            { method: "tree.optimise" },
          ),
        ),
      idleTimeoutMs,
    );
  };

  unsubs.push(
    client.on("tree.optimise.progress", (p) => {
      if (p.id !== id) return;
      armIdle();
      handlers.onBest(p.best, p.explored);
    }),
  );
  unsubs.push(
    client.on("tree.optimise.done", (p) => {
      if (p.id !== id || settled) return;
      settled = true;
      teardown();
      handlers.onDone?.(p.best);
      resolveFinished();
    }),
  );

  armIdle();
  client.call("tree.optimise", params).catch((err) => fail(err));

  return {
    id,
    finished,
    async cancel() {
      if (settled) return;
      // NOTE: the schema has no `tree.optimiseCancel`. `tree.powerCancel` is
      // the only cancel verb it exposes; see the track report.
      try {
        await client.call("tree.powerCancel", {});
      } catch {
        /* ignore */
      }
      fail(
        new RpcTransportError("optimiser cancelled", ClientErrorCode.CANCELLED, {
          method: "tree.optimise",
        }),
      );
    },
  };
}
