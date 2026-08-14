import { describe, expect, it } from "vitest";
import type { DisplayStat } from "@schema/rpc";

import { mockStats } from "../rpc/mock/fixtures";
import { filterStats, groupStats, heroStats, isEmptyRow } from "./stat-groups";

const stat = (key: string, value: DisplayStat["value"], extra: Partial<DisplayStat> = {}) =>
  ({ key, label: key, value, ...extra }) as DisplayStat;

describe("groupStats", () => {
  it("puts the real PoB keys in the expected groups", () => {
    const groups = groupStats(mockStats());
    const byId = new Map(groups.map((g) => [g.id, g.rows.map((r) => r.key)]));

    expect(byId.get("offence")).toContain("TotalDPS");
    expect(byId.get("offence")).toContain("CritMultiplier");
    expect(byId.get("pools")).toContain("Life");
    expect(byId.get("pools")).toContain("EnergyShield");
    expect(byId.get("defence")).toContain("Armour");
    expect(byId.get("defence")).toContain("TotalEHP");
    expect(byId.get("resistances")).toContain("FireResist");
    expect(byId.get("attributes")).toEqual(["Str", "Dex", "Int"]);
  });

  it("emits groups in the curated order", () => {
    const ids = groupStats(mockStats()).map((g) => g.id);
    expect(ids).toEqual([
      "offence",
      "pools",
      "defence",
      "resistances",
      "attributes",
      "misc",
    ]);
  });

  it("orders rows within a group by the curated list, not by arrival", () => {
    const groups = groupStats([
      stat("AverageHit", 100),
      stat("FullDPS", 900),
      stat("TotalDPS", 800),
    ]);
    expect(groups[0]!.rows.map((r) => r.key)).toEqual([
      "FullDPS",
      "TotalDPS",
      "AverageHit",
    ]);
  });

  it("keeps unrecognised keys rather than dropping them", () => {
    // Every league adds display stats; silently losing them is worse than
    // showing them unsorted.
    const groups = groupStats([stat("SomeNewLeagueStat", 42)]);
    const misc = groups.find((g) => g.id === "misc");
    expect(misc?.rows.map((r) => r.key)).toEqual(["SomeNewLeagueStat"]);
  });

  it("sorts unrecognised keys alphabetically after the known ones", () => {
    const groups = groupStats([
      stat("ZZZUnknown", 1),
      stat("AAAUnknown", 1),
      stat("ManaCost", 5),
    ]);
    const misc = groups.find((g) => g.id === "misc")!;
    expect(misc.rows.map((r) => r.key)).toEqual(["ManaCost", "AAAUnknown", "ZZZUnknown"]);
  });

  it("folds a resistance over-cap row into its main row", () => {
    const groups = groupStats([
      stat("FireResist", 76, { format: "%d%%" }),
      stat("FireResistOverCap", 31, { format: "%d%%" }),
    ]);
    const res = groups.find((g) => g.id === "resistances")!;
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]!.key).toBe("FireResist");
    expect(res.rows[0]!.overCap).toBe(31);
  });

  it("does not attach a zero over-cap", () => {
    const groups = groupStats([
      stat("ChaosResist", -24, { format: "%d%%" }),
      stat("ChaosResistOverCap", 0, { format: "%d%%" }),
    ]);
    expect(groups[0]!.rows[0]!.overCap).toBeUndefined();
  });

  it("hides zero rows by default", () => {
    const groups = groupStats([stat("Armour", 0), stat("Evasion", 21405)]);
    expect(groups.flatMap((g) => g.rows).map((r) => r.key)).toEqual(["Evasion"]);
  });

  it("keeps zero rows when asked", () => {
    const groups = groupStats([stat("Armour", 0), stat("Evasion", 21405)], {
      hideEmpty: false,
    });
    expect(groups.flatMap((g) => g.rows)).toHaveLength(2);
  });

  it("keeps a zero resistance, because 0% chaos res is information", () => {
    const groups = groupStats([stat("ChaosResist", 0, { format: "%d%%" })]);
    expect(groups.find((g) => g.id === "resistances")?.rows).toHaveLength(1);
  });

  it("keeps a zero value that has a non-zero delta", () => {
    const groups = groupStats([stat("BlockChance", 0, { delta: -25 })]);
    expect(groups.flatMap((g) => g.rows)).toHaveLength(1);
  });

  it("drops empty groups entirely", () => {
    const groups = groupStats([stat("Str", 155)]);
    expect(groups.map((g) => g.id)).toEqual(["attributes"]);
  });

  it("treats null values as empty", () => {
    expect(isEmptyRow(stat("X", null))).toBe(true);
    expect(isEmptyRow(stat("X", ""))).toBe(true);
    expect(isEmptyRow(stat("X", 0))).toBe(true);
    expect(isEmptyRow(stat("X", 1))).toBe(false);
  });
});

describe("heroStats", () => {
  it("picks the best available damage number", () => {
    const heroes = heroStats(mockStats());
    expect(heroes.map((h) => h.caption)).toEqual([
      "Damage",
      "Effective HP",
      "Life",
      "Energy Shield",
    ]);
    expect(heroes[0]!.stat.key).toBe("FullDPS");
  });

  it("falls back down the candidate list when the preferred key is missing", () => {
    const heroes = heroStats([stat("TotalDPS", 500_000), stat("Life", 4000)]);
    expect(heroes[0]!.stat.key).toBe("TotalDPS");
    expect(heroes.map((h) => h.caption)).toEqual(["Damage", "Life"]);
  });

  it("skips a candidate whose value is zero, e.g. a DoT build with no hit", () => {
    const heroes = heroStats([
      stat("FullDPS", 0),
      stat("TotalDot", 640_000),
      stat("Life", 5200),
    ]);
    expect(heroes[0]!.stat.key).toBe("TotalDot");
  });

  it("returns nothing rather than fake tiles for an empty build", () => {
    expect(heroStats([])).toEqual([]);
  });
});

describe("filterStats", () => {
  it("matches on the label", () => {
    const out = filterStats(mockStats(), "crit");
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((s) => /crit/i.test(`${s.label} ${s.key}`))).toBe(true);
  });

  it("matches on the engine key too", () => {
    expect(filterStats(mockStats(), "TotalEHP").map((s) => s.key)).toEqual(["TotalEHP"]);
  });

  it("requires every term, in any order", () => {
    const out = filterStats(mockStats(), "fire max");
    expect(out.map((s) => s.key)).toEqual(["FireMaximumHitTaken"]);
  });

  it("returns everything for an empty query", () => {
    const all = mockStats();
    expect(filterStats(all, "  ")).toBe(all);
  });
});
