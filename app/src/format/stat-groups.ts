/**
 * Turning PoB's flat `BuildDisplayStats` list into something readable.
 *
 * PoB emits one long column in engine order. That is the single biggest reason
 * its stat panel is hard to scan, so the ordering here is opinionated:
 *
 *   - a small set of headline numbers gets promoted out of the list entirely
 *   - everything else falls into named groups in a fixed, curated order
 *   - resistances fold their over-cap row into the main row
 *   - keys we do not recognise still appear, in "Other", rather than vanishing
 *
 * The last point matters: PoB adds display stats every league, and a planner
 * that silently drops them is worse than one that shows them unsorted.
 */

import type { DisplayStat } from "@schema/rpc";

export type GroupId =
  | "offence"
  | "pools"
  | "defence"
  | "resistances"
  | "attributes"
  | "misc";

export interface GroupDef {
  id: GroupId;
  title: string;
  /** Curated display order. Keys not listed still land here via `claims`. */
  order: string[];
  /** Fallback matcher for keys the curated list does not name. */
  claims?: (key: string) => boolean;
}

export const GROUPS: GroupDef[] = [
  {
    id: "offence",
    title: "Offence",
    order: [
      "FullDPS",
      "CombinedDPS",
      "TotalDPS",
      "WithDotDPS",
      "TotalDot",
      "SkillDPS",
      "AverageDamage",
      "AverageHit",
      "Speed",
      "HitSpeed",
      "CastSpeed",
      "AccuracyHitChance",
      "PreEffectiveCritChance",
      "CritChance",
      "CritMultiplier",
      "ImpaleDPS",
      "BleedDPS",
      "IgniteDPS",
      "PoisonDPS",
      "DecayDPS",
      "CullingDPS",
      "ReservationDPS",
    ],
    claims: (k) =>
      /(DPS|Damage|CritChance|CritMultiplier|HitChance|Speed|Multiplier)$/.test(k) &&
      !/Movement|Recovery|Regen/.test(k),
  },
  {
    id: "pools",
    title: "Life & Recovery",
    order: [
      "Life",
      "LifeUnreserved",
      "LifeUnreservedPercent",
      "LifeRegenRecovery",
      "LifeLeechGainRate",
      "LifeLeechGainPerHit",
      "EnergyShield",
      "EnergyShieldRegenRecovery",
      "EnergyShieldLeechGainRate",
      "Ward",
      "Mana",
      "ManaUnreserved",
      "ManaUnreservedPercent",
      "ManaRegenRecovery",
      "ManaLeechGainRate",
      "Rage",
    ],
    claims: (k) => /^(Life|EnergyShield|Mana|Ward|Rage)/.test(k),
  },
  {
    id: "defence",
    title: "Defence",
    order: [
      "TotalEHP",
      "EffectiveMovementSpeedMod",
      "Armour",
      "ArmourDefence",
      "Evasion",
      "MeleeEvadeChance",
      "ProjectileEvadeChance",
      "PhysicalDamageReduction",
      "BlockChance",
      "SpellBlockChance",
      "SpellSuppressionChance",
      "AttackDodgeChance",
      "SpellDodgeChance",
      "PhysicalMaximumHitTaken",
      "FireMaximumHitTaken",
      "ColdMaximumHitTaken",
      "LightningMaximumHitTaken",
      "ChaosMaximumHitTaken",
      "SecondMinimalMaximumHitTaken",
      "MainHandAccuracy",
    ],
    claims: (k) =>
      /(MaximumHitTaken|EvadeChance|BlockChance|DodgeChance|SuppressionChance|Mitigation|EHP)/.test(
        k,
      ) || /^(Armour|Evasion)/.test(k),
  },
  {
    id: "resistances",
    title: "Resistances",
    order: [
      "FireResist",
      "ColdResist",
      "LightningResist",
      "ChaosResist",
    ],
    claims: (k) => /Resist/.test(k),
  },
  {
    id: "attributes",
    title: "Attributes",
    order: ["Str", "Dex", "Int", "ReqStr", "ReqDex", "ReqInt"],
    claims: (k) => /^(Str|Dex|Int|Req)/.test(k),
  },
  {
    id: "misc",
    title: "Other",
    order: [
      "MovementSpeedMod",
      "ManaCost",
      "LifeCost",
      "ESCost",
      "RageCost",
      "SoulCost",
    ],
  },
];

export interface StatRow extends DisplayStat {
  /** Over-cap value folded in from the sibling `*OverCap` row, if any. */
  overCap?: number;
}

export interface StatGroup {
  id: GroupId;
  title: string;
  rows: StatRow[];
}

/** True for rows the panel should hide entirely: null and zero-value noise. */
export function isEmptyRow(stat: DisplayStat): boolean {
  if (stat.value === null || stat.value === undefined) return true;
  if (typeof stat.value === "string") return stat.value.trim() === "";
  // A zero delta on a zero value carries no information.
  return stat.value === 0 && (stat.delta === undefined || stat.delta === 0);
}

const RESIST_OVERCAP = /^(.*)ResistOverCap$/;

/**
 * Group and order stats for display.
 *
 * `hideEmpty` drops rows that are zero everywhere; PoB shows them and the
 * result is a wall of "0" that buries the numbers that matter. Resistances are
 * exempt: a 0% chaos res is information.
 */
export function groupStats(
  stats: DisplayStat[],
  opts: { hideEmpty?: boolean } = {},
): StatGroup[] {
  const { hideEmpty = true } = opts;

  const overCaps = new Map<string, number>();
  const rows: DisplayStat[] = [];

  for (const s of stats) {
    const m = RESIST_OVERCAP.exec(s.key);
    if (m && typeof s.value === "number") {
      overCaps.set(`${m[1]}Resist`, s.value);
      continue;
    }
    rows.push(s);
  }

  const buckets = new Map<GroupId, StatRow[]>();
  for (const g of GROUPS) buckets.set(g.id, []);

  for (const s of rows) {
    // Two passes on purpose: a key named explicitly in a group's curated order
    // beats another group's fuzzy claim. Without this, "ManaCost" is swallowed
    // by the pools group's /^Mana/ rule and shows up under Life & Recovery.
    const group =
      GROUPS.find((g) => g.order.includes(s.key)) ??
      GROUPS.find((g) => g.claims?.(s.key) ?? false);
    const id = group?.id ?? "misc";
    if (hideEmpty && id !== "resistances" && isEmptyRow(s)) continue;

    const row: StatRow = { ...s };
    const oc = overCaps.get(s.key);
    if (oc !== undefined && oc !== 0) row.overCap = oc;
    buckets.get(id)!.push(row);
  }

  return GROUPS.map((g) => {
    const list = buckets.get(g.id)!;
    const rank = new Map(g.order.map((k, i) => [k, i]));
    list.sort((a, b) => {
      const ra = rank.get(a.key);
      const rb = rank.get(b.key);
      if (ra !== undefined && rb !== undefined) return ra - rb;
      if (ra !== undefined) return -1;
      if (rb !== undefined) return 1;
      return a.label.localeCompare(b.label);
    });
    return { id: g.id, title: g.title, rows: list };
  }).filter((g) => g.rows.length > 0);
}

/**
 * The four numbers a user glances at. Each entry is the first key present with
 * a non-zero value, so a spell build and a DoT build both get a sensible
 * headline without any per-build configuration.
 */
const HERO_CANDIDATES: Array<{ label: string; keys: string[] }> = [
  { label: "Damage", keys: ["FullDPS", "CombinedDPS", "WithDotDPS", "TotalDPS", "TotalDot", "AverageDamage"] },
  { label: "Effective HP", keys: ["TotalEHP", "PhysicalMaximumHitTaken"] },
  { label: "Life", keys: ["LifeUnreserved", "Life"] },
  { label: "Energy Shield", keys: ["EnergyShield", "Ward", "ManaUnreserved"] },
];

export interface HeroStat {
  /** Our label ("Damage"), not PoB's — the tile says what it is generically. */
  caption: string;
  stat: DisplayStat;
}

export function heroStats(stats: DisplayStat[]): HeroStat[] {
  const byKey = new Map(stats.map((s) => [s.key, s]));
  const out: HeroStat[] = [];
  const used = new Set<string>();

  for (const c of HERO_CANDIDATES) {
    for (const key of c.keys) {
      const stat = byKey.get(key);
      if (!stat || used.has(key)) continue;
      if (stat.value === null || stat.value === 0) continue;
      out.push({ caption: c.label, stat });
      used.add(key);
      break;
    }
  }
  return out;
}

/** Case-insensitive substring match over label and key, for the filter box. */
export function filterStats(stats: DisplayStat[], query: string): DisplayStat[] {
  const q = query.trim().toLowerCase();
  if (!q) return stats;
  const terms = q.split(/\s+/);
  return stats.filter((s) => {
    const hay = `${s.label} ${s.key}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}
