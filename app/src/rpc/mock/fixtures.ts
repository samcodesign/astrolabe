/**
 * Fixture data for the mock engine host.
 *
 * The stat keys are the real ones PoB's `BuildDisplayStats` emits, so the
 * grouping and formatting logic is exercised against realistic input rather
 * than invented names. Values are plausible for a level 92 Trickster.
 */

import type {
  BuildSummary,
  ConfigSection,
  ConfigState,
  CustomModBlock,
  CustomModLine,
  DisplayStat,
  GemCatalogueEntry,
  GemInstance,
  Item,
  ItemsState,
  MainSkillSelection,
  ModCandidate,
  SkillsState,
  StatDelta,
  TreeGeometry,
} from "@schema/rpc";

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

/**
 * A main-skill selection with every optional control represented somewhere, so
 * the sidebar can be worked on in a browser without the sidecar.
 *
 * Group 1 is a multi-part skill with stages (Explosive Arrow's two parts),
 * group 3 is a minion skill, and group 4 is an aura group with a single skill
 * and no extras — which is the case that must render as *fewer controls*, not
 * as empty ones.
 */
export function mockMainSkill(): MainSkillSelection {
  return {
    groups: [
      { index: 1, label: "Explosive Arrow" },
      { index: 2, label: "Frenzy, Culling Strike" },
      { index: 3, label: "Summon Skitterbots" },
      { index: 4, label: "Grace, Determination" },
    ],
    groupIndex: 1,
    empty: false,
    skill: {
      options: [
        { index: 1, label: "Explosive Arrow" },
        { index: 2, label: "Blink Arrow" },
      ],
      index: 1,
      enabled: true,
    },
    part: {
      options: [
        { index: 1, label: "Explosion" },
        { index: 2, label: "Ignite" },
      ],
      index: 1,
    },
    stageCount: 5,
  };
}

/**
 * The mock's answer to `build.setMainSkill`.
 *
 * Only group changes reshape the selection, because that is the case the UI has
 * to get right: switching from a multi-part skill to a single-part one has to
 * *remove* the part selector, and a component that assumes the controls are
 * stable will render a stale one against the new skill.
 */
export function applyMainSkill(
  current: MainSkillSelection,
  params: Record<string, unknown>,
): MainSkillSelection {
  const group = params["group"] as number | undefined;
  if (group != null && group !== current.groupIndex) {
    const shapes: Record<number, Partial<MainSkillSelection>> = {
      1: {
        skill: {
          options: [
            { index: 1, label: "Explosive Arrow" },
            { index: 2, label: "Blink Arrow" },
          ],
          index: 1,
          enabled: true,
        },
        part: {
          options: [
            { index: 1, label: "Explosion" },
            { index: 2, label: "Ignite" },
          ],
          index: 1,
        },
        stageCount: 5,
      },
      2: {
        skill: { options: [{ index: 1, label: "Frenzy" }], index: 1, enabled: false },
      },
      3: {
        skill: { options: [{ index: 1, label: "Summon Skitterbots" }], index: 1, enabled: false },
        minion: {
          kind: "minion",
          options: [
            { id: "SkitterbotChill", label: "Chilling Skitterbot" },
            { id: "SkitterbotShock", label: "Shocking Skitterbot" },
          ],
          id: "SkitterbotChill",
          enabled: true,
        },
      },
      4: {
        skill: {
          options: [
            { index: 1, label: "Grace" },
            { index: 2, label: "Determination" },
          ],
          index: 1,
          enabled: true,
        },
      },
    };
    return { groups: current.groups, groupIndex: group, empty: false, ...shapes[group] };
  }

  const next: MainSkillSelection = { ...current };
  const skill = params["skill"] as number | undefined;
  if (skill != null && next.skill) next.skill = { ...next.skill, index: skill };
  const part = params["part"] as number | undefined;
  if (part != null && next.part) next.part = { ...next.part, index: part };
  if (params["stageCount"] != null) next.stageCount = params["stageCount"] as number;
  if (params["mineCount"] != null) next.mineCount = params["mineCount"] as number;
  if (params["minion"] != null && next.minion) {
    next.minion = { ...next.minion, id: params["minion"] as string | number };
  }
  if (params["minionSkill"] != null && next.minionSkill) {
    next.minionSkill = { ...next.minionSkill, index: params["minionSkill"] as number };
  }
  return next;
}

/**
 * A handful of gems, enough to exercise the picker and every row state:
 * a resolved active skill, a support, a disabled gem, and one that failed to
 * resolve (which must keep its text and show why rather than vanishing).
 */
export function mockGemCatalogue(): GemCatalogueEntry[] {
  return [
    { id: "g/Fireball", name: "Fireball", support: false, exceptional: false, legacy: false, colour: "B", tags: "Projectile, Spell, AoE, Fire", maxLevel: 20 },
    { id: "g/Firestorm", name: "Firestorm", support: false, exceptional: false, legacy: false, colour: "B", tags: "Spell, AoE, Fire", maxLevel: 20 },
    { id: "g/IceNova", name: "Ice Nova", support: false, exceptional: false, legacy: false, colour: "B", tags: "Spell, AoE, Cold", maxLevel: 20 },
    { id: "g/Frenzy", name: "Frenzy", support: false, exceptional: false, legacy: false, colour: "G", tags: "Attack, Projectile, Bow", maxLevel: 20 },
    { id: "g/Grace", name: "Grace", support: false, exceptional: false, legacy: false, colour: "G", tags: "Aura, Spell", maxLevel: 20 },
    { id: "g/AddedLightning", name: "Added Lightning Damage", support: true, exceptional: false, legacy: false, colour: "B", tags: "Lightning, Support", maxLevel: 20 },
    { id: "g/Spell Echo", name: "Spell Echo", support: true, exceptional: false, legacy: false, colour: "B", tags: "Spell, Support", maxLevel: 20 },
    { id: "g/Controlled Destruction", name: "Controlled Destruction", support: true, exceptional: false, legacy: false, colour: "B", tags: "Spell, Support", maxLevel: 20 },
    { id: "g/Elemental Focus", name: "Elemental Focus", support: true, exceptional: false, legacy: false, colour: "B", tags: "Support", maxLevel: 20 },
    { id: "g/Culling Strike", name: "Culling Strike", support: true, exceptional: false, legacy: false, colour: "G", tags: "Support", maxLevel: 20 },
  ];
}

export function mockSkills(): SkillsState {
  const gem = (
    index: number,
    name: string,
    support: boolean,
    colour: "R" | "G" | "B",
    over: Partial<GemInstance> = {},
  ): GemInstance => ({
    index,
    nameSpec: name,
    gemId: `g/${name.replace(/\s+/g, "")}`,
    level: 20,
    quality: 20,
    enabled: true,
    enableGlobal1: true,
    enableGlobal2: true,
    count: 1,
    support,
    name,
    maxLevel: 20,
    tags: support ? "Support" : "Spell",
    colour,
    reqLevel: 70,
    ...over,
  });

  return {
    groups: [
      {
        index: 1,
        label: "",
        displayLabel: "Fireball",
        slot: "Body Armour",
        enabled: true,
        slotEnabled: true,
        includeInFullDPS: true,
        count: 1,
        mainActiveSkill: 1,
        fromItem: false,
        gems: [
          gem(1, "Fireball", false, "B", {
            matchesSocket: true,
            showCount: true,
            reqStr: 0,
            reqDex: 0,
            reqInt: 155,
            // A Vaal gem's two independently-toggleable halves.
            globalEffects: [
              { index: 1, name: "Fireball" },
              { index: 2, name: "Vaal Fireball" },
            ],
            enableGlobal2: false,
          }),
          gem(2, "Spell Echo", true, "B", { matchesSocket: true }),
          gem(3, "Controlled Destruction", true, "B", { matchesSocket: false }),
          gem(4, "Elemental Focus", true, "B", { enabled: false }),
        ],
      },
      {
        // Five gems in a four-socket helmet. The engine raises no warning for
        // this — the extra gem simply does not apply — so the panel's
        // over-socketed marker is the only way to notice, and without a group
        // like this in the fixtures that branch can never be exercised.
        index: 2,
        label: "",
        displayLabel: "Ice Nova",
        slot: "Helmet",
        enabled: true,
        slotEnabled: true,
        includeInFullDPS: false,
        count: 1,
        mainActiveSkill: 1,
        fromItem: false,
        gems: [
          gem(1, "Ice Nova", false, "B", { matchesSocket: true, showCount: true }),
          gem(2, "Spell Echo", true, "B", { matchesSocket: true }),
          gem(3, "Controlled Destruction", true, "B", { matchesSocket: true }),
          gem(4, "Elemental Focus", true, "B", { matchesSocket: true }),
          gem(5, "Added Lightning Damage", true, "B", { matchesSocket: true }),
        ],
      },
      {
        index: 3,
        label: "Auras",
        displayLabel: "Auras",
        // Socketed in the swapped weapon: enabled, but contributing nothing.
        // The case a UI most easily renders as fully live.
        slot: "Weapon 2 Swap",
        enabled: true,
        slotEnabled: false,
        includeInFullDPS: false,
        count: 1,
        mainActiveSkill: 1,
        fromItem: false,
        gems: [gem(1, "Grace", false, "G")],
      },
      {
        index: 4,
        label: "",
        displayLabel: "Granted by Item",
        enabled: true,
        slotEnabled: true,
        includeInFullDPS: false,
        count: 1,
        mainActiveSkill: 1,
        fromItem: true,
        gems: [
          {
            index: 1,
            nameSpec: "Wintertide Brand",
            level: 20,
            quality: 0,
            enabled: true,
            enableGlobal1: true,
            enableGlobal2: true,
            count: 1,
            support: false,
            name: "Wintertide Brand",
          },
          // Unresolved: keeps what was typed and says why.
          {
            index: 2,
            nameSpec: "Definitely Not A Gem",
            level: 1,
            quality: 0,
            enabled: true,
            enableGlobal1: true,
            enableGlobal2: true,
            count: 1,
            support: false,
            error: "Definitely Not A Gem is not a valid gem name",
          },
        ],
      },
    ],
    // Must match the engine's list (`api/skills.lua` SLOTS), or a group whose
    // slot is missing here renders as unslotted.
    slots: [
      "Weapon 1", "Weapon 2", "Weapon 1 Swap", "Weapon 2 Swap",
      "Helmet", "Body Armour", "Gloves", "Boots",
      "Amulet", "Ring 1", "Ring 2", "Ring 3", "Belt",
    ],
    sets: [{ id: 1, title: "Default" }],
    activeSet: 1,
    mainGroup: 1,
  };
}

/**
 * The mock's answer to the six skills mutations.
 *
 * Renumbering after an insert or delete is the behaviour worth reproducing:
 * `index` is 1-based and dense, and a UI that keys off it must see it move.
 */
export function applySkillEdit(
  state: SkillsState,
  method: string,
  params: Record<string, unknown>,
): { skills: SkillsState; addedGroup?: number } {
  const groups = state.groups.map((g) => ({ ...g, gems: g.gems.map((x) => ({ ...x })) }));
  const gi = (params["group"] as number) - 1;
  const renumber = (s: SkillsState): SkillsState => ({
    ...s,
    groups: s.groups.map((g, i) => ({
      ...g,
      index: i + 1,
      gems: g.gems.map((x, j) => ({ ...x, index: j + 1 })),
    })),
  });

  switch (method) {
    // Keyed by slot in the engine, and it needs *two* fields to agree there.
    // The mock only has to reproduce the observable half — the name on the
    // group — but it must reproduce that, or the control appears to do nothing.
    case "skills.setImbuedSupport": {
      const group = groups[gi];
      if (group) {
        const gemId = params["gemId"];
        const gem = mockGemCatalogue().find((g) => g.id === gemId);
        if (gem) group.imbuedSupport = gem.name;
        else delete group.imbuedSupport;
      }
      return { skills: { ...state, groups } };
    }

    case "skills.addGroup": {
      groups.push({
        index: groups.length + 1,
        label: (params["label"] as string) ?? "",
        displayLabel: "<No active skills>",
        enabled: true,
        slotEnabled: true,
        includeInFullDPS: false,
        count: 1,
        mainActiveSkill: 1,
        fromItem: false,
        gems: [],
        ...(params["slot"] ? { slot: params["slot"] as string } : {}),
      });
      return { skills: renumber({ ...state, groups }), addedGroup: groups.length };
    }
    case "skills.setGroup": {
      const g = groups[gi];
      if (g) {
        if (params["label"] !== undefined) g.label = params["label"] as string;
        if (params["slot"] !== undefined) {
          if (params["slot"] === false) delete g.slot;
          else g.slot = params["slot"] as string;
        }
        if (params["enabled"] !== undefined) g.enabled = params["enabled"] as boolean;
        if (params["includeInFullDPS"] !== undefined) {
          g.includeInFullDPS = params["includeInFullDPS"] as boolean;
        }
        if (params["count"] !== undefined) g.count = params["count"] as number;
      }
      return { skills: renumber({ ...state, groups }) };
    }
    case "skills.deleteGroup":
      groups.splice(gi, 1);
      return { skills: renumber({ ...state, groups }) };

    case "skills.setGem": {
      const g = groups[gi];
      if (g) {
        const idx = (params["gem"] as number) - 1;
        const existing = g.gems[idx];
        const gemId = params["gemId"] as string | undefined;
        const cat = gemId ? mockGemCatalogue().find((c) => c.id === gemId) : undefined;
        if (!existing && cat) {
          g.gems.push({
            index: idx + 1,
            nameSpec: cat.name,
            gemId: cat.id,
            level: cat.maxLevel ?? 20,
            quality: 0,
            enabled: true,
            enableGlobal1: true,
            enableGlobal2: true,
            count: 1,
            support: cat.support,
            name: cat.name,
            maxLevel: cat.maxLevel ?? 20,
            tags: cat.tags,
            ...(cat.colour ? { colour: cat.colour } : {}),
          });
        } else if (existing) {
          if (cat) {
            existing.gemId = cat.id;
            existing.name = cat.name;
            existing.nameSpec = cat.name;
            existing.support = cat.support;
            existing.tags = cat.tags;
            if (cat.colour) existing.colour = cat.colour;
            delete existing.error;
          }
          for (const k of ["level", "quality", "count"] as const) {
            if (params[k] !== undefined) existing[k] = params[k] as number;
          }
          for (const k of ["enabled", "enableGlobal1", "enableGlobal2"] as const) {
            if (params[k] !== undefined) existing[k] = params[k] as boolean;
          }
        }
      }
      return { skills: renumber({ ...state, groups }) };
    }
    case "skills.deleteGem": {
      const g = groups[gi];
      if (g) g.gems.splice((params["gem"] as number) - 1, 1);
      return { skills: renumber({ ...state, groups }) };
    }
    case "skills.reorderGem": {
      const g = groups[gi];
      if (g) {
        const from = (params["gem"] as number) - 1;
        const to = (params["to"] as number) - 1;
        const [moved] = g.gems.splice(from, 1);
        if (moved) g.gems.splice(to, 0, moved);
      }
      return { skills: renumber({ ...state, groups }) };
    }
    default:
      return { skills: state };
  }
}

/**
 * A slice of PoB's config catalogue, with one option of every type so the
 * generic renderer is exercised without the sidecar.
 *
 * `hideoutStats` is deliberately absent from `shown` below: an option the
 * engine says does not apply is the case the panel most easily gets wrong.
 */
export function mockConfigSchema(): ConfigSection[] {
  return [
    {
      name: "General",
      options: [
        {
          var: "resistancePenalty",
          type: "list",
          label: "Resistance penalty:",
          list: [
            { value: 0, label: "None" },
            { value: -30, label: "Act 5 (-30%)" },
            { value: -60, label: "Act 10 (-60%)" },
          ],
          default: -60,
        },
        {
          var: "bandit",
          type: "list",
          label: "Bandit quest:",
          list: [
            { value: "None", label: "Kill all" },
            { value: "Oak", label: "Help Oak" },
            { value: "Kraityn", label: "Help Kraityn" },
            { value: "Alira", label: "Help Alira" },
          ],
          default: "None",
        },
        {
          var: "pantheonMajorGod",
          type: "list",
          label: "Major God:",
          list: [
            { value: "None", label: "Nothing" },
            { value: "TheBrineKing", label: "Soul of the Brine King" },
            { value: "Lunaris", label: "Soul of Lunaris" },
            { value: "Solaris", label: "Soul of Solaris" },
            { value: "Arakaali", label: "Soul of Arakaali" },
          ],
          default: "None",
        },
        {
          var: "pantheonMinorGod",
          type: "list",
          label: "Minor God:",
          list: [
            { value: "None", label: "Nothing" },
            { value: "Gruthkul", label: "Soul of Gruthkul" },
            { value: "Yugul", label: "Soul of Yugul" },
            { value: "Abberath", label: "Soul of Abberath" },
          ],
          default: "None",
        },
        {
          var: "hideoutStats",
          type: "check",
          label: "In hideout",
          tooltip: "Only applies to builds that care where they are standing.",
        },
      ],
    },
    {
      name: "When In Combat",
      options: [
        { var: "conditionStationary", type: "count", label: "Time spent stationary", min: 0 },
        { var: "usePowerCharges", type: "check", label: "Do you have Power Charges?" },
        { var: "multiplierRage", type: "count", label: "# of Rage", min: 0 },
      ],
    },
    {
      name: "Enemy Stats",
      options: [
        { var: "enemyLevel", type: "integer", label: "Enemy Level:" },
        { var: "enemyIsBoss", type: "check", label: "Is the enemy a Boss?" },
        {
          var: "enemyPhysicalReduction",
          type: "float",
          label: "Enemy Physical Damage Reduction:",
          step: "any",
        },
      ],
    },
  ];
}

export function mockConfigState(): ConfigState {
  return {
    values: { resistancePenalty: -60, bandit: "None", enemyLevel: 84 },
    // `conditionStationary` is deliberately left unset with a placeholder, so
    // the "shows a hint, not a zero" path has something to exercise.
    placeholders: { conditionStationary: 4, enemyPhysicalReduction: 0 },
    // `multiplierRage` is set but no longer applicable — the stale-config case.
    invalid: { multiplierRage: true },
    modified: { bandit: true, multiplierRage: true },
    // Everything except `hideoutStats`, so the "found by search but not
    // applicable" path has something to find.
    shown: {
      resistancePenalty: true,
      bandit: true,
      pantheonMajorGod: true,
      pantheonMinorGod: true,
      conditionStationary: true,
      usePowerCharges: true,
      multiplierRage: true,
      enemyLevel: true,
      enemyIsBoss: true,
      enemyPhysicalReduction: true,
    },
    sets: [{ id: 1, title: "Default" }],
    activeSet: 1,
  };
}

/**
 * The mock's answer to the four config-set mutations.
 *
 * Each set holds its own `values`, so switching must swap them wholesale —
 * that is the behaviour a UI most easily gets wrong by keeping one values map
 * and only relabelling.
 */
const mockSetValues = new Map<number, ConfigState["values"]>();

export function applyConfigSetEdit(
  state: ConfigState,
  method: string,
  params: Record<string, unknown>,
): { config: ConfigState; createdSet?: number } {
  mockSetValues.set(state.activeSet, state.values);

  switch (method) {
    case "config.newSet": {
      const id = Math.max(0, ...state.sets.map((s) => s.id)) + 1;
      const from = params["copyFrom"] as number | undefined;
      const values = from != null ? { ...(mockSetValues.get(from) ?? {}) } : {};
      mockSetValues.set(id, values);
      const title =
        (params["title"] as string | undefined) ??
        `${state.sets.find((s) => s.id === from)?.title ?? "Default"} copy`;
      return {
        config: { ...state, sets: [...state.sets, { id, title }], activeSet: id, values },
        createdSet: id,
      };
    }
    case "config.activateSet": {
      const id = params["id"] as number;
      return { config: { ...state, activeSet: id, values: { ...(mockSetValues.get(id) ?? {}) } } };
    }
    case "config.renameSet": {
      const id = params["id"] as number;
      return {
        config: {
          ...state,
          sets: state.sets.map((s) =>
            s.id === id ? { ...s, title: params["title"] as string } : s,
          ),
        },
      };
    }
    case "config.deleteSet": {
      const id = params["id"] as number;
      const sets = state.sets.filter((s) => s.id !== id);
      mockSetValues.delete(id);
      const active = state.activeSet === id ? (sets[0]?.id ?? 1) : state.activeSet;
      return {
        config: { ...state, sets, activeSet: active, values: { ...(mockSetValues.get(active) ?? {}) } },
      };
    }
    default:
      return { config: state };
  }
}

/**
 * The mock's answer to the four skill-set mutations.
 *
 * Mirrors the engine's contract, including the bit that matters: switching
 * clamps `mainGroup` into the new set's range and restores the group the set
 * was last on, rather than leaving a dangling index.
 */
const mockSetGroups = new Map<number, SkillsState["groups"]>();
const mockSetMain = new Map<number, number>();

export function applySkillSetEdit(
  state: SkillsState,
  method: string,
  params: Record<string, unknown>,
): { skills: SkillsState; createdSet?: number } {
  mockSetGroups.set(state.activeSet, state.groups);
  mockSetMain.set(state.activeSet, state.mainGroup);

  const renumber = (groups: SkillsState["groups"]) =>
    groups.map((g, i) => ({ ...g, index: i + 1 }));
  const enter = (id: number, groups: SkillsState["groups"]): SkillsState => ({
    ...state,
    groups: renumber(groups),
    activeSet: id,
    mainGroup: Math.max(1, Math.min(mockSetMain.get(id) ?? 1, Math.max(groups.length, 1))),
  });

  switch (method) {
    case "skills.newSet": {
      const id = Math.max(0, ...state.sets.map((s) => s.id)) + 1;
      const from = params["copyFrom"] as number | undefined;
      // Deep enough that editing the copy cannot reach the original.
      const groups =
        from != null
          ? (mockSetGroups.get(from) ?? []).map((g) => ({
              ...g,
              gems: g.gems.map((x) => ({ ...x })),
            }))
          : [];
      mockSetGroups.set(id, groups);
      const title =
        (params["title"] as string | undefined) ??
        `${state.sets.find((s) => s.id === from)?.title ?? "Default"} copy`;
      return {
        skills: { ...enter(id, groups), sets: [...state.sets, { id, title }] },
        createdSet: id,
      };
    }
    case "skills.activateSet": {
      const id = params["id"] as number;
      return { skills: enter(id, mockSetGroups.get(id) ?? []) };
    }
    case "skills.renameSet": {
      const id = params["id"] as number;
      return {
        skills: {
          ...state,
          sets: state.sets.map((s) =>
            s.id === id ? { ...s, title: params["title"] as string } : s,
          ),
        },
      };
    }
    case "skills.deleteSet": {
      const id = params["id"] as number;
      const sets = state.sets.filter((s) => s.id !== id);
      mockSetGroups.delete(id);
      mockSetMain.delete(id);
      if (state.activeSet !== id) return { skills: { ...state, sets } };
      const next = sets[0]?.id ?? 1;
      return { skills: { ...enter(next, mockSetGroups.get(next) ?? []), sets } };
    }
    default:
      return { skills: state };
  }
}

/**
 * Custom mod blocks, with a deliberately bad line so the error list has
 * something to show.
 */
export function mockCustomMods(): CustomModBlock[] {
  return [
    {
      index: 1,
      title: "Default",
      enabled: true,
      text: "+100 to Strength\nnot a real modifier",
      lines: [
        { line: 1, text: "+100 to Strength", ok: true },
        { line: 2, text: "not a real modifier", ok: false, reason: "unrecognised" },
      ],
    },
  ];
}

/**
 * A crude stand-in for `modLib.parseMod`: anything starting with `+`/`-`/a
 * digit is accepted. Enough to exercise the UI's good/bad split without
 * pretending to be the real parser.
 */
export function mockValidateMods(text: string): CustomModLine[] {
  const out: CustomModLine[] = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const ok = /^[+-]?\d/.test(line) || /increased|reduced|more|less/i.test(line);
    out.push({ line: i + 1, text: raw, ok, ...(ok ? {} : { reason: "unrecognised" as const }) });
  });
  return out;
}

export function applyCustomModEdit(
  blocks: CustomModBlock[],
  method: string,
  params: Record<string, unknown>,
): { blocks: CustomModBlock[]; addedBlock?: number } {
  const next = blocks.map((b) => ({ ...b }));
  const at = (params["index"] as number) - 1;

  switch (method) {
    case "config.addCustomMod":
      next.push({
        index: next.length + 1,
        title: (params["title"] as string) ?? `Group ${next.length + 1}`,
        enabled: true,
        text: (params["text"] as string) ?? "",
        lines: [],
      });
      return { blocks: next, addedBlock: next.length };
    case "config.setCustomMod": {
      const b = next[at];
      if (b) {
        if (params["title"] !== undefined) b.title = params["title"] as string;
        if (params["enabled"] !== undefined) b.enabled = params["enabled"] as boolean;
        if (params["text"] !== undefined) {
          b.text = params["text"] as string;
          b.lines = mockValidateMods(b.text);
        }
      }
      return { blocks: next };
    }
    case "config.deleteCustomMod": {
      next.splice(at, 1);
      // PoB always keeps one to type into.
      if (next.length === 0) {
        next.push({ index: 1, title: "Default", enabled: true, text: "", lines: [] });
      }
      return { blocks: next.map((b, i) => ({ ...b, index: i + 1 })) };
    }
    default:
      return { blocks };
  }
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

/**
 * PoB's own colour for a stat row, from `BuildDisplayStats.lua`.
 *
 * These are hex strings because that is what the engine sends: `api/stats.lua`
 * parses PoB's `^xRRGGBB` escapes before they reach the client. The mock used
 * to invent `colour: "gold"`, and `StatPanel` was written to match the mock
 * rather than the engine — so the two agreed with each other, both disagreed
 * with reality, and all 77 real colours were dropped on the floor.
 */
const STAT_COLOUR: Record<string, string> = {
  FullDPS: "#aa9e82", // CURRENCY
  Life: "#e05030",
  LifeUnreserved: "#e05030",
  LifeUnreservedPercent: "#e05030",
  LifeRegenRecovery: "#e05030",
  LifeLeechGainRate: "#e05030",
  Mana: "#7070ff",
  ManaUnreserved: "#7070ff",
  ManaCost: "#7070ff",
  EnergyShield: "#88ffff",
  EnergyShieldRegenRecovery: "#88ffff",
  Evasion: "#33ff77", // EVASION = POSITIVE
  Armour: "#c8c8c8", // ARMOUR = NORMAL
  FireResist: "#b97123",
  ColdResist: "#3f6db3",
  LightningResist: "#adaa47",
  ChaosResist: "#d02090",
  PhysicalMaximumHitTaken: "#c8c8c8",
  FireMaximumHitTaken: "#b97123",
  ColdMaximumHitTaken: "#3f6db3",
  LightningMaximumHitTaken: "#adaa47",
  ChaosMaximumHitTaken: "#d02090",
  Str: "#e05030",
  Dex: "#70ff70",
  Int: "#7070ff",
};

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
    { key: "FullDPS", label: "Full DPS", value: n(1_402_770), format: "d" },
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
    { key: "TotalEHP", label: "Effective Hit Pool", value: n(48_120), format: "d" },
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
  // Applied here rather than repeated on 25 rows, and applied *after* the list
  // so a row can never carry a colour the table disagrees with.
  for (const row of rows) {
    const colour = STAT_COLOUR[row.key];
    if (colour) row.colour = colour;
  }
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

/**
 * A plausible answer to "what would this change do?".
 *
 * Derived from the baseline stat rows rather than invented, so the labels and
 * formats match what the panel shows and the deltas stay in a believable ratio
 * to the values they move. `seed` makes each distinct change produce a distinct
 * but stable answer — hovering the same gem twice must not shuffle the numbers.
 */
export function mockStatDeltas(seed: number, count = 6): StatDelta[] {
  // Stats where down is better; the sign of the delta alone cannot say.
  const lowerIsBetter = new Set(["ManaCost", "LifeCost", "EnergyShieldCost"]);
  const pick = mockStats().filter((s) => typeof s.value === "number" && s.value !== 0);
  const rows: StatDelta[] = [];

  for (let i = 0; i < Math.min(count, pick.length); i++) {
    const s = pick[(seed * 7 + i * 13) % pick.length];
    if (!s || rows.some((r) => r.key === s.key)) continue;
    // A deterministic fraction in roughly ±12%.
    const swing = (((seed * 31 + i * 17) % 25) - 12) / 100;
    if (swing === 0) continue;
    const delta = Number(((s.value as number) * swing).toFixed(2));
    rows.push({
      key: s.key,
      label: s.label,
      delta,
      format: s.format,
      better: lowerIsBetter.has(s.key) ? delta < 0 : delta > 0,
      percent: Number((swing * 100).toFixed(1)),
    });
  }
  return rows;
}

/**
 * Gear.
 *
 * Shaped from a real `items.list` against the sample character, then extended
 * to cover two paths that character does not exercise at all: a modifier with
 * a roll range, and a unique with variant axes. A mock that only covers what
 * one build happens to have is how untested branches reach the UI.
 *
 * Note `group` is zero-based, and `label` is *not* unique — "Weapon 1" and
 * "Weapon 1 Swap" share it, so `weaponSet` is what tells them apart.
 */
export function mockItems(): ItemsState {
  const items: Item[] = [
    {
      id: 1,
      name: "Chimeric Guardian, Vaal Regalia",
      title: "Chimeric Guardian",
      baseName: "Vaal Regalia",
      rarity: "RARE",
      type: "Body Armour",
      itemLevel: 86,
      quality: 20,
      corrupted: false,
      mirrored: false,
      requires: { level: 68, int: 194 },
      defences: { energyShield: 950 },
      sockets: [
        { index: 1, colour: "G", group: 0 },
        { index: 2, colour: "G", group: 0 },
        { index: 3, colour: "B", group: 0 },
        { index: 4, colour: "B", group: 0 },
        { index: 5, colour: "B", group: 0 },
        { index: 6, colour: "B", group: 0 },
      ],
      mods: {
        implicit: [{ index: 1, line: "+16% to Chaos Resistance" }],
        explicit: [
          { index: 1, line: "+93 to maximum Energy Shield", fractured: true },
          { index: 2, line: "+42 to Intelligence" },
          // The roll-range path: a slider the UI has to render and commit.
          {
            index: 3,
            line: "(10-15)% increased Energy Shield",
            range: 0.5,
            rangeMin: 10,
            rangeMax: 15,
          },
          { index: 4, line: "+35% to Fire Resistance", crafted: true },
        ],
      },
    },
    {
      id: 2,
      name: "Indigon, Hubris Circlet",
      title: "Indigon",
      baseName: "Hubris Circlet",
      rarity: "UNIQUE",
      type: "Helmet",
      itemLevel: 84,
      quality: 20,
      corrupted: false,
      mirrored: false,
      requires: { level: 69, int: 154 },
      defences: { energyShield: 294 },
      influences: ["Shaper", "Elder"],
      sockets: [
        { index: 1, colour: "R", group: 0 },
        { index: 2, colour: "B", group: 0 },
        { index: 3, colour: "B", group: 1 },
        { index: 4, colour: "B", group: 1 },
      ],
      mods: {
        explicit: [
          {
            index: 1,
            line: "(20-30)% increased Maximum Mana",
            range: 0.4,
            rangeMin: 20,
            rangeMax: 30,
          },
          { index: 2, line: "Recently Spent Mana increases Spell Damage" },
        ],
      },
    },
    {
      id: 3,
      name: "Watcher's Eye, Prismatic Jewel",
      title: "Watcher's Eye",
      baseName: "Prismatic Jewel",
      rarity: "UNIQUE",
      type: "Jewel",
      subType: "Abyss",
      itemLevel: 80,
      corrupted: false,
      mirrored: false,
      // Several independent choices at once — one selector per axis, which is
      // the whole reason `axes` is a list rather than a single field.
      variants: {
        options: [
          { index: 1, name: "Clarity: Mana Regen" },
          { index: 2, name: "Discipline: Energy Shield" },
          { index: 3, name: "Precision: Critical Strike" },
        ],
        axes: [
          { key: "variant", selected: 2 },
          { key: "variantAlt", selected: 3 },
        ],
      },
      mods: {
        explicit: [
          {
            index: 1,
            line: "(4-6)% increased maximum Energy Shield while affected by Discipline",
            range: 0.5,
            rangeMin: 4,
            rangeMax: 6,
          },
        ],
      },
    },
    {
      id: 4,
      name: "Cinderswallow Urn, Silver Flask",
      title: "Cinderswallow Urn",
      baseName: "Silver Flask",
      rarity: "UNIQUE",
      type: "Flask",
      subType: "Utility",
      itemLevel: 85,
      quality: 20,
      corrupted: false,
      mirrored: false,
      requires: { level: 48 },
      mods: {
        buff: [{ index: 1, line: "Onslaught" }],
        explicit: [
          { index: 1, line: "+17 to Maximum Charges" },
          {
            index: 2,
            line: "Recharges 5 Charges when you Consume an Ignited corpse",
            unparsed: "Recharges 5 Charges when you Consume an Ignited corpse",
          },
        ],
      },
    },
    {
      // A cluster jewel, so the destructive-delete path is reachable. Deleting
      // one deallocates every passive it granted — a tree edit made from the
      // items tab — and that confirmation cannot be tested without one here.
      id: 6,
      name: "Large Cluster Jewel",
      baseName: "Large Cluster Jewel",
      rarity: "MAGIC",
      type: "Jewel",
      itemLevel: 84,
      corrupted: false,
      mirrored: false,
      mods: {
        enchant: [{ index: 1, line: "Adds 8 Passive Skills" }],
        explicit: [{ index: 1, line: "Added Small Passive Skills grant: +8 to Strength" }],
      },
    },
    {
      id: 5,
      name: "Seven-League Step",
      title: "Seven-League Step",
      baseName: "Rawhide Boots",
      rarity: "UNIQUE",
      type: "Boots",
      itemLevel: 30,
      corrupted: true,
      mirrored: false,
      defences: { evasion: 26 },
      mods: { explicit: [{ index: 1, line: "50% increased Movement Speed" }] },
    },
  ];

  return {
    slots: [
      { name: "Weapon 1", label: "Weapon 1", weaponSet: 1, shown: true },
      { name: "Weapon 2", label: "Weapon 2", weaponSet: 1, shown: true },
      { name: "Weapon 1 Swap", label: "Weapon 1", weaponSet: 2, shown: true },
      { name: "Weapon 2 Swap", label: "Weapon 2", weaponSet: 2, shown: true },
      // Hidden because its parent item has no abyssal socket. The panel must
      // filter on `shown` rather than render an empty row.
      { name: "Weapon 1 Abyssal Socket 1", label: "Abyssal #1", weaponSet: 1, shown: false },
      { name: "Helmet", label: "Helmet", itemId: 2, shown: true },
      { name: "Body Armour", label: "Body Armour", itemId: 1, shown: true },
      { name: "Gloves", label: "Gloves", shown: true },
      { name: "Boots", label: "Boots", itemId: 5, shown: true },
      { name: "Amulet", label: "Amulet", shown: true },
      { name: "Ring 1", label: "Ring 1", shown: true },
      { name: "Ring 2", label: "Ring 2", shown: true },
      { name: "Belt", label: "Belt", shown: true },
      { name: "Flask 1", label: "Flask 1", itemId: 4, shown: true },
      { name: "Flask 2", label: "Flask 2", shown: true },
      // A real build has dozens of these — one per allocated socket node. The
      // sample character has 57, so the panel cannot list them flat.
      { name: "Jewel 2311", label: "Socket", nodeId: 2311, itemId: 3, shown: true },
      { name: "Jewel 6230", label: "Socket", nodeId: 6230, itemId: 6, shown: true },
    ],
    items,
    sets: [{ id: 1, title: "Set 1", useSecondWeaponSet: false }],
    activeSet: 1,
    useSecondWeaponSet: false,
  };
}

/** The slot family a base name belongs to, by its last word. */
function baseType(baseName: string): string | undefined {
  const last = baseName.trim().split(/\s+/).pop()?.toLowerCase() ?? "";
  const byWord: Record<string, string> = {
    ring: "Ring",
    amulet: "Amulet",
    belt: "Belt",
    sash: "Belt",
    boots: "Boots",
    greaves: "Boots",
    gloves: "Gloves",
    gauntlets: "Gloves",
    mitts: "Gloves",
    helmet: "Helmet",
    circlet: "Helmet",
    helm: "Helmet",
    mask: "Helmet",
    flask: "Flask",
    jewel: "Jewel",
    wand: "Weapon 1",
    dagger: "Weapon 1",
    sceptre: "Weapon 1",
    bow: "Weapon 1",
    staff: "Weapon 1",
    shield: "Weapon 2",
    quiver: "Weapon 2",
  };
  return byWord[last];
}

/** Apply an items mutation to the mock's state, following the engine's rules. */
export function applyItemEdit(
  state: ItemsState,
  method: string,
  params: Record<string, unknown>,
): ItemsState & { createdSet?: number } {
  const next: ItemsState = {
    ...state,
    slots: state.slots.map((s) => ({ ...s })),
    items: [...state.items],
    sets: state.sets.map((s) => ({ ...s })),
  };

  switch (method) {
    case "items.paste": {
      const id = Math.max(0, ...next.items.map((i) => i.id)) + 1;
      const lines = String(params["text"] ?? "")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      const title = lines[1] ?? "Pasted Item";
      const baseName = lines[2] ?? "Unknown Base";
      next.items.push({
        id,
        name: title,
        title,
        baseName,
        // The engine takes `type` from the resolved base. The mock cannot look
        // a base up, so it reads the name — but it has to produce the field
        // either way: without it a pasted item fits no slot, and the paste
        // looks like it worked while being useless.
        type: baseType(baseName),
        rarity: (lines[0]?.replace(/^Rarity:\s*/i, "") as Item["rarity"]) || "NORMAL",
        corrupted: false,
        mirrored: false,
        mods: { explicit: lines.slice(3).map((line, i) => ({ index: i + 1, line })) },
      });
      break;
    }
    case "items.equip": {
      const slot = next.slots.find((s) => s.name === params["slot"]);
      if (slot) {
        const item = params["item"];
        if (item === false || item == null) delete slot.itemId;
        else slot.itemId = item as number;
      }
      break;
    }
    case "items.delete": {
      const id = params["item"] as number;
      next.items = next.items.filter((i) => i.id !== id);
      // As the engine does: the item leaves every slot, not just the pool.
      for (const slot of next.slots) if (slot.itemId === id) delete slot.itemId;
      break;
    }
    case "items.setModRange": {
      const item = next.items.find((i) => i.id === params["item"]);
      const list = item?.mods?.[params["list"] as keyof NonNullable<Item["mods"]>];
      const mod = list?.find((m) => m.index === params["index"]);
      if (mod) mod.range = Math.max(0, Math.min(1, params["range"] as number));
      break;
    }
    case "items.setVariant": {
      const item = next.items.find((i) => i.id === params["item"]);
      const axis = item?.variants?.axes.find((a) => a.key === (params["key"] ?? "variant"));
      if (axis) axis.selected = params["index"] as number;
      break;
    }
    case "items.newSet": {
      const id = Math.max(0, ...next.sets.map((s) => s.id)) + 1;
      next.sets.push({
        id,
        title: (params["title"] as string) || `Set ${id}`,
        useSecondWeaponSet: false,
      });
      return { ...next, createdSet: id };
    }
    case "items.activateSet":
      next.activeSet = params["id"] as number;
      break;
    case "items.renameSet": {
      const set = next.sets.find((s) => s.id === params["id"]);
      if (set) set.title = params["title"] as string;
      break;
    }
    case "items.deleteSet": {
      const id = params["id"] as number;
      next.sets = next.sets.filter((s) => s.id !== id);
      if (next.activeSet === id) next.activeSet = next.sets[0]?.id ?? 1;
      break;
    }
    case "items.setWeaponSwap":
      next.useSecondWeaponSet = params["enabled"] as boolean;
      break;
    case "items.addMod": {
      const item = next.items.find((i) => i.id === params["item"]);
      if (item) {
        const explicit = [...(item.mods?.explicit ?? [])];
        const line =
          params["source"] === "CUSTOM"
            ? String(params["text"])
            : (mockModPool(item, params["source"] as string).find(
                (m) => m.index === params["index"],
              )?.lines[0] ?? "");
        explicit.push({
          index: explicit.length + 1,
          line,
          ...(params["source"] === "MASTER" ? { crafted: true } : {}),
        });
        item.mods = { ...item.mods, explicit };
      }
      break;
    }
    case "items.removeMod": {
      const item = next.items.find((i) => i.id === params["item"]);
      const key = params["list"] as keyof NonNullable<Item["mods"]>;
      if (item?.mods?.[key]) {
        const kept = item.mods[key]!.filter((m) => m.index !== params["index"]);
        item.mods = { ...item.mods, [key]: kept.map((m, i) => ({ ...m, index: i + 1 })) };
      }
      break;
    }
    case "items.optimiseSockets": {
      // A crude stand-in: one socket per gem in the slot's groups, all in one
      // link group. The real rule (colour per gem's attribute, abyssal sockets
      // preserved and unlinked, capped at the base's socketLimit) lives in the
      // engine — this only has to be enough to see the layout change.
      const slot = next.slots.find((s) => s.name === params["slot"]);
      const worn = next.items.find((i) => i.id === slot?.itemId);
      if (worn?.sockets) {
        worn.sockets = worn.sockets.map((s, i) => ({ ...s, group: 0, index: i + 1 }));
      }
      break;
    }
  }
  return next;
}

/**
 * Crafting sources for an item, following the engine's own conditions
 * (`ItemsTab.lua:3557-3589`): a jewel has no bench, a flask has neither
 * essences nor delve, only body-armour pieces take necropolis mods.
 */
export function mockModSources(item: Item): Array<{ id: string; label: string }> {
  const out: Array<{ id: string; label: string }> = [];
  const t = item.type ?? "";
  if (t !== "Tincture" && t !== "Graft") {
    if (t !== "Jewel") out.push({ id: "MASTER", label: "Crafting Bench" });
    if (t !== "Jewel" && t !== "Flask") {
      out.push({ id: "ESSENCE", label: "Essence" });
      out.push({ id: "VEILED", label: "Veiled" });
    }
    if (["Helmet", "Body Armour", "Gloves", "Boots"].includes(t)) {
      out.push({ id: "NECROPOLIS", label: "Necropolis" });
    }
    if (t !== "Flask") out.push({ id: "DELVE", label: "Delve" });
    out.push({ id: "PREFIX", label: "Prefix" });
    out.push({ id: "SUFFIX", label: "Suffix" });
  }
  out.push({ id: "CUSTOM", label: "Custom" });
  return out;
}

/**
 * A small stand-in pool.
 *
 * The real thing filters thousands of mods through `GetModSpawnWeight` against
 * the item's own tags; this only has to be enough to exercise the picker, the
 * search and the supported/unsupported split. It deliberately includes two
 * unsupported entries, because that distinction is the whole point of the
 * browser and a pool where everything works would never show it.
 */
export function mockModPool(item: Item, source: string, search?: string): ModCandidate[] {
  if (source === "CUSTOM") return [];

  // The engine filters every candidate through `GetModSpawnWeight` against the
  // item's own tags. This cannot do that, but it must not be *laxer* than the
  // engine either — a mock that offers a mod the sidecar would refuse lets a
  // client ship a picker that only fails against the real thing. So each entry
  // declares which item types can take it, the same shape the real filter has.
  type Row = {
    line: string;
    affix: string;
    supported: boolean;
    affixType: "Prefix" | "Suffix";
    /** Undefined means "anything that has affixes at all". */
    types?: string[];
  };
  const base: Row[] = [
    { line: "+(17-22) to maximum Energy Shield", affix: "Shielding", supported: true, affixType: "Prefix",
      types: ["Helmet", "Body Armour", "Gloves", "Boots", "Shield"] },
    { line: "(11-28)% increased Energy Shield", affix: "Protective", supported: true, affixType: "Prefix",
      types: ["Helmet", "Body Armour", "Gloves", "Boots", "Shield"] },
    { line: "+(15-25) to maximum Life", affix: "Healthy", supported: true, affixType: "Prefix" },
    { line: "+(20-30) to Intelligence", affix: "of the Sage", supported: true, affixType: "Suffix" },
    { line: "+(20-35)% to Fire Resistance", affix: "of the Salamander", supported: true, affixType: "Suffix" },
    // Real mods PoB parses but does not model — the reason `supported` exists.
    { line: "Reflects (5-10) Physical Damage to Melee Attackers", affix: "Spiny", supported: false, affixType: "Prefix",
      types: ["Body Armour", "Shield"] },
    { line: "(5-8)% chance to gain a Frenzy Charge when Hit", affix: "of the Underground", supported: false, affixType: "Suffix" },
  ];
  const applicable = base.filter((r) => !r.types || r.types.includes(item.type ?? ""));

  const kind: ModCandidate["kind"] = source === "MASTER" ? "crafted" : "custom";
  const rows = applicable.map((r, i) => ({
    index: i + 1,
    lines: [r.line],
    label: source === "MASTER" ? r.line : `${r.affix} — ${r.line}`,
    supported: r.supported,
    kind,
    affixType: r.affixType,
  }));

  const filtered =
    source === "PREFIX"
      ? rows.filter((r) => r.affixType === "Prefix")
      : source === "SUFFIX"
        ? rows.filter((r) => r.affixType === "Suffix")
        : rows;

  const q = search?.trim().toLowerCase();
  const matched = q ? filtered.filter((r) => r.label.toLowerCase().includes(q)) : filtered;
  // Prefixes first, then the source's order — as the engine sorts.
  return matched
    .slice()
    .sort((a, b) =>
      a.affixType === b.affixType ? a.index - b.index : a.affixType === "Prefix" ? -1 : 1,
    )
    .map((r, i) => ({ ...r, index: i + 1 }));
}
