/**
 * Fixture data for the mock engine host.
 *
 * The stat keys are the real ones PoB's `BuildDisplayStats` emits, so the
 * grouping and formatting logic is exercised against realistic input rather
 * than invented names. Values are plausible for a level 92 Trickster.
 */

import type { BuildSummary, DisplayStat, TreeGeometry } from "@schema/rpc";

export const MOCK_TREE_VERSION = "3_13";

// NOTE: `format` is PoB's own `fmt` — the printf conversion *without* the
// leading `%` (".1f", "d", ".0f%%"), which is what the engine passes through.
// These fixtures used to carry a `%` the real data never has, so the mock and
// the formatter agreed with each other and both disagreed with the engine.

export function mockSummary(over: Partial<BuildSummary> = {}): BuildSummary {
  return {
    name: "Trickster — Explosive Arrow",
    className: "Shadow",
    ascendClassName: "Trickster",
    level: 92,
    treeVersion: MOCK_TREE_VERSION,
    allocated: mockAllocated(),
    pointsUsed: 111,
    pointsTotal: 123,
    ascendancyPointsUsed: 8,
    activeSpec: "0",
    masterySelections: {},
    ...over,
  };
}

/** A deterministic pseudo-allocation; ids are in PoB's real range. */
export function mockAllocated(count = 111, seed = 1337): number[] {
  const out: number[] = [];
  let s = seed;
  for (let i = 0; i < count; i++) {
    s = (s * 1103515245 + 12345) % 2147483648;
    out.push(100 + (s % 64000));
  }
  return [...new Set(out)];
}

/** Baseline stat rows. `scale` shifts every numeric value, for compare demos. */
export function mockStats(scale = 1): DisplayStat[] {
  const n = (v: number, digits = 0) =>
    Number((v * scale).toFixed(digits));

  const rows: DisplayStat[] = [
    // --- offence
    { key: "AverageHit", label: "Average Hit", value: n(48213.4, 1), format: ".1f" },
    { key: "AverageDamage", label: "Average Damage", value: n(48213.4, 1), format: ".1f" },
    { key: "Speed", label: "Attack Rate", value: n(4.31, 2), format: ".2f" },
    { key: "PreEffectiveCritChance", label: "Crit Chance", value: n(38.4, 2), format: ".2f%%" },
    { key: "CritMultiplier", label: "Crit Multiplier", value: n(3.45, 2), format: ".2fx" },
    { key: "AccuracyHitChance", label: "Hit Chance", value: n(100, 0), format: "d%%" },
    { key: "TotalDPS", label: "Total DPS", value: n(1_284_310), format: "d" },
    { key: "WithDotDPS", label: "Total DPS inc. DoT", value: n(1_402_770), format: "d" },
    { key: "IgniteDPS", label: "Ignite DPS", value: n(118_460), format: "d" },
    { key: "FullDPS", label: "Full DPS", value: n(1_402_770), format: "d", colour: "gold" },
    { key: "SkillDPS", label: "Skill DPS", value: n(1_284_310), format: "d" },

    // --- pools & recovery
    { key: "Life", label: "Total Life", value: n(4_812), format: "d" },
    { key: "LifeUnreserved", label: "Unreserved Life", value: n(3_140), format: "d" },
    { key: "LifeUnreservedPercent", label: "Unreserved Life", value: n(65.2, 1), format: ".1f%%" },
    { key: "LifeRegenRecovery", label: "Life Regen", value: n(412.7, 1), format: ".1f" },
    { key: "LifeLeechGainRate", label: "Life Leech/On Hit Rate", value: n(1_204.5, 1), format: ".1f" },
    { key: "EnergyShield", label: "Energy Shield", value: n(2_218), format: "d" },
    { key: "EnergyShieldRegenRecovery", label: "Energy Shield Regen", value: n(84.2, 1), format: ".1f" },
    { key: "Mana", label: "Total Mana", value: n(1_420), format: "d" },
    { key: "ManaUnreserved", label: "Unreserved Mana", value: n(212), format: "d" },

    // --- defence
    { key: "Armour", label: "Armour", value: n(12_840), format: "d" },
    { key: "Evasion", label: "Evasion", value: n(21_405), format: "d" },
    { key: "MeleeEvadeChance", label: "Evade Chance", value: n(74, 0), format: "d%%" },
    { key: "PhysicalDamageReduction", label: "Phys. Damage Reduction", value: n(41, 0), format: "d%%" },
    { key: "BlockChance", label: "Block Chance", value: n(0, 0), format: "d%%" },
    { key: "SpellSuppressionChance", label: "Spell Suppression", value: n(100, 0), format: "d%%" },
    { key: "AttackDodgeChance", label: "Attack Dodge", value: n(0, 0), format: "d%%" },
    { key: "TotalEHP", label: "Effective Hit Pool", value: n(48_120), format: "d", colour: "gold" },
    { key: "PhysicalMaximumHitTaken", label: "Phys. Max Hit Taken", value: n(11_240), format: "d" },
    { key: "FireMaximumHitTaken", label: "Fire Max Hit Taken", value: n(14_802), format: "d" },
    { key: "ColdMaximumHitTaken", label: "Cold Max Hit Taken", value: n(14_310), format: "d" },
    { key: "LightningMaximumHitTaken", label: "Lightning Max Hit Taken", value: n(13_980), format: "d" },
    { key: "ChaosMaximumHitTaken", label: "Chaos Max Hit Taken", value: n(9_210), format: "d" },

    // --- resistances
    { key: "FireResist", label: "Fire Resistance", value: 76, format: "d%%" },
    { key: "FireResistOverCap", label: "Fire Res. Over Cap", value: 31, format: "d%%" },
    { key: "ColdResist", label: "Cold Resistance", value: 76, format: "d%%" },
    { key: "ColdResistOverCap", label: "Cold Res. Over Cap", value: 12, format: "d%%" },
    { key: "LightningResist", label: "Lightning Resistance", value: 76, format: "d%%" },
    { key: "LightningResistOverCap", label: "Lightning Res. Over Cap", value: 4, format: "d%%" },
    { key: "ChaosResist", label: "Chaos Resistance", value: -24, format: "d%%" },

    // --- attributes
    { key: "Str", label: "Strength", value: n(155), format: "d" },
    { key: "Dex", label: "Dexterity", value: n(342), format: "d" },
    { key: "Int", label: "Intelligence", value: n(288), format: "d" },

    // --- misc
    { key: "MovementSpeedMod", label: "Movement Speed", value: n(34, 0), format: "+%d%%" },
    { key: "ManaCost", label: "Mana Cost", value: n(28), format: "d" },
    { key: "EffectiveMovementSpeedMod", label: "Effective Movement Speed", value: n(34, 0), format: "+%d%%" },
  ];
  return rows;
}

/**
 * A tiny geometry payload. Real geometry is ~2237 nodes; the mock only needs
 * enough shape for the renderer stub and for the node-name lookups the power
 * panel does.
 */
export function mockGeometry(): TreeGeometry {
  const nodes: TreeGeometry["nodes"] = [];
  const names = [
    "Amplify", "Heart of Thunder", "Fangs of the Viper", "Written in Blood",
    "Constitution", "Acrobatics", "Point Blank", "Vaal Pact", "Blood Drinker",
    "Growth and Decay", "Ballistic Mastery", "Hunter's Gambit",
  ];
  for (let i = 0; i < 120; i++) {
    const angle = (i / 120) * Math.PI * 2;
    const r = 1200 + (i % 7) * 340;
    nodes.push({
      id: 100 + i * 37,
      name: names[i % names.length] ?? `Node ${i}`,
      type: i % 11 === 0 ? "notable" : i % 29 === 0 ? "keystone" : "normal",
      // No art: the mock host exists to exercise layout and stat formatting,
      // and inventing sprite rects that resolve to no sheet would draw nothing
      // anyway. `icon`/`frame` replaced the old flat `sprite` field.
      icon: {},
      frame: {},
      linked: [],
      stats: ["10% increased Damage", "+10 to Dexterity"],
      radius: i % 11 === 0 ? 45 : 30,
      x: Math.cos(angle) * r,
      y: Math.sin(angle) * r,
    });
  }
  return {
    version: MOCK_TREE_VERSION,
    size: 11500,
    nodes,
    connectors: [],
    groups: [],
    sprites: {},
    sheets: {},
    extraImages: [],
    classes: [],
    ascendancies: [],
  };
}
