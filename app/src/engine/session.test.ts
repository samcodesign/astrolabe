/**
 * Session-level behaviour, driven through the mock engine host.
 *
 * The cases that matter here are the ones a screenshot cannot show: what the
 * app does during the ~4.2 s boot, and what happens when the host dies with
 * work in flight.
 */

import { describe, expect, it, vi } from "vitest";

import { MockTransport } from "../rpc/mock/mock-transport";
import { EngineSession } from "./session";
import { getActive, getCompare } from "./specs";

const session = () => new EngineSession(new MockTransport({ speed: "instant" }));

/** Let queued microtasks and zero-delay timers drain. */
const settle = async (times = 6) => {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
};

describe("connect", () => {
  it("walks through spawning → handshake → ready", async () => {
    const s = session();
    const phases: string[] = [];
    s.store.subscribe(() => {
      const p = s.state.connection;
      if (phases[phases.length - 1] !== p) phases.push(p);
    });

    await s.connect();
    expect(phases).toEqual(["spawning", "handshake", "ready"]);
    expect(s.state.hostInfo?.pobVersion).toBeTruthy();
    await s.disconnect();
  });

  it("records the boot time the host reports, for the splash", async () => {
    const s = session();
    await s.connect();
    expect(s.state.hostInfo?.bootMs).toBeGreaterThan(0);
    expect(s.state.log.join("\n")).toContain("engine ready");
    await s.disconnect();
  });

  it("is idempotent — a second call joins the first", async () => {
    const s = session();
    const a = s.connect();
    const b = s.connect();
    await Promise.all([a, b]);
    expect(s.state.connection).toBe("ready");
    await s.disconnect();
  });

  it("reports a spawn failure instead of hanging", async () => {
    const transport = new MockTransport({ speed: "instant" });
    vi.spyOn(transport, "start").mockRejectedValue(new Error("engine-host.exe not found"));
    const s = new EngineSession(transport);
    await s.connect();
    expect(s.state.connection).toBe("failed");
    expect(s.state.connectionError).toContain("not found");
  });
});

describe("host.busy", () => {
  it("surfaces the engine's own description of long work", async () => {
    const s = new EngineSession(new MockTransport({ speed: "real" }));
    await s.connect();

    const seen: string[] = [];
    s.store.subscribe(() => {
      const b = s.state.busy;
      if (b && !seen.includes(b.what)) seen.push(b.what);
    });

    // The first load of a tree version is the ~5 s case host.busy exists for.
    await s.loadEmpty();
    expect(seen.some((w) => w.includes("passive tree"))).toBe(true);
    await s.disconnect();
  }, 20_000);

  it("clears itself, since the schema has no busy-done notification", async () => {
    const s = session();
    await s.connect();
    await s.loadEmpty();
    // BUSY_IDLE_MS is 900 ms; allow a margin.
    await new Promise((r) => setTimeout(r, 1_100));
    expect(s.state.busy).toBeNull();
    await s.disconnect();
  }, 10_000);
});

describe("build loading", () => {
  it("loads a code and creates the first tree variant from it", async () => {
    const s = session();
    await s.connect();
    const ok = await s.loadCode("eNrtWk1v2zgQvfdXCD4X");

    expect(ok).toBe(true);
    expect(s.state.build?.className).toBe("Shadow");
    expect(s.state.specs.specs).toHaveLength(1);
    expect(getActive(s.state.specs)?.allocated).toEqual(s.state.build?.allocated);
    expect(s.state.stats.length).toBeGreaterThan(0);
    await s.disconnect();
  });

  it("surfaces a decode failure as an import error, not a crash", async () => {
    const s = new EngineSession(new MockTransport({ speed: "instant", failLoads: 1 }));
    await s.connect();
    const ok = await s.loadCode("not-a-code");

    expect(ok).toBe(false);
    expect(s.state.importError).toContain("not valid base64");
    expect(s.state.build).toBeNull();
    await s.disconnect();
  });

  it("passes a character payload straight through to build.load", async () => {
    const s = session();
    await s.connect();
    const ok = await s.loadCharacter(
      {
        source: "pathofexile.com",
        account: "Exile#1234",
        character: "Zealot",
        realm: "pc",
        items: {},
        passives: {},
      },
      "Zealot",
    );
    expect(ok).toBe(true);
    expect(s.state.build?.name).toBe("Zealot");
    await s.disconnect();
  });
});

describe("tree variants", () => {
  it("switches the engine's allocation when a variant is selected", async () => {
    const s = session();
    await s.connect();
    await s.loadEmpty();

    s.newSpec({ fromCurrent: true });
    const [first, second] = s.state.specs.specs;
    expect(second).toBeDefined();

    await s.allocate([1111, 2222]);
    expect(s.state.build?.allocated).toContain(1111);

    await s.selectSpec(second!.id);
    expect(s.state.specs.activeId).toBe(second!.id);
    // The second variant was a snapshot from before the edit, so the engine
    // must have had those nodes taken back off.
    expect(s.state.build?.allocated).not.toContain(1111);

    await s.selectSpec(first!.id);
    expect(s.state.build?.allocated).toContain(1111);
    await s.disconnect();
  });

  it("tracks edits against the active variant only", async () => {
    const s = session();
    await s.connect();
    await s.loadEmpty();
    s.newSpec({ fromCurrent: true });
    const [first, second] = s.state.specs.specs;

    await s.selectSpec(second!.id);
    await s.allocate([4242]);

    expect(getActive(s.state.specs)?.allocated).toContain(4242);
    expect(s.state.specs.specs.find((x) => x.id === first!.id)!.allocated).not.toContain(
      4242,
    );
    await s.disconnect();
  });

  it("requests deltas once a compare variant is chosen", async () => {
    const s = session();
    await s.connect();
    await s.loadEmpty();
    s.newSpec({ fromCurrent: true });
    const second = s.state.specs.specs[1]!;

    s.setCompare(second.id);
    await settle();

    expect(getCompare(s.state.specs)?.id).toBe(second.id);
    expect(s.state.stats.some((st) => st.delta !== undefined)).toBe(true);
    await s.disconnect();
  });

  it("keeps at least one variant", async () => {
    const s = session();
    await s.connect();
    await s.loadEmpty();
    s.deleteSpec(s.state.specs.specs[0]!.id);
    expect(s.state.specs.specs).toHaveLength(1);
    expect(s.state.banner?.text).toContain("at least one");
    await s.disconnect();
  });
});

describe("host death", () => {
  it("marks the session as recovering and warns the user", async () => {
    const transport = new MockTransport({ speed: "instant" });
    const s = new EngineSession(transport);
    await s.connect();
    await s.loadCode("abc");

    transport.simulateCrash(true);
    expect(s.state.connection).toBe("recovering");
    expect(s.state.banner?.kind).toBe("warn");
    expect(s.state.banner?.text).toContain("crashed");
    expect(s.state.banner?.detail).toContain("lua:");
  });

  it("fails a request that was in flight when the host died", async () => {
    const transport = new MockTransport({ speed: "instant" });
    const s = new EngineSession(transport);
    await s.connect();

    const pending = s.client.call("stats.get", {});
    transport.simulateCrash(true);

    await expect(pending).rejects.toMatchObject({ kind: "transport" });
  });

  it("reloads the build and re-applies the active variant after a restart", async () => {
    const transport = new MockTransport({ speed: "instant" });
    const s = new EngineSession(transport);
    await s.connect();
    await s.loadCode("abc");
    await s.allocate([31337]);
    const before = getActive(s.state.specs)!.allocated;
    expect(before).toContain(31337);

    transport.simulateCrash(true);
    expect(s.state.connection).toBe("recovering");

    // The Rust supervisor is what restarts the process in the real app; here we
    // stand in for it.
    await transport.start();
    await settle(20);

    expect(s.state.connection).toBe("ready");
    expect(s.state.banner?.kind).toBe("success");
    expect(s.state.build?.allocated).toContain(31337);
  });

  it("gives up loudly when the supervisor will not restart", async () => {
    const transport = new MockTransport({ speed: "instant" });
    const s = new EngineSession(transport);
    await s.connect();
    transport.simulateCrash(false);

    expect(s.state.connection).toBe("failed");
    expect(s.state.connectionError).toContain("keeps crashing");
  });
});

describe("heatmap", () => {
  it("streams batches and finishes", async () => {
    const s = session();
    await s.connect();
    await s.loadEmpty();

    s.startHeatmap("offence", 2);
    await settle(80);

    const h = s.state.heatmap!;
    expect(h.running).toBe(false);
    expect(h.total).toBeGreaterThan(0);
    expect(h.nodes.length).toBeGreaterThan(0);
    expect(h.elapsedMs).not.toBeNull();
    // Highest value per point first.
    expect(h.nodes[0]!.perPoint).toBeGreaterThanOrEqual(h.nodes[1]!.perPoint);
    await s.disconnect();
  }, 15_000);

  it("stops on cancel without recording an error", async () => {
    const s = new EngineSession(new MockTransport({ speed: "real" }));
    await s.connect();
    await s.loadEmpty();

    s.startHeatmap("offence", 3);
    await new Promise((r) => setTimeout(r, 400));
    s.cancelHeatmap();
    await settle(10);

    expect(s.state.heatmap?.running).toBe(false);
    expect(s.state.heatmap?.error).toBeNull();
    await s.disconnect();
  }, 30_000);
});

describe("save and load", () => {
  it("round-trips a plan with every variant", async () => {
    const s = session();
    await s.connect();
    await s.loadCode("abc");
    s.newSpec({ fromCurrent: true });
    s.renameSpec(s.state.specs.specs[1]!.id, "Boss setup");

    const text = await s.serialisePlan();
    expect(text).toContain("Boss setup");

    const s2 = session();
    await s2.connect();
    const ok = await s2.openPlan(text);

    expect(ok).toBe(true);
    expect(s2.state.specs.specs.map((x) => x.title)).toEqual([
      "Imported tree",
      "Boss setup",
    ]);
    await s.disconnect();
    await s2.disconnect();
  });

  it("rejects a file that is not a plan", async () => {
    const s = session();
    await s.connect();
    const ok = await s.openPlan("just some text");
    expect(ok).toBe(false);
    expect(s.state.importError).toContain("not a saved plan");
    await s.disconnect();
  });
});

describe("class and ascendancy", () => {
  /** Berserker, from a Shadow build with a tree already spent. */
  const crossClass = { node: 55_555, ascendancy: "Berserker", className: "Marauder" };

  it("switches ascendancy within the class and allocates the clicked node", async () => {
    const s = session();
    await s.connect();
    await s.loadCode("abc");
    const before = s.state.build!.allocated.length;

    const res = await s.selectAscendancy({
      node: 55_555,
      ascendancy: "Assassin",
      className: "Shadow",
    });

    expect(res).toEqual({ kind: "applied" });
    expect(s.state.build?.ascendClassName).toBe("Assassin");
    // Same class, so nothing was reset — the node is simply added.
    expect(s.state.build?.allocated).toContain(55_555);
    expect(s.state.build!.allocated.length).toBe(before + 1);
    await s.disconnect();
  });

  it("reports a cross-class conflict instead of resetting the tree", async () => {
    const s = session();
    await s.connect();
    await s.loadCode("abc");
    const before = s.state.build!.allocated;

    const res = await s.selectAscendancy(crossClass);

    expect(res.kind).toBe("conflict");
    if (res.kind !== "conflict") throw new Error("unreachable");
    expect(res.conflict.kind).toBe("classChange");
    expect(res.conflict.className).toBe("Marauder");
    expect(res.conflict.message).toContain("\n");
    expect(res.conflict.options).toEqual(["connect", "reset"]);

    // The whole point: nothing moved, and no error banner was raised either.
    expect(s.state.build?.allocated).toBe(before);
    expect(s.state.build?.className).toBe("Shadow");
    expect(s.state.banner).toBeNull();
    expect(s.state.statsPending).toBe(false);
    await s.disconnect();
  });

  it('answers the prompt with "reset" and allocates the clicked node', async () => {
    const s = session();
    await s.connect();
    await s.loadCode("abc");
    expect((await s.selectAscendancy(crossClass)).kind).toBe("conflict");

    const res = await s.selectAscendancy(crossClass, "reset");

    expect(res).toEqual({ kind: "applied" });
    expect(s.state.build?.className).toBe("Marauder");
    expect(s.state.build?.ascendClassName).toBe("Berserker");
    // The tree was thrown away, so the clicked node is all that is left.
    expect(s.state.build?.allocated).toEqual([55_555]);
    await s.disconnect();
  });

  it('answers the prompt with "connect" and keeps the tree', async () => {
    const s = session();
    await s.connect();
    await s.loadCode("abc");
    const before = s.state.build!.allocated.length;
    expect((await s.selectAscendancy(crossClass)).kind).toBe("conflict");

    const res = await s.selectAscendancy(crossClass, "connect");

    expect(res).toEqual({ kind: "applied" });
    expect(s.state.build?.className).toBe("Marauder");
    expect(s.state.build?.allocated).toContain(55_555);
    expect(s.state.build!.allocated.length).toBe(before + 1);
    await s.disconnect();
  });

  it("keeps the active variant in step with the new allocation", async () => {
    const s = session();
    await s.connect();
    await s.loadCode("abc");
    await s.selectAscendancy(crossClass, "reset");
    expect(getActive(s.state.specs)?.allocated).toEqual([55_555]);
    await s.disconnect();
  });

  it("surfaces a rejected class name as an error, not a prompt", async () => {
    const s = session();
    await s.connect();
    await s.loadCode("abc");
    vi.spyOn(s.client, "call").mockRejectedValue(new Error("no such class: Wraeclast"));

    const res = await s.setClass({ className: "Wraeclast" });

    expect(res.kind).toBe("error");
    expect(s.state.banner?.kind).toBe("error");
    expect(s.state.statsPending).toBe(false);
    await s.disconnect();
  });

  it("does not allocate anything when the switch never happened", async () => {
    const s = session();
    await s.connect();
    await s.loadCode("abc");
    const allocate = vi.spyOn(s, "allocate");

    await s.selectAscendancy(crossClass);

    expect(allocate).not.toHaveBeenCalled();
    await s.disconnect();
  });
});
