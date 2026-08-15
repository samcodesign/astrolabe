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

describe("main skill", () => {
  it("is read once a build is loaded, so the stats can say which skill they describe", async () => {
    const s = session();
    await s.connect();
    expect(s.state.mainSkill).toBeNull();

    await s.loadCode("eNrtWk1v2zgQvfdXCD4X");
    expect(s.state.mainSkill?.empty).toBe(false);
    expect(s.state.mainSkill?.groups.length).toBeGreaterThan(1);
    expect(s.state.mainSkill?.groupIndex).toBe(1);
    await s.disconnect();
  });

  it("replaces the whole selection on a change, because the controls themselves change", async () => {
    const s = session();
    await s.connect();
    await s.loadCode("eNrtWk1v2zgQvfdXCD4X");

    // Group 1 is a multi-part skill with stages.
    expect(s.state.mainSkill?.part).toBeDefined();
    expect(s.state.mainSkill?.stageCount).toBeDefined();

    // Group 2 is a single skill with neither. A UI that kept the old controls
    // would render a part selector belonging to a skill that has no parts.
    await s.setMainSkill({ group: 2 });
    expect(s.state.mainSkill?.groupIndex).toBe(2);
    expect(s.state.mainSkill?.part).toBeUndefined();
    expect(s.state.mainSkill?.stageCount).toBeUndefined();

    await s.setMainSkill({ group: 3 });
    expect(s.state.mainSkill?.minion?.kind).toBe("minion");

    await s.disconnect();
  });

  it("leaves the stats alone when the selection cannot be read", async () => {
    const s = session();
    await s.connect();
    await s.loadCode("eNrtWk1v2zgQvfdXCD4X");
    const stats = s.state.stats;

    // An engine too old to know the method must not take the stat panel down
    // with it: the numbers are still right, only their label is missing.
    s.client.call = (() => Promise.reject(new Error("no such method"))) as never;
    await s.refreshMainSkill();

    expect(s.state.mainSkill).toBeNull();
    expect(s.state.stats).toBe(stats);
    expect(s.state.banner).toBeNull();
    await s.disconnect();
  });
});

describe("skills", () => {
  it("reads the groups with the build and the catalogue only once", async () => {
    const s = session();
    await s.connect();
    await s.loadCode("eNrtWk1v2zgQvfdXCD4X");

    expect(s.state.skills?.groups.length).toBeGreaterThan(0);
    expect(s.state.gemCatalogue?.length).toBeGreaterThan(0);

    const catalogue = s.state.gemCatalogue;
    await s.refreshSkills();
    expect(s.state.gemCatalogue).toBe(catalogue);
    await s.disconnect();
  });

  it("keeps skills and the main-skill selector in one commit", async () => {
    const s = session();
    await s.connect();
    await s.loadCode("eNrtWk1v2zgQvfdXCD4X");

    const added = await s.addSocketGroup({ label: "new group" });
    expect(added).toBe(s.state.skills?.groups.length);
    // Both slices must move together; a mutation that refreshed only one would
    // leave the sidebar describing a group list that no longer matches.
    expect(s.state.skills?.groups.at(-1)?.label).toBe("new group");
    expect(s.state.mainSkill).not.toBeNull();
    await s.disconnect();
  });

  it("renumbers gems after a delete, so indices stay dense", async () => {
    const s = session();
    await s.connect();
    await s.loadCode("eNrtWk1v2zgQvfdXCD4X");

    const before = s.state.skills!.groups[0]!.gems.map((g) => g.name);
    expect(before.length).toBeGreaterThan(1);

    await s.deleteGem(1, 1);
    const after = s.state.skills!.groups[0]!.gems;
    expect(after.map((g) => g.name)).toEqual(before.slice(1));
    expect(after.map((g) => g.index)).toEqual(after.map((_, i) => i + 1));
    await s.disconnect();
  });

  it("surfaces a failed edit as a banner and leaves the list alone", async () => {
    const s = session();
    await s.connect();
    await s.loadCode("eNrtWk1v2zgQvfdXCD4X");
    const skills = s.state.skills;

    s.client.call = (() => Promise.reject(new Error("no such gem"))) as never;
    await s.setGem({ group: 1, gem: 1, gemId: "nope" });

    expect(s.state.skills).toBe(skills);
    expect(s.state.banner?.kind).toBe("error");
    expect(s.state.statsPending).toBe(false);
    await s.disconnect();
  });
});

describe("skill sets", () => {
  it("does not let a new set inherit the old one's groups", async () => {
    const s = session();
    await s.connect();
    await s.loadCode("eNrtWk1v2zgQvfdXCD4X");

    const before = s.state.skills!.groups.length;
    expect(before).toBeGreaterThan(0);

    const created = await s.newSkillSet({ title: "bossing" });
    expect(created).not.toBeNull();
    expect(s.state.skills?.activeSet).toBe(created);
    expect(s.state.skills?.groups).toHaveLength(0);

    await s.activateSkillSet(1);
    expect(s.state.skills?.groups).toHaveLength(before);
    await s.disconnect();
  });

  it("restores the group a set was on rather than clamping it away", async () => {
    const s = session();
    await s.connect();
    await s.loadCode("eNrtWk1v2zgQvfdXCD4X");
    const groups = s.state.skills!.groups.length;

    await s.setMainSkill({ group: groups });
    const empty = await s.newSkillSet({ title: "empty" });
    await s.activateSkillSet(empty!);
    // Nothing to point at, so it must be clamped into range — not left past
    // the end of a list that no longer has that many groups.
    expect(s.state.skills?.mainGroup).toBe(1);

    await s.activateSkillSet(1);
    expect(s.state.skills?.mainGroup).toBe(groups);
    await s.disconnect();
  });
});

describe("configuration", () => {
  it("reads the catalogue once and the state with every build", async () => {
    const s = session();
    await s.connect();
    await s.loadCode("eNrtWk1v2zgQvfdXCD4X");

    expect(s.state.configSchema?.length).toBeGreaterThan(0);
    expect(s.state.configState?.values["enemyLevel"]).toBe(84);

    // The schema is fixed for the engine's lifetime, so a second read must not
    // fetch a thousand option definitions again.
    const schema = s.state.configSchema;
    await s.refreshConfig();
    expect(s.state.configSchema).toBe(schema);
    await s.disconnect();
  });

  it("applies several options in one call, so quest choices cost one recalculation", async () => {
    const s = session();
    await s.connect();
    await s.loadCode("eNrtWk1v2zgQvfdXCD4X");

    await s.setConfig({ values: { bandit: "Alira", pantheonMajorGod: "Lunaris" } });
    expect(s.state.configState?.values["bandit"]).toBe("Alira");
    expect(s.state.configState?.values["pantheonMajorGod"]).toBe("Lunaris");

    // Clearing is not the same as setting the default: it means never touched.
    await s.setConfig({ clear: ["bandit"] });
    expect(s.state.configState?.values["bandit"]).toBeUndefined();
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

describe("hover comparisons", () => {
  /**
   * The engine answers these by editing the live build, calculating, and
   * editing it back — there is no override channel for gems or config. Two
   * overlapping calls would interleave two mutations over one build, so the
   * session has to hold the line the protocol cannot.
   */
  it("never has two in flight, and drops the ones the pointer moved past", async () => {
    const s = session();
    await s.connect();
    await s.loadEmpty();

    const inFlight: string[] = [];
    let peak = 0;
    let live = 0;
    // `call` is overloaded per method, so the spy is typed structurally — it
    // only counts overlap and passes everything through untouched.
    type AnyCall = (m: string, p: unknown) => Promise<unknown>;
    const original = s.client.call.bind(s.client) as AnyCall;
    vi.spyOn(s.client, "call").mockImplementation((async (method: string, params: unknown) => {
      if (method !== "stats.compare") return original(method, params);
      live++;
      peak = Math.max(peak, live);
      inFlight.push(String((params as { change: { gem?: number } }).change.gem));
      try {
        return await original(method, params);
      } finally {
        live--;
      }
    }) as typeof s.client.call);

    // A pointer sweeping five rows of a gem list.
    const sweep = [1, 2, 3, 4, 5].map((gem) =>
      s.compare({ kind: "gemEnabled", group: 1, gem }),
    );
    const results = await Promise.all(sweep);

    expect(peak).toBe(1);
    // Only the last one is still wanted by the time the engine is free; the
    // rest are dropped before they are sent, not after they come back.
    expect(inFlight).toEqual(["5"]);
    expect(results.slice(0, 4)).toEqual([null, null, null, null]);
    expect(results[4]?.stats.length).toBeGreaterThan(0);

    await s.disconnect();
  });

  it("answers null rather than throwing when the engine refuses", async () => {
    const s = session();
    await s.connect();
    await s.loadEmpty();

    // A comparison is a hint. Failing one must not surface as an error over a
    // build the user is in the middle of editing.
    const bad = await s.compare({ kind: "config" } as never);
    expect(bad).toBeNull();

    // And the chain still works afterwards — a rejection must not poison it.
    const good = await s.compare({ kind: "gemEnabled", group: 1, gem: 1 });
    expect(good?.stats.length).toBeGreaterThan(0);

    await s.disconnect();
  });

  it("stands aside while a heatmap owns the engine", async () => {
    const s = session();
    await s.connect();
    await s.loadEmpty();

    s.startHeatmap("offence", 2);
    expect(await s.compare({ kind: "gemEnabled", group: 1, gem: 1 })).toBeNull();

    s.cancelHeatmap();
    await settle(20);
    expect(await s.compare({ kind: "gemEnabled", group: 1, gem: 1 })).not.toBeNull();

    await s.disconnect();
  });
});

describe("items", () => {
  const ready = async () => {
    const s = session();
    await s.connect();
    await s.loadEmpty();
    return s;
  };

  it("loads the gear alongside the skills and config", async () => {
    const s = await ready();
    const items = s.state.items!;
    expect(items).not.toBeNull();
    expect(items.items.length).toBeGreaterThan(0);
    expect(items.sets.length).toBeGreaterThan(0);

    // The slot list carries entries that must not be rendered: abyssal sockets
    // whose parent has none. A panel that ignores `shown` draws empty rows.
    expect(items.slots.some((sl) => !sl.shown)).toBe(true);
    // And jewel sockets, which store into the tree rather than the item set.
    expect(items.slots.some((sl) => sl.nodeId != null)).toBe(true);

    // `label` is not unique — the weapon swaps share it, so anything keying on
    // it alone will collide.
    const labels = items.slots.map((sl) => sl.label);
    expect(new Set(labels).size).toBeLessThan(labels.length);

    await s.disconnect();
  });

  it("equips an item and clears a slot", async () => {
    const s = await ready();
    const body = s.state.items!.items.find((i) => i.type === "Body Armour")!;

    await s.equipItem("Body Armour", body.id);
    expect(s.state.items!.slots.find((sl) => sl.name === "Body Armour")?.itemId).toBe(body.id);

    await s.equipItem("Body Armour", false);
    expect(s.state.items!.slots.find((sl) => sl.name === "Body Armour")?.itemId).toBeUndefined();

    await s.disconnect();
  });

  it("refuses an illegal slot and says which item", async () => {
    const s = await ready();
    const boots = s.state.items!.items.find((i) => i.type === "Boots")!;

    await s.equipItem("Helmet", boots.id);
    expect(s.state.banner?.kind).toBe("error");
    expect(s.state.banner?.text).toContain("Seven-League Step");
    // And nothing moved.
    expect(s.state.items!.slots.find((sl) => sl.name === "Helmet")?.itemId).not.toBe(boots.id);

    await s.disconnect();
  });

  it("pastes an item, and reports a failure rather than doing nothing", async () => {
    const s = await ready();
    const before = s.state.items!.items.length;

    const ok = await s.pasteItem("Rarity: RARE\nDoom Nails\nSteel Ring\n+40 to Dexterity");
    expect(ok).toBe(true);
    expect(s.state.items!.items.length).toBe(before + 1);
    expect(s.state.items!.items.some((i) => i.title === "Doom Nails")).toBe(true);

    // A failed paste is the one item action a user triggers by accident. It has
    // to surface, not look like nothing happened.
    const bad = await s.pasteItem("just some text");
    expect(bad).toBe(false);
    expect(s.state.banner?.kind).toBe("error");
    expect(s.state.items!.items.length).toBe(before + 1);

    await s.disconnect();
  });

  it("deletes an item out of its slot as well as the pool", async () => {
    const s = await ready();
    const helmet = s.state.items!.items.find((i) => i.type === "Helmet")!;
    expect(s.state.items!.slots.find((sl) => sl.name === "Helmet")?.itemId).toBe(helmet.id);

    await s.deleteItem(helmet.id);

    expect(s.state.items!.items.some((i) => i.id === helmet.id)).toBe(false);
    expect(
      s.state.items!.slots.find((sl) => sl.name === "Helmet")?.itemId,
    ).toBeUndefined();

    await s.disconnect();
  });

  it("moves a mod roll within its range, and only where there is one", async () => {
    const s = await ready();
    const item = s.state.items!.items.find((i) => i.mods?.explicit?.some((m) => m.range != null))!;
    const mod = item.mods!.explicit!.find((m) => m.range != null)!;

    await s.setItemModRange({ item: item.id, list: "explicit", index: mod.index, range: 1 });
    const after = s.state.items!.items.find((i) => i.id === item.id)!;
    expect(after.mods!.explicit!.find((m) => m.index === mod.index)!.range).toBe(1);

    // Out of bounds is clamped, not rejected — a slider cannot send anything else.
    await s.setItemModRange({ item: item.id, list: "explicit", index: mod.index, range: 5 });
    expect(
      s.state.items!.items.find((i) => i.id === item.id)!.mods!.explicit!.find(
        (m) => m.index === mod.index,
      )!.range,
    ).toBe(1);

    await s.disconnect();
  });

  it("selects variants per axis, not one for the whole item", async () => {
    const s = await ready();
    const item = s.state.items!.items.find((i) => i.variants)!;
    expect(item.variants!.axes.length).toBeGreaterThan(1);

    await s.setItemVariant({ item: item.id, key: "variantAlt", index: 1 });
    const after = s.state.items!.items.find((i) => i.id === item.id)!;

    expect(after.variants!.axes.find((a) => a.key === "variantAlt")!.selected).toBe(1);
    // The other axis must not have moved with it.
    expect(after.variants!.axes.find((a) => a.key === "variant")!.selected).toBe(
      item.variants!.axes.find((a) => a.key === "variant")!.selected,
    );

    await s.disconnect();
  });

  it("manages item sets and keeps one alive", async () => {
    const s = await ready();
    const first = s.state.items!.activeSet;

    const made = await s.newItemSet({ title: "bossing", copyFrom: first });
    expect(made).not.toBeNull();
    expect(s.state.items!.sets.some((set) => set.title === "bossing")).toBe(true);

    await s.activateItemSet(made!);
    expect(s.state.items!.activeSet).toBe(made);

    await s.renameItemSet(made!, "uber");
    expect(s.state.items!.sets.some((set) => set.title === "uber")).toBe(true);

    await s.deleteItemSet(made!);
    const active = s.state.items!.activeSet;
    expect(s.state.items!.sets.some((set) => set.id === active)).toBe(true);

    await s.deleteItemSet(active);
    expect(s.state.banner?.text).toContain("at least one item set");

    await s.disconnect();
  });

  it("offers only the slots an item legally fits", async () => {
    const s = await ready();
    const flask = s.state.items!.items.find((i) => i.type === "Flask")!;
    const slots = await s.slotsForItem(flask.id);
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.every((sl) => sl.startsWith("Flask"))).toBe(true);

    expect(await s.slotsForItem(99999)).toEqual([]);
    await s.disconnect();
  });
});
