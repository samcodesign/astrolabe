import { beforeEach, describe, expect, it } from "vitest";

import {
  __resetSpecIds,
  addSpec,
  createSpec,
  deleteSpec,
  diffAllocation,
  duplicateSpec,
  emptySpecState,
  getActive,
  getCompare,
  isNoopDiff,
  parsePlan,
  PlanParseError,
  renameSpec,
  serialisePlan,
  setActive,
  setCompare,
  uniqueTitle,
  updateAllocation,
  type SpecState,
} from "./specs";

const spec = (title: string, allocated: number[] = []) =>
  createSpec({ title, treeVersion: "3_13", allocated });

function threeSpecs(): SpecState {
  let s = emptySpecState();
  s = addSpec(s, spec("A", [1, 2, 3]));
  s = addSpec(s, spec("B", [1, 2, 4]));
  s = addSpec(s, spec("C", [9]));
  return s;
}

beforeEach(() => __resetSpecIds());

describe("diffAllocation", () => {
  it("reports what to add and what to remove", () => {
    expect(diffAllocation([1, 2, 3], [2, 3, 4])).toEqual({ add: [4], remove: [1] });
  });

  it("is empty for identical sets regardless of order", () => {
    const d = diffAllocation([3, 1, 2], [2, 1, 3]);
    expect(isNoopDiff(d)).toBe(true);
  });

  it("handles going to and from an empty tree", () => {
    expect(diffAllocation([], [1, 2])).toEqual({ add: [1, 2], remove: [] });
    expect(diffAllocation([1, 2], [])).toEqual({ add: [], remove: [1, 2] });
  });

  it("ignores duplicates in the input", () => {
    expect(diffAllocation([1, 1, 2], [2, 2, 3])).toEqual({ add: [3], remove: [1] });
  });
});

describe("uniqueTitle", () => {
  it("leaves a free name alone", () => {
    expect(uniqueTitle(["A"], "B")).toBe("B");
  });

  it("appends a counter on collision", () => {
    expect(uniqueTitle(["Tree"], "Tree")).toBe("Tree 2");
    expect(uniqueTitle(["Tree", "Tree 2"], "Tree")).toBe("Tree 3");
  });
});

describe("spec CRUD", () => {
  it("makes the first added spec active", () => {
    const s = addSpec(emptySpecState(), spec("A"));
    expect(getActive(s)?.title).toBe("A");
  });

  it("does not steal focus when adding a later spec", () => {
    const s = threeSpecs();
    expect(getActive(s)?.title).toBe("A");
  });

  it("de-duplicates titles on add", () => {
    let s = addSpec(emptySpecState(), spec("Tree"));
    s = addSpec(s, spec("Tree"));
    expect(s.specs.map((x) => x.title)).toEqual(["Tree", "Tree 2"]);
  });

  it("duplicates a spec next to its source and selects the copy", () => {
    const s = threeSpecs();
    const b = s.specs[1]!;
    const next = duplicateSpec(s, b.id);
    expect(next.specs.map((x) => x.title)).toEqual(["A", "B", "B copy", "C"]);
    expect(next.activeId).toBe(next.specs[2]!.id);
    expect(next.specs[2]!.allocated).toEqual([1, 2, 4]);
  });

  it("gives the duplicate its own allocation array", () => {
    const s = threeSpecs();
    const next = duplicateSpec(s, s.specs[0]!.id);
    next.specs[1]!.allocated.push(99);
    expect(next.specs[0]!.allocated).toEqual([1, 2, 3]);
  });

  it("moves the selection to a neighbour when the active spec is deleted", () => {
    let s = threeSpecs();
    s = setActive(s, s.specs[1]!.id);
    const next = deleteSpec(s, s.specs[1]!.id);
    expect(next.specs.map((x) => x.title)).toEqual(["A", "C"]);
    expect(getActive(next)?.title).toBe("C");
  });

  it("refuses to delete the last variant", () => {
    const s = addSpec(emptySpecState(), spec("Only"));
    expect(deleteSpec(s, s.specs[0]!.id)).toBe(s);
  });

  it("clears the compare selection when that spec is deleted", () => {
    let s = threeSpecs();
    s = setCompare(s, s.specs[2]!.id);
    const next = deleteSpec(s, s.specs[2]!.id);
    expect(next.compareId).toBeNull();
  });

  it("renames, keeping titles unique", () => {
    const s = threeSpecs();
    const next = renameSpec(s, s.specs[1]!.id, "A");
    expect(next.specs[1]!.title).toBe("A 2");
  });

  it("ignores an empty rename", () => {
    const s = threeSpecs();
    expect(renameSpec(s, s.specs[0]!.id, "   ")).toBe(s);
  });

  it("refuses to compare a spec with itself", () => {
    const s = threeSpecs();
    expect(setCompare(s, s.activeId!)).toBe(s);
  });

  it("drops the comparison when the compared spec becomes active", () => {
    let s = threeSpecs();
    s = setCompare(s, s.specs[1]!.id);
    s = setActive(s, s.specs[1]!.id);
    expect(s.compareId).toBeNull();
    expect(getCompare(s)).toBeNull();
  });

  it("ignores selection of an unknown id", () => {
    const s = threeSpecs();
    expect(setActive(s, "nope")).toBe(s);
    expect(setCompare(s, "nope")).toBe(s);
  });

  it("updates an allocation without touching the others", () => {
    const s = threeSpecs();
    const next = updateAllocation(s, s.specs[0]!.id, [7, 8], 2);
    expect(next.specs[0]!.allocated).toEqual([7, 8]);
    expect(next.specs[0]!.pointsUsed).toBe(2);
    expect(next.specs[1]!.allocated).toEqual([1, 2, 4]);
  });
});

describe("plan serialisation", () => {
  it("round-trips", () => {
    let s = threeSpecs();
    s = setCompare(s, s.specs[1]!.id);
    const text = serialisePlan("<PathOfBuilding/>", s, { name: "Test", level: 92 });
    const plan = parsePlan(text);

    expect(plan.buildXml).toBe("<PathOfBuilding/>");
    expect(plan.specs.map((x) => x.title)).toEqual(["A", "B", "C"]);
    expect(plan.specs[0]!.allocated).toEqual([1, 2, 3]);
    expect(plan.activeId).toBe(s.activeId);
    expect(plan.compareId).toBe(s.compareId);
    expect(plan.meta?.level).toBe(92);
  });

  it("rejects a file that is not JSON", () => {
    expect(() => parsePlan("<PathOfBuilding/>")).toThrow(PlanParseError);
  });

  it("rejects JSON that is not a plan, and says where to go instead", () => {
    expect(() => parsePlan('{"hello":"world"}')).toThrow(/not a saved plan/);
  });

  it("rejects a plan from a future format version", () => {
    const text = JSON.stringify({
      format: "poe-planner",
      version: 99,
      buildXml: "<x/>",
      specs: [],
    });
    expect(() => parsePlan(text)).toThrow(/newer version/);
  });

  it("rejects a plan with no build data", () => {
    const text = JSON.stringify({ format: "poe-planner", version: 1, specs: [] });
    expect(() => parsePlan(text)).toThrow(/no build data/);
  });

  it("tolerates a plan with no specs", () => {
    const text = JSON.stringify({
      format: "poe-planner",
      version: 1,
      buildXml: "<x/>",
    });
    const plan = parsePlan(text);
    expect(plan.specs).toEqual([]);
    expect(plan.activeId).toBeNull();
  });

  it("repairs missing fields on a hand-edited spec", () => {
    const text = JSON.stringify({
      format: "poe-planner",
      version: 1,
      buildXml: "<x/>",
      specs: [{ id: "s1" }],
    });
    const plan = parsePlan(text);
    expect(plan.specs[0]).toMatchObject({
      id: "s1",
      title: "Tree",
      treeVersion: "unknown",
      allocated: [],
    });
  });
});
