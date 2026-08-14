import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RpcClient } from "./client";
import { ClientErrorCode, RpcRemoteError, RpcTransportError } from "./errors";
import { Emitter, type HostState, type Transport } from "./transport";

/**
 * A transport with no behaviour of its own: the test writes every inbound
 * frame by hand, so correlation and timing are observed rather than inferred.
 */
class FakeTransport implements Transport {
  sent: string[] = [];
  #messages = new Emitter<unknown>();
  #states = new Emitter<HostState>();
  #stderr = new Emitter<string>();
  state: HostState = { phase: "ready" };
  /** Set to make `send` reject, simulating a broken pipe. */
  failSend: Error | null = null;

  async start() {}
  async stop() {}
  async restart() {}
  async send(frame: string) {
    if (this.failSend) throw this.failSend;
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

  /** Deliver a frame from the "host". */
  deliver(msg: unknown) {
    this.#messages.emit(msg);
  }
  setState(s: HostState) {
    this.state = s;
    this.#states.emit(s);
  }
  lastRequest(): { id: number; method: string; params: unknown } {
    const raw = this.sent[this.sent.length - 1];
    if (!raw) throw new Error("nothing was sent");
    return JSON.parse(raw);
  }
}

const ok = (id: number, result: unknown) => ({ jsonrpc: "2.0", id, result });

describe("RpcClient", () => {
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

  describe("framing", () => {
    it("writes a newline-delimited JSON-RPC 2.0 request", async () => {
      const p = client.call("host.info", {});
      const raw = transport.sent[0]!;
      expect(raw.endsWith("\n")).toBe(true);
      const req = JSON.parse(raw);
      expect(req).toMatchObject({ jsonrpc: "2.0", id: 1, method: "host.info", params: {} });

      transport.deliver(ok(1, { hostVersion: "1" }));
      await expect(p).resolves.toMatchObject({ hostVersion: "1" });
    });

    it("allocates monotonically increasing ids", async () => {
      const a = client.call("build.summary", {});
      const b = client.call("build.summary", {});
      expect(JSON.parse(transport.sent[0]!).id).toBe(1);
      expect(JSON.parse(transport.sent[1]!).id).toBe(2);
      transport.deliver(ok(1, {}));
      transport.deliver(ok(2, {}));
      await Promise.all([a, b]);
    });
  });

  describe("correlation", () => {
    it("resolves responses that arrive out of order", async () => {
      const first = client.call("tree.path", { to: 1 });
      const second = client.call("tree.path", { to: 2 });

      transport.deliver(ok(2, { path: [2], cost: 2 }));
      transport.deliver(ok(1, { path: [1], cost: 1 }));

      await expect(first).resolves.toEqual({ path: [1], cost: 1 });
      await expect(second).resolves.toEqual({ path: [2], cost: 2 });
    });

    it("ignores a response with an unknown id", async () => {
      const malformed = vi.fn();
      client.dispose();
      client = new RpcClient(transport, { onMalformed: malformed });

      const p = client.call("build.summary", {});
      transport.deliver(ok(999, {}));
      expect(malformed).toHaveBeenCalledOnce();
      expect(client.inFlight).toBe(1);

      transport.deliver(ok(1, { name: "x" }));
      await expect(p).resolves.toMatchObject({ name: "x" });
    });

    it("drops a duplicate response instead of settling twice", async () => {
      const p = client.call("build.summary", {});
      transport.deliver(ok(1, { name: "first" }));
      transport.deliver(ok(1, { name: "second" }));
      await expect(p).resolves.toMatchObject({ name: "first" });
      expect(client.inFlight).toBe(0);
    });

    it("clears the pending entry once settled", async () => {
      const p = client.call("build.summary", {});
      expect(client.inFlight).toBe(1);
      transport.deliver(ok(1, {}));
      await p;
      expect(client.inFlight).toBe(0);
    });
  });

  describe("errors", () => {
    it("rejects with RpcRemoteError, preserving code and Lua traceback", async () => {
      const p = client.call("build.load", { code: "bad" });
      transport.deliver({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32000, message: "could not decode build", data: "stack traceback:…" },
      });

      const err = await p.catch((e) => e);
      expect(err).toBeInstanceOf(RpcRemoteError);
      expect(err.kind).toBe("remote");
      expect(err.code).toBe(-32000);
      expect(err.message).toBe("could not decode build");
      expect(err.data).toBe("stack traceback:…");
      expect(err.method).toBe("build.load");
    });

    it("rejects when a response has neither result nor error", async () => {
      const p = client.call("build.summary", {});
      transport.deliver({ jsonrpc: "2.0", id: 1 });
      const err = await p.catch((e) => e);
      expect(err).toBeInstanceOf(RpcTransportError);
      expect(err.code).toBe(ClientErrorCode.MALFORMED);
    });

    it("rejects when the transport cannot write", async () => {
      transport.failSend = new Error("broken pipe");
      const err = await client.call("build.summary", {}).catch((e) => e);
      expect(err).toBeInstanceOf(RpcTransportError);
      expect(err.code).toBe(ClientErrorCode.HOST_DIED);
    });

    it("refuses to call when the host is not running", async () => {
      transport.setState({ phase: "stopped" });
      const err = await client.call("build.summary", {}).catch((e) => e);
      expect(err.code).toBe(ClientErrorCode.HOST_NOT_RUNNING);
      expect(transport.sent).toHaveLength(0);
    });

    it("ignores frames that are not JSON-RPC", () => {
      const malformed = vi.fn();
      client.dispose();
      client = new RpcClient(transport, { onMalformed: malformed });
      transport.deliver("not an object");
      transport.deliver({ id: 1, result: {} });
      transport.deliver(null);
      expect(malformed).toHaveBeenCalledTimes(3);
    });
  });

  describe("timeouts", () => {
    it("rejects after the deadline and stops tracking the request", async () => {
      vi.useFakeTimers();
      const p = client.call("build.summary", {}, { timeoutMs: 100 });
      vi.advanceTimersByTime(101);

      const err = await p.catch((e) => e);
      expect(err).toBeInstanceOf(RpcTransportError);
      expect(err.code).toBe(ClientErrorCode.TIMEOUT);
      expect(err.method).toBe("build.summary");
      expect(client.inFlight).toBe(0);
    });

    it("does not fire once the response has arrived", async () => {
      vi.useFakeTimers();
      const p = client.call("build.summary", {}, { timeoutMs: 100 });
      transport.deliver(ok(1, { name: "fine" }));
      await expect(p).resolves.toMatchObject({ name: "fine" });
      expect(() => vi.advanceTimersByTime(500)).not.toThrow();
    });

    it("uses a longer default for build.load than for a plain call", async () => {
      vi.useFakeTimers();
      const load = client.call("build.load", { empty: true });
      const summary = client.call("build.summary", {});

      // The generic default is 10 s; build.load gets 60 s.
      vi.advanceTimersByTime(11_000);
      await expect(summary).rejects.toMatchObject({ code: ClientErrorCode.TIMEOUT });
      expect(client.inFlight).toBe(1);

      vi.advanceTimersByTime(60_000);
      await expect(load).rejects.toMatchObject({ code: ClientErrorCode.TIMEOUT });
    });
  });

  describe("cancellation", () => {
    it("rejects when the signal aborts", async () => {
      const ctrl = new AbortController();
      const p = client.call("tree.power", { metric: "offence" }, { signal: ctrl.signal });
      ctrl.abort();
      const err = await p.catch((e) => e);
      expect(err.code).toBe(ClientErrorCode.CANCELLED);
      expect(err.retryable).toBe(false);
    });

    it("rejects immediately for an already-aborted signal, without sending", async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      await expect(
        client.call("build.summary", {}, { signal: ctrl.signal }),
      ).rejects.toMatchObject({ code: ClientErrorCode.CANCELLED });
      expect(transport.sent).toHaveLength(0);
    });
  });

  describe("host death", () => {
    it("fails every in-flight request when the process exits", async () => {
      const a = client.call("build.summary", {});
      const b = client.call("stats.get", {});
      expect(client.inFlight).toBe(2);

      transport.setState({
        phase: "exited",
        code: 101,
        stderrTail: "lua: boom",
        willRestart: true,
      });

      for (const p of [a, b]) {
        const err = await p.catch((e) => e);
        expect(err).toBeInstanceOf(RpcTransportError);
        expect(err.code).toBe(ClientErrorCode.HOST_DIED);
        expect(err.retryable).toBe(true);
      }
      expect(client.inFlight).toBe(0);
    });

    it("fails in-flight requests when the supervisor gives up", async () => {
      const p = client.call("build.summary", {});
      transport.setState({ phase: "failed", reason: "spawn failed" });
      await expect(p).rejects.toMatchObject({ code: ClientErrorCode.HOST_DIED });
    });

    it("reports state changes to subscribers", () => {
      const seen: string[] = [];
      client.onStateChange((s) => seen.push(s.phase));
      transport.setState({ phase: "starting", attempt: 2 });
      transport.setState({ phase: "ready" });
      expect(seen).toEqual(["starting", "ready"]);
    });
  });

  describe("notifications", () => {
    it("delivers to subscribers by method name", () => {
      const seen: unknown[] = [];
      client.on("host.busy", (p) => seen.push(p));
      transport.deliver({
        jsonrpc: "2.0",
        method: "host.busy",
        params: { what: "loading tree", elapsedMs: 1200 },
      });
      expect(seen).toEqual([{ what: "loading tree", elapsedMs: 1200 }]);
    });

    it("does not confuse a notification with a response", async () => {
      const p = client.call("tree.power", { metric: "offence" });
      transport.deliver({
        jsonrpc: "2.0",
        method: "tree.power.progress",
        params: { id: 1, done: 10, total: 100, nodes: [] },
      });
      expect(client.inFlight).toBe(1);
      transport.deliver(ok(1, { requested: 100 }));
      await expect(p).resolves.toEqual({ requested: 100 });
    });

    it("routes correlated progress to the originating call", () => {
      const progress: Array<[string, unknown]> = [];
      void client
        .call("tree.power", { metric: "offence" }, {
          onProgress: (m, params) => progress.push([m, params]),
        })
        .catch(() => {});

      transport.deliver({
        jsonrpc: "2.0",
        method: "tree.power.progress",
        params: { id: 1, done: 5, total: 50, nodes: [] },
      });
      // A different request's progress must not leak into this handler.
      transport.deliver({
        jsonrpc: "2.0",
        method: "tree.power.progress",
        params: { id: 7, done: 5, total: 50, nodes: [] },
      });

      expect(progress).toHaveLength(1);
      expect(progress[0]![0]).toBe("tree.power.progress");
    });

    it("unsubscribes cleanly", () => {
      const seen: unknown[] = [];
      const off = client.on("host.busy", (p) => seen.push(p));
      off();
      transport.deliver({
        jsonrpc: "2.0",
        method: "host.busy",
        params: { what: "x", elapsedMs: 1 },
      });
      expect(seen).toHaveLength(0);
    });
  });

  describe("dispose", () => {
    it("fails everything in flight and refuses new calls", async () => {
      const p = client.call("build.summary", {});
      client.dispose();
      await expect(p).rejects.toMatchObject({ code: ClientErrorCode.DISPOSED });
      await expect(client.call("build.summary", {})).rejects.toMatchObject({
        code: ClientErrorCode.DISPOSED,
      });
    });
  });
});
