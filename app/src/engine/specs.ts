/**
 * Tree variants ("specs").
 *
 * IMPORTANT — schema gap. `schema/rpc.d.ts` exposes no spec CRUD: there is no
 * `spec.list`, no `spec.create`, no way to name the active tree. PoB itself
 * keeps a list of `<Spec>` elements inside the build XML, but this API surfaces
 * only *one* current allocation.
 *
 * So variants are modelled here, in the frontend, and applied to the engine by
 * diffing allocations through `tree.allocate` / `tree.deallocate`. That is
 * enough for everything the UI needs — including the compare column, since
 * `stats.get { compareTo }` already takes a raw node list.
 *
 * The costs of doing it this way, for the record:
 *   - a variant is not visible to PoB if the build is exported mid-session;
 *     `build.save` serialises whatever is currently allocated, i.e. the active
 *     variant only.
 *   - switching variants costs one round trip per direction (~78 ms each), not
 *     a single atomic call.
 *
 * Everything in this file is pure so it can be unit tested without a host.
 */

import type { NodeId } from "@schema/rpc";

export interface TreeSpec {
  id: string;
  title: string;
  treeVersion: string;
  allocated: NodeId[];
  /** Ascendancy points are tracked by the engine, kept here for display. */
  pointsUsed: number;
  createdAt: number;
}

export interface SpecState {
  specs: TreeSpec[];
  activeId: string | null;
  /** The variant shown in the compare column, or null for no comparison. */
  compareId: string | null;
}

export const emptySpecState = (): SpecState => ({
  specs: [],
  activeId: null,
  compareId: null,
});

let idCounter = 0;
export function newSpecId(): string {
  idCounter += 1;
  return `spec-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

/** Reset between tests so ids are deterministic. */
export function __resetSpecIds(): void {
  idCounter = 0;
}

export function createSpec(
  init: Partial<TreeSpec> & Pick<TreeSpec, "treeVersion">,
): TreeSpec {
  return {
    id: init.id ?? newSpecId(),
    title: init.title ?? "Tree",
    treeVersion: init.treeVersion,
    allocated: [...(init.allocated ?? [])],
    pointsUsed: init.pointsUsed ?? init.allocated?.length ?? 0,
    createdAt: init.createdAt ?? Date.now(),
  };
}

/** "Tree" → "Tree 2" → "Tree 3"; "Copy of X" for duplicates. */
export function uniqueTitle(existing: string[], desired: string): string {
  const taken = new Set(existing);
  if (!taken.has(desired)) return desired;
  const base = desired.replace(/ (\d+)$/, "");
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${desired} ${Date.now()}`;
}

export function addSpec(state: SpecState, spec: TreeSpec): SpecState {
  const title = uniqueTitle(
    state.specs.map((s) => s.title),
    spec.title,
  );
  const next = { ...spec, title };
  return {
    ...state,
    specs: [...state.specs, next],
    activeId: state.activeId ?? next.id,
  };
}

export function duplicateSpec(state: SpecState, id: string): SpecState {
  const source = state.specs.find((s) => s.id === id);
  if (!source) return state;
  const copy = createSpec({
    ...source,
    id: newSpecId(),
    title: uniqueTitle(
      state.specs.map((s) => s.title),
      `${source.title} copy`,
    ),
    createdAt: Date.now(),
  });
  const at = state.specs.findIndex((s) => s.id === id);
  const specs = [...state.specs];
  specs.splice(at + 1, 0, copy);
  return { ...state, specs, activeId: copy.id };
}

/**
 * Deleting the active variant moves the selection to its neighbour. The last
 * variant cannot be deleted — a build always has a tree.
 */
export function deleteSpec(state: SpecState, id: string): SpecState {
  if (state.specs.length <= 1) return state;
  const at = state.specs.findIndex((s) => s.id === id);
  if (at < 0) return state;
  const specs = state.specs.filter((s) => s.id !== id);
  const fallback = specs[Math.min(at, specs.length - 1)]!;
  return {
    specs,
    activeId: state.activeId === id ? fallback.id : state.activeId,
    compareId: state.compareId === id ? null : state.compareId,
  };
}

export function renameSpec(state: SpecState, id: string, title: string): SpecState {
  const trimmed = title.trim();
  if (!trimmed) return state;
  const others = state.specs.filter((s) => s.id !== id).map((s) => s.title);
  const unique = uniqueTitle(others, trimmed);
  return {
    ...state,
    specs: state.specs.map((s) => (s.id === id ? { ...s, title: unique } : s)),
  };
}

export function setActive(state: SpecState, id: string): SpecState {
  if (!state.specs.some((s) => s.id === id)) return state;
  return {
    ...state,
    activeId: id,
    // Comparing a variant with itself shows a column of zeroes; drop it.
    compareId: state.compareId === id ? null : state.compareId,
  };
}

export function setCompare(state: SpecState, id: string | null): SpecState {
  if (id === null) return { ...state, compareId: null };
  if (!state.specs.some((s) => s.id === id)) return state;
  if (id === state.activeId) return state;
  return { ...state, compareId: id };
}

export function updateAllocation(
  state: SpecState,
  id: string,
  allocated: NodeId[],
  pointsUsed: number,
): SpecState {
  return {
    ...state,
    specs: state.specs.map((s) =>
      s.id === id ? { ...s, allocated: [...allocated], pointsUsed } : s,
    ),
  };
}

export const getActive = (s: SpecState): TreeSpec | null =>
  s.specs.find((x) => x.id === s.activeId) ?? null;

export const getCompare = (s: SpecState): TreeSpec | null =>
  s.compareId ? (s.specs.find((x) => x.id === s.compareId) ?? null) : null;

// ---------------------------------------------------------------------------

export interface AllocationDiff {
  add: NodeId[];
  remove: NodeId[];
}

/**
 * What has to change on the engine to go from `current` to `target`.
 *
 * Order matters at the call site: deallocate first, then allocate. Doing it the
 * other way can transiently exceed the point budget, which PoB rejects.
 */
export function diffAllocation(current: NodeId[], target: NodeId[]): AllocationDiff {
  const cur = new Set(current);
  const tgt = new Set(target);
  const add: NodeId[] = [];
  const remove: NodeId[] = [];
  for (const n of tgt) if (!cur.has(n)) add.push(n);
  for (const n of cur) if (!tgt.has(n)) remove.push(n);
  return { add, remove };
}

/** True when no engine round trip is needed at all. */
export function isNoopDiff(d: AllocationDiff): boolean {
  return d.add.length === 0 && d.remove.length === 0;
}

// ---------------------------------------------------------------------------
// persistence

export const SAVE_FORMAT_VERSION = 1;

export interface SavedPlan {
  format: "poe-planner";
  version: number;
  savedAt: string;
  /** The build as PoB XML, from `build.save { as: "xml" }`. */
  buildXml: string;
  specs: TreeSpec[];
  activeId: string | null;
  compareId: string | null;
  meta?: { name?: string; className?: string; level?: number };
}

export function serialisePlan(
  buildXml: string,
  state: SpecState,
  meta?: SavedPlan["meta"],
): string {
  const plan: SavedPlan = {
    format: "poe-planner",
    version: SAVE_FORMAT_VERSION,
    savedAt: new Date().toISOString(),
    buildXml,
    specs: state.specs,
    activeId: state.activeId,
    compareId: state.compareId,
    meta,
  };
  return JSON.stringify(plan, null, 2);
}

export class PlanParseError extends Error {}

export function parsePlan(text: string): SavedPlan {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new PlanParseError("that file is not a saved plan (invalid JSON)");
  }
  if (typeof raw !== "object" || raw === null) {
    throw new PlanParseError("that file is not a saved plan");
  }
  const plan = raw as Partial<SavedPlan>;
  if (plan.format !== "poe-planner") {
    throw new PlanParseError(
      "that file is not a saved plan — open a .pob XML through Import instead",
    );
  }
  if (typeof plan.version !== "number" || plan.version > SAVE_FORMAT_VERSION) {
    throw new PlanParseError(
      `this plan was written by a newer version of the app (format ${String(plan.version)})`,
    );
  }
  if (typeof plan.buildXml !== "string" || !plan.buildXml) {
    throw new PlanParseError("the plan has no build data");
  }
  const specs = Array.isArray(plan.specs) ? plan.specs : [];
  return {
    format: "poe-planner",
    version: plan.version,
    savedAt: plan.savedAt ?? new Date(0).toISOString(),
    buildXml: plan.buildXml,
    specs: specs.map((s) =>
      createSpec({
        id: s.id,
        title: s.title ?? "Tree",
        treeVersion: s.treeVersion ?? "unknown",
        allocated: Array.isArray(s.allocated) ? s.allocated : [],
        pointsUsed: s.pointsUsed ?? 0,
        createdAt: s.createdAt,
      }),
    ),
    activeId: plan.activeId ?? specs[0]?.id ?? null,
    compareId: plan.compareId ?? null,
    meta: plan.meta,
  };
}
