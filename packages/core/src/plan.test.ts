// Contract tests for plan.ts (ADR 105 §7, point 23): N-day plan, deterministic and without LLM, over the
// priority of `suggestedToday` (ADR 102 point 9).
import { describe, expect, it } from "vitest";
import { buildWeekPlan, type PlanConcept, type PlanExam, type PlanInput, type WeekPlan } from "./plan.ts";

const TODAY = "2026-11-10";

const concept = (conceptId: string, over: Partial<PlanConcept> = {}): PlanConcept => ({
  conceptId, subjectId: "S1", state: "weak", probability: 0.3, stale: false, dependents: 0, hasTemplate: false, hasCards: false, ...over,
});
const exam = (id: string, date: string, scopeConceptIds: string[] | null = null, subjectId = "S1"): PlanExam => ({ id, subjectId, date, scopeConceptIds });
const plan = (over: Partial<PlanInput> = {}): WeekPlan => buildWeekPlan({ today: TODAY, days: 7, itemsPerDay: 5, concepts: [], exams: [], ...over });

const placed = (p: WeekPlan): string[] => p.days.flatMap((d) => d.items.map((i) => i.conceptId));
const dayOf = (p: WeekPlan, id: string): number => p.days.findIndex((d) => d.items.some((i) => i.conceptId === id));
const itemOf = (p: WeekPlan, id: string) => p.days.flatMap((d) => d.items).find((i) => i.conceptId === id)!;

describe("buildWeekPlan: shape and validation", () => {
  it("always returns `days` entries with consecutive dates from today, also empty ones and crossing a month", () => {
    const p = plan({ today: "2026-11-29", days: 4 });
    expect(p.days.map((d) => d.date)).toEqual(["2026-11-29", "2026-11-30", "2026-12-01", "2026-12-02"]);
    expect(p.days.every((d) => d.items.length === 0)).toBe(true);
    expect(p.unscheduledConceptIds).toEqual([]);
  });

  it("days out of 1..14 throws RangeError; 1 and 14 are valid", () => {
    expect(() => plan({ days: 0 })).toThrow(RangeError);
    expect(() => plan({ days: 15 })).toThrow(RangeError);
    expect(() => plan({ days: -3 })).toThrow(RangeError);
    expect(plan({ days: 1 }).days).toHaveLength(1);
    expect(plan({ days: 14 }).days).toHaveLength(14);
  });
});

describe("buildWeekPlan: candidates", () => {
  it("a fresh solid one does not enter; unknown, review, weak and an expired solid one do", () => {
    const p = plan({
      concepts: [
        concept("fresh", { state: "solid", probability: 0.95 }),
        concept("expired", { state: "solid", probability: 0.6, stale: true }),
        concept("review", { state: "review", probability: 0.65 }),
        concept("weak", { state: "weak", probability: 0.3 }),
        concept("new", { state: "unknown", probability: null }),
      ],
    });
    expect([...placed(p), ...p.unscheduledConceptIds].sort()).toEqual(["expired", "new", "review", "weak"]);
  });

  it("each concept appears at most once even if several exams apply to it", () => {
    const concepts = ["a", "b", "c", "d", "e", "f"].map((id) => concept(id));
    const p = plan({ concepts, itemsPerDay: 2, exams: [exam("e1", "2026-11-13"), exam("e2", "2026-11-15", ["a", "b"]), exam("e3", "2026-11-12", ["a"])] });
    const all = [...placed(p), ...p.unscheduledConceptIds];
    expect(new Set(all).size).toBe(all.length);
    expect(all.sort()).toEqual(["a", "b", "c", "d", "e", "f"]);
  });
});

describe("buildWeekPlan: priority", () => {
  it("sorts by closeness × (1 − P') × (1 + dependents) and exposes it on each item", () => {
    // no exam: closeness 1/31. x: 0.5·4 = 2 · y: 1.0·1 = 1 · z: 0.4·1 = 0.4 (all /31)
    const p = plan({
      itemsPerDay: 1,
      concepts: [concept("z", { probability: 0.6 }), concept("y", { probability: 0 }), concept("x", { probability: 0.5, dependents: 3 })],
    });
    expect([dayOf(p, "x"), dayOf(p, "y"), dayOf(p, "z")]).toEqual([0, 1, 2]);
    expect(itemOf(p, "x").priority).toBeCloseTo(2 / 31, 12);
    expect(itemOf(p, "y").priority).toBeCloseTo(1 / 31, 12);
    expect(itemOf(p, "z").priority).toBeCloseTo(0.4 / 31, 12);
  });

  it("within a day, items go from highest to lowest priority", () => {
    const p = plan({ concepts: [concept("b", { probability: 0.8 }), concept("a", { probability: 0.1 }), concept("c", { probability: 0.5 })] });
    expect(p.days[0]!.items.map((i) => i.conceptId)).toEqual(["a", "c", "b"]);
  });

  it("null probability counts as 0.5", () => {
    const p = plan({
      itemsPerDay: 1,
      concepts: [concept("high", { probability: 0.4 }), concept("null", { state: "unknown", probability: null }), concept("low", { probability: 0.6 })],
    });
    expect([dayOf(p, "high"), dayOf(p, "null"), dayOf(p, "low")]).toEqual([0, 1, 2]);
    expect(itemOf(p, "null").priority).toBeCloseTo(0.5 / 31, 12);
  });

  it("tie-break by ascending conceptId, whatever the input order", () => {
    const ids = ["c", "a", "b"];
    const p1 = plan({ concepts: ids.map((id) => concept(id)) });
    const p2 = plan({ concepts: [...ids].reverse().map((id) => concept(id)) });
    expect(p1.days[0]!.items.map((i) => i.conceptId)).toEqual(["a", "b", "c"]);
    expect(p2).toEqual(p1);
  });

  it("same input → same output, and does not mutate the input", () => {
    const input: PlanInput = {
      today: TODAY, days: 5, itemsPerDay: 2,
      concepts: [concept("a", { dependents: 2 }), concept("b", { state: "unknown", probability: null }), concept("c", { state: "solid", probability: 0.6, stale: true }), concept("d")],
      exams: [exam("e1", "2026-11-13", ["a", "d"]), exam("e2", "2026-11-20")],
    };
    const copy = structuredClone(input);
    const first = buildWeekPlan(input);
    expect(buildWeekPlan(input)).toEqual(first);
    expect(input).toEqual(copy);
  });
});

describe("buildWeekPlan: exams", () => {
  it("closeness uses the applicable exam: in 2 days → 1/3", () => {
    const p = plan({ concepts: [concept("a", { probability: 0.4 })], exams: [exam("e", "2026-11-12")] });
    expect(itemOf(p, "a").priority).toBeCloseTo(0.6 / 3, 12);
  });

  it("applies if the scope contains it, or if it is null and they share the subject; otherwise the concept counts as having no exam", () => {
    const concepts = [
      concept("in-scope", { subjectId: "S1", probability: 0.4 }),
      concept("out-of-scope", { subjectId: "S1", probability: 0.4 }),
      concept("other-subject", { subjectId: "S2", probability: 0.4 }),
      concept("no-subject", { subjectId: null, probability: 0.4 }),
    ];
    const withScope = plan({ concepts, exams: [exam("e", "2026-11-12", ["in-scope"])] });
    expect(itemOf(withScope, "in-scope").priority).toBeCloseTo(0.6 / 3, 12);
    for (const id of ["out-of-scope", "other-subject", "no-subject"]) expect(itemOf(withScope, id).priority, id).toBeCloseTo(0.6 / 31, 12);

    const bySubject = plan({ concepts, exams: [exam("e", "2026-11-12", null, "S1")] });
    expect(itemOf(bySubject, "in-scope").priority).toBeCloseTo(0.6 / 3, 12);
    expect(itemOf(bySubject, "out-of-scope").priority).toBeCloseTo(0.6 / 3, 12);
    for (const id of ["other-subject", "no-subject"]) expect(itemOf(bySubject, id).priority, id).toBeCloseTo(0.6 / 31, 12);
  });

  it("among several applicable exams the nearest wins; a nearby one that does not apply does not count", () => {
    const concepts = [concept("a", { probability: 0 })];
    const p = plan({
      concepts,
      exams: [exam("far", "2026-11-18"), exam("near", "2026-11-12"), exam("near-not-applicable", "2026-11-11", ["other"])],
    });
    expect(itemOf(p, "a").priority).toBeCloseTo(1 / 3, 12);
    const withoutNear = plan({ concepts, exams: [exam("far", "2026-11-18"), exam("near-not-applicable", "2026-11-11", ["other"])] });
    expect(itemOf(withoutNear, "a").priority).toBeCloseTo(1 / 9, 12);
  });

  it("deadline: goes to a day before the exam (exam in 3 days → days 0..2); the others, after", () => {
    const p = plan({
      itemsPerDay: 1,
      concepts: [concept("a"), concept("b"), concept("c"), concept("d")],
      exams: [exam("e", "2026-11-13", ["a", "b", "c"])],
    });
    expect([dayOf(p, "a"), dayOf(p, "b"), dayOf(p, "c")]).toEqual([0, 1, 2]);
    expect(dayOf(p, "d")).toBe(3);
    expect(p.unscheduledConceptIds).toEqual([]);
  });

  it("exam in 2 days → only days 0 and 1; what does not fit before goes to unscheduled even if there is room later", () => {
    const p = plan({ itemsPerDay: 1, concepts: [concept("a"), concept("b"), concept("c")], exams: [exam("e", "2026-11-12")] });
    expect([dayOf(p, "a"), dayOf(p, "b")]).toEqual([0, 1]);
    expect(dayOf(p, "c")).toBe(-1);
    expect(p.unscheduledConceptIds).toEqual(["c"]);
  });

  it.each([
    ["today", "2026-11-10"],
    ["tomorrow", "2026-11-11"],
  ])("exam %s → only today", (_n, date) => {
    const p = plan({ itemsPerDay: 2, concepts: [concept("a"), concept("b"), concept("c")], exams: [exam("e", date)] });
    expect(p.days[0]!.items.map((i) => i.conceptId)).toEqual(["a", "b"]);
    expect(p.days.slice(1).every((d) => d.items.length === 0)).toBe(true);
    expect(p.unscheduledConceptIds).toEqual(["c"]);
  });

  it("past exam: ignored (neither priority nor deadline)", () => {
    // "b" has yesterday's exam. If it counted, its closeness would be 1 and it would go ahead of "a" and have a deadline.
    const p = plan({
      itemsPerDay: 1,
      concepts: [concept("a", { probability: 0.3 }), concept("b", { probability: 0.3 })],
      exams: [exam("old", "2026-11-09", ["b"])],
    });
    expect(itemOf(p, "b").priority).toBeCloseTo(0.7 / 31, 12);
    expect([dayOf(p, "a"), dayOf(p, "b")]).toEqual([0, 1]);

    const late = plan({ itemsPerDay: 1, concepts: ["a", "b", "c", "d"].map((id) => concept(id)), exams: [exam("old", "2026-11-01")] });
    expect(dayOf(late, "d")).toBe(3);
    expect(late.unscheduledConceptIds).toEqual([]);
  });

  it("an exam beyond the horizon scores by closeness but does not limit the days", () => {
    const p = plan({ days: 3, itemsPerDay: 1, concepts: [concept("a", { probability: 0 }), concept("b"), concept("c")], exams: [exam("e", "2026-11-30")] });
    expect(itemOf(p, "a").priority).toBeCloseTo(1 / 21, 12);
    expect(placed(p).sort()).toEqual(["a", "b", "c"]);
    expect(p.unscheduledConceptIds).toEqual([]);
  });

  it("greedy placement by priority: one that does not fit its deadline does not displace one of higher priority", () => {
    // a: no exam, P' 0 → 1/31 ≈ 0.0323. b: exam tomorrow, P' 0.95 → 0.05/2 = 0.025 (lower). With 1 slot today, a takes it.
    const p = plan({
      itemsPerDay: 1,
      concepts: [concept("a", { probability: 0 }), concept("b", { probability: 0.95 })],
      exams: [exam("e", "2026-11-11", ["b"])],
    });
    expect(dayOf(p, "a")).toBe(0);
    expect(p.unscheduledConceptIds).toEqual(["b"]);
  });
});

describe("buildWeekPlan: capacity", () => {
  it("never more than itemsPerDay per day; fills the days in order", () => {
    const p = plan({ days: 3, itemsPerDay: 2, concepts: ["a", "b", "c", "d", "e"].map((id) => concept(id)) });
    expect(p.days.map((d) => d.items.length)).toEqual([2, 2, 1]);
    expect(p.unscheduledConceptIds).toEqual([]);
  });

  it("what does not fit in the horizon goes to unscheduledConceptIds (the lowest-priority ones)", () => {
    const p = plan({
      days: 2,
      itemsPerDay: 2,
      concepts: [concept("a", { probability: 0.1 }), concept("b", { probability: 0.2 }), concept("c", { probability: 0.3 }), concept("d", { probability: 0.4 }), concept("e", { probability: 0.5 })],
    });
    expect(placed(p)).toEqual(["a", "b", "c", "d"]);
    expect(p.unscheduledConceptIds).toEqual(["e"]);
  });
});

describe("buildWeekPlan: kind and why", () => {
  it("kind follows the suggestedToday rule: active template → exercises; otherwise cards → cards; otherwise session", () => {
    const p = plan({
      concepts: [
        concept("ambos", { hasTemplate: true, hasCards: true }),
        concept("template", { hasTemplate: true }),
        concept("cards", { hasCards: true }),
        concept("nothing"),
      ],
    });
    expect(itemOf(p, "ambos").kind).toBe("exercises");
    expect(itemOf(p, "template").kind).toBe("exercises");
    expect(itemOf(p, "cards").kind).toBe("cards");
    expect(itemOf(p, "nothing").kind).toBe("session");
  });

  it("why is a non-empty phrase and, with an exam, carries the number of days", () => {
    const p = plan({ concepts: [concept("a"), concept("b")], exams: [exam("e", "2026-11-13", ["a"])] });
    expect(itemOf(p, "a").why).toContain("3");
    expect(itemOf(p, "b").why.trim().length).toBeGreaterThan(0);
  });
});
