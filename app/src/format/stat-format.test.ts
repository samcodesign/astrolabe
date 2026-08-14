import { describe, expect, it } from "vitest";

import {
  compactNumber,
  deltaTone,
  formatDelta,
  formatStatValue,
  groupThousands,
  isLowerBetter,
  printf,
  signedSpec,
  pobFormatSpec,
} from "./stat-format";

describe("printf", () => {
  it("handles the specs PoB actually emits", () => {
    expect(printf("%d", 1284310)).toBe("1284310");
    expect(printf("%.2f", 4.3125)).toBe("4.31");
    expect(printf("%.1f", 412.74)).toBe("412.7");
    expect(printf("%d%%", 76)).toBe("76%");
    expect(printf("%.2f%%", 38.437)).toBe("38.44%");
    expect(printf("%.2fx", 3.4499)).toBe("3.45x");
    expect(printf("+%d%%", 34)).toBe("+34%");
  });

  it("truncates %d and rounds %f, as C does", () => {
    // These differ, and PoB depends on both: string.format("%d", 2.7) is "2".
    expect(printf("%d", 4.6)).toBe("4");
    expect(printf("%d", 2.735229759)).toBe("2");
    expect(printf("%.1f", 0.25)).toBe("0.3");
  });

  it("keeps the sign on negative values", () => {
    expect(printf("%d%%", -24)).toBe("-24%");
    expect(printf("%.2f", -1.005)).toBe("-1.00");
  });

  it("honours the + flag", () => {
    expect(printf("%+d", 12)).toBe("+12");
    expect(printf("%+d", -12)).toBe("-12");
    expect(printf("%+.1f%%", 3.25)).toBe("+3.3%");
  });

  it("honours width and zero padding", () => {
    expect(printf("%5d", 42)).toBe("   42");
    expect(printf("%-5d|", 42)).toBe("42   |");
    expect(printf("%05d", 42)).toBe("00042");
    expect(printf("%05d", -42)).toBe("-0042");
  });

  it("treats %% as a literal percent", () => {
    expect(printf("100%%", 0)).toBe("100%");
  });

  it("passes strings through %s", () => {
    expect(printf("%s", "Trickster")).toBe("Trickster");
  });

  it("does not blow up on non-finite values", () => {
    expect(printf("%d", Infinity)).toBe("∞");
    expect(printf("%.2f", NaN)).toBe("NaN");
  });

  it("drops trailing zeros for %g", () => {
    expect(printf("%.3g", 1.5000)).toBe("1.5");
  });
});

describe("groupThousands", () => {
  it("groups long integers", () => {
    expect(groupThousands("1284310")).toBe("1,284,310");
    expect(groupThousands("48120")).toBe("48,120");
  });

  it("groups four-digit numbers, as PoB does", () => {
    // `formatNumSep` (Common.lua:741) has no minimum width — its own header
    // example is "1234.56" -> "1,234.5". Checked against PoB on a real build:
    // it shows Life 2,574 and Energy Shield 7,717.
    expect(groupThousands("4812")).toBe("4,812");
    expect(groupThousands("2574")).toBe("2,574");
    // Three digits stay bare, which is also what PoB shows for Mana 914.
    expect(groupThousands("914")).toBe("914");
  });

  it("does not touch decimals", () => {
    expect(groupThousands("412.7")).toBe("412.7");
    expect(groupThousands("38.44%")).toBe("38.44%");
  });

  it("keeps the negative sign attached", () => {
    expect(groupThousands("-124500")).toBe("-124,500");
  });
});

describe("compactNumber", () => {
  it("abbreviates the way build guides do", () => {
    expect(compactNumber(1_284_310)).toBe("1.28M");
    expect(compactNumber(48_120)).toBe("48.1k");
    expect(compactNumber(9_999)).toBe("9999");
    expect(compactNumber(2_400_000_000)).toBe("2.4B");
  });

  it("keeps small numbers exact", () => {
    expect(compactNumber(4.31)).toBe("4.31");
    expect(compactNumber(76)).toBe("76");
  });

  it("handles negatives", () => {
    expect(compactNumber(-1_500_000)).toBe("-1.5M");
  });
});

describe("formatStatValue", () => {
  it("applies the host's format spec and groups thousands", () => {
    expect(formatStatValue({ value: 1284310, format: "%d" })).toBe("1,284,310");
  });

  it("renders null as an em dash rather than 0", () => {
    expect(formatStatValue({ value: null })).toBe("—");
  });

  it("passes string values through untouched", () => {
    expect(formatStatValue({ value: "Immune", format: "%d" })).toBe("Immune");
  });

  it("falls back sensibly with no spec", () => {
    expect(formatStatValue({ value: 42 })).toBe("42");
    expect(formatStatValue({ value: 4.3125 })).toBe("4.31");
    expect(formatStatValue({ value: 12345.6 })).toBe("12,346");
  });

  it("compacts only large numbers in compact mode, keeping the percent sign", () => {
    expect(formatStatValue({ value: 1284310, format: "%d" }, { compact: true })).toBe("1.28M");
    expect(formatStatValue({ value: 76, format: "%d%%" }, { compact: true })).toBe("76%");
    expect(formatStatValue({ value: 150000, format: "%d%%" }, { compact: true })).toBe("150k%");
  });

  it("can skip grouping", () => {
    expect(formatStatValue({ value: 1284310, format: "%d" }, { group: false })).toBe("1284310");
  });
});

describe("signedSpec", () => {
  it("adds a + flag", () => {
    expect(signedSpec("%d")).toBe("%+d");
    expect(signedSpec("%.2f")).toBe("%+.2f");
    expect(signedSpec("%d%%")).toBe("%+d%%");
  });

  it("renders the specs the engine actually sends", () => {
    // Captured from a live host: PoB's `BuildDisplayStats` stores `fmt` with
    // no leading `%` (BuildDisplayStats.lua:14-21) and the engine passes it
    // through untouched. Assuming a `%` here put ".1f" and "d" on screen in
    // place of every number in the stat panel.
    expect(formatStatValue({ value: 48213.4, format: ".1f" })).toBe("48,213.4");
    expect(formatStatValue({ value: 4.31, format: ".2f" })).toBe("4.31");
    expect(formatStatValue({ value: 20, format: "d" })).toBe("20");
    expect(formatStatValue({ value: 5, format: ".0f%%" })).toBe("5%");
    expect(formatStatValue({ value: 3.45, format: ".2fx" })).toBe("3.45x");
  });

  it("truncates %d rather than rounding, as C does", () => {
    // PoB shows "Unreserved Mana: 2%" for a value of 2.735229759 — Lua's
    // string.format("%d", ...) truncates. Rounding printed 3% and disagreed
    // with PoB on the same build.
    expect(formatStatValue({ value: 2.735229759, format: "d%%" })).toBe("2%");
    expect(formatStatValue({ value: 2.999, format: "d" })).toBe("2");
    expect(formatStatValue({ value: -2.9, format: "d" })).toBe("-2");
    expect(formatStatValue({ value: 7717, format: "d" })).toBe("7,717");
  });

  it("still accepts a spec that already carries its %", () => {
    expect(formatStatValue({ value: 48213.4, format: "%.1f" })).toBe("48,213.4");
    expect(pobFormatSpec("%.1f")).toBe("%.1f");
    expect(pobFormatSpec(".1f")).toBe("%.1f");
    expect(pobFormatSpec("+%d%%")).toBe("+%d%%");
    expect(pobFormatSpec(undefined)).toBeUndefined();
  });

  it("leaves an already-signed spec alone", () => {
    expect(signedSpec("+%d%%")).toBe("+%d%%");
    expect(signedSpec("%+d")).toBe("%+d");
  });

  it("defaults when there is no spec", () => {
    expect(signedSpec(undefined)).toBe("%+.2f");
  });
});

describe("formatDelta", () => {
  it("returns null when the host sent no delta", () => {
    expect(formatDelta({ key: "Life", value: 4812, format: "%d" })).toBeNull();
  });

  it("signs the delta and computes the percentage against the baseline", () => {
    const d = formatDelta({ key: "TotalDPS", value: 1_100_000, format: "%d", delta: 100_000 });
    expect(d).not.toBeNull();
    expect(d!.text).toBe("+100,000");
    expect(d!.direction).toBe("up");
    // baseline = value - delta = 1,000,000 → +10%
    expect(d!.percent).toBe("+10%");
  });

  it("handles a decrease", () => {
    const d = formatDelta({ key: "Life", value: 4500, format: "%d", delta: -500 });
    expect(d!.text).toBe("-500");
    expect(d!.direction).toBe("down");
    expect(d!.percent).toBe("-10%");
  });

  it("treats a negligible change as flat", () => {
    const d = formatDelta({ key: "Life", value: 4812, format: "%d", delta: 0 });
    expect(d!.direction).toBe("flat");
    expect(d!.text).toBe("—");
  });

  it("omits the percentage when the baseline is zero", () => {
    const d = formatDelta({ key: "BlockChance", value: 20, format: "%d%%", delta: 20 });
    expect(d!.text).toBe("+20%");
    expect(d!.percent).toBeNull();
  });

  it("ignores a non-finite delta", () => {
    expect(
      formatDelta({ key: "X", value: 1, format: "%d", delta: Number.NaN }),
    ).toBeNull();
  });
});

describe("deltaTone", () => {
  it("treats more as better by default", () => {
    expect(deltaTone("TotalDPS", "up")).toBe("good");
    expect(deltaTone("TotalDPS", "down")).toBe("bad");
  });

  it("inverts for costs, where less is the improvement", () => {
    expect(isLowerBetter("ManaCost")).toBe(true);
    expect(deltaTone("ManaCost", "down")).toBe("good");
    expect(deltaTone("ManaCost", "up")).toBe("bad");
  });

  it("passes flat through", () => {
    expect(deltaTone("Life", "flat")).toBe("flat");
  });
});
