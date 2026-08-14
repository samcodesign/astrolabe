import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RpcClient } from "./client";
import { ClientErrorCode } from "./errors";
import { startPowerStream } from "./stream";
import { Emitter, type HostState, type Transport } from "./transport";

class FakeTransport implements Transport {
  sent: string[] = [];
  #messages = new Emitter<unknown>();
  #states = new Emitter<HostState>();
  #stderr = new Emitter<string>();
  state: HostState = { phase: "ready" };

  async start() {}
  async stop() {}
  async restart() {}
  async send(frame: string) {
    this.sent.push(frame);
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
  deliver(m: unknown) {
    this.#messages.emit(m);
  }
  setState(s: HostState) {
    this.state = s;
    this.#states.emit(s);
  }
  methods(): string[] {
    return this.sent.map((s) => JSON.parse(s).method);
  }
}

const progress = (id: number, done: number, total: number, perPoint: number) => ({
  jsonrpc: "2.0",
  method: "tree.power.progress",
  params: {
    id,
    done,
    total,
    nodes: [{ id: 100 + done, offence: perPoint, defence: 0, pathCost: 1, perPoint }],
  },
});

describe("startPowerStream", () => {
  let transport: FakeTransport;
  let client: RpcClient;

  beforeEach(() => {
    transport = new FakeTransport();
    client = new RpcClient(transport, { onMalformed: () => {} });
  });

  afterEach(() => {
    client.dispose();
    vi.useRealTimers();
  });

  it("subscribes before sending, so a batch emitted immediately is not lost", () => {
    const batches: number[] = [];
    // The very first thing the host does is emit progress, before the response.
    const handle = startPowerStream(
      client,
      { metric: "offence" },
      { onBatch: (nodes) => batches.push(nodes.length) },
    );
    transport.deliver(progress(handle.id, 1, 10, 500));
    expect(batches).toEqual([1]);
  });

  it("uses the id the request will carry", () => {
    const handle = startPowerStream(client, { metric: "offence" }, { onBatch: () => {} });
    expect(JSON.parse(transport.sent[0]!).id).toBe(handle.id);
  });

  it("ignores notifications belonging to another request", () => {
    const batches: number[] = [];
    const handle = startPowerStream(
      client,
      { metric: "offence" },
      { onBatch: (n) => batches.push(n.length) },
    );
    transport.deliver(progress(handle.id + 5, 1, 10, 100));
    expect(batches).toEqual([]);
  });

  it("keeps streaming after the response has settled", async () => {
    const batches: number[] = [];
    const handle = startPowerStream(
      client,
      { metric: "offence" },
      { onBatch: (n) => batches.push(n.length) },
    );

    // The response acknowledges the queue almost immediately...
    transport.deliver({ jsonrpc: "2.0", id: handle.id, result: { requested: 100 } });
    await Promise.resolve();
    // ...and the real work arrives for the next ~18 seconds.
    transport.deliver(progress(handle.id, 40, 100, 900));
    transport.deliver(progress(handle.id, 80, 100, 700));
    expect(batches).toEqual([1, 1]);
  });

  it("resolves on the done notification with the elapsed time", async () => {
    const done = vi.fn();
    const handle = startPowerStream(
      client,
      { metric: "offence" },
      { onBatch: () => {}, onDone: done },
    );
    transport.deliver({
      jsonrpc: "2.0",
      method: "tree.power.done",
      params: { id: handle.id, total: 2237, elapsedMs: 18_402 },
    });
    await expect(handle.finished).resolves.toBeUndefined();
    expect(done).toHaveBeenCalledWith({ total: 2237, elapsedMs: 18_402 });
  });

  it("cancels through tree.powerCancel and settles as cancelled", async () => {
    const handle = startPowerStream(client, { metric: "offence" }, { onBatch: () => {} });
    const cancelling = handle.cancel();
    // The cancel request is the second frame; answer it so the promise settles.
    const cancelId = JSON.parse(transport.sent[1]!).id;
    expect(transport.methods()).toEqual(["tree.power", "tree.powerCancel"]);
    transport.deliver({ jsonrpc: "2.0", id: cancelId, result: {} });
    await cancelling;

    await expect(handle.finished).rejects.toMatchObject({
      code: ClientErrorCode.CANCELLED,
    });
  });

  it("stops delivering batches after cancellation", async () => {
    const batches: number[] = [];
    const handle = startPowerStream(
      client,
      { metric: "offence" },
      { onBatch: (n) => batches.push(n.length) },
    );
    const cancelling = handle.cancel();
    transport.deliver({ jsonrpc: "2.0", id: JSON.parse(transport.sent[1]!).id, result: {} });
    await cancelling;

    transport.deliver(progress(handle.id, 90, 100, 10));
    expect(batches).toEqual([]);
  });

  it("fails when progress stalls past the idle timeout", async () => {
    vi.useFakeTimers();
    const handle = startPowerStream(
      client,
      { metric: "offence" },
      { onBatch: () => {} },
      { idleTimeoutMs: 5_000 },
    );
    vi.advanceTimersByTime(5_001);
    await expect(handle.finished).rejects.toMatchObject({
      code: ClientErrorCode.TIMEOUT,
    });
  });

  it("rearms the idle timeout on every batch", async () => {
    vi.useFakeTimers();
    const handle = startPowerStream(
      client,
      { metric: "offence" },
      { onBatch: () => {} },
      { idleTimeoutMs: 5_000 },
    );
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(4_000);
      transport.deliver(progress(handle.id, i, 100, 10));
    }
    // 20 s of steady progress must not trip a 5 s idle timeout.
    const settled = await Promise.race([
      handle.finished.then(() => "settled").catch(() => "failed"),
      Promise.resolve("pending"),
    ]);
    expect(settled).toBe("pending");
  });

  it("fails the stream when the host dies mid-pass", async () => {
    const onError = vi.fn();
    const handle = startPowerStream(
      client,
      { metric: "offence" },
      { onBatch: () => {}, onError },
    );
    transport.setState({
      phase: "exited",
      code: 101,
      stderrTail: "lua: boom",
      willRestart: true,
    });
    await expect(handle.finished).rejects.toMatchObject({
      code: ClientErrorCode.HOST_DIED,
    });
    expect(onError).toHaveBeenCalledOnce();
  });

  it("passes maxDepth through so the near nodes can be requested alone", () => {
    startPowerStream(client, { metric: "defence", maxDepth: 2 }, { onBatch: () => {} });
    expect(JSON.parse(transport.sent[0]!).params).toEqual({
      metric: "defence",
      maxDepth: 2,
    });
  });
});
