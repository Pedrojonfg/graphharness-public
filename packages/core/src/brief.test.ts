// Contract tests for brief.ts (ADR 102 point 9).
import { describe, expect, it } from "vitest";
import { daysUntil, suggestedTodayPriority } from "./brief.ts";

describe("suggestedTodayPriority (ADR 102 point 9)", () => {
  it("closeness × (1 − P') × (1 + dependents): 4 days, P' 0.6, 2 dep → 1/5 · 0.4 · 3 = 0.24", () => {
    expect(suggestedTodayPriority({ daysToExam: 4, effectiveProbability: 0.6, dependentsInScope: 2 })).toBeCloseTo(0.24, 12);
  });

  it("no exam → closeness 1/31", () => {
    expect(suggestedTodayPriority({ daysToExam: null, effectiveProbability: 0.2, dependentsInScope: 0 })).toBeCloseTo(0.8 / 31, 12);
    expect(suggestedTodayPriority({ daysToExam: null, effectiveProbability: 0.2, dependentsInScope: 0 })).toBeCloseTo(
      suggestedTodayPriority({ daysToExam: 30, effectiveProbability: 0.2, dependentsInScope: 0 }),
      12,
    );
  });

  it("P' null → 0.5 is used", () => {
    expect(suggestedTodayPriority({ daysToExam: 0, effectiveProbability: null, dependentsInScope: 1 })).toBeCloseTo(1, 12);
  });

  it("past exam (negative days) → closeness 1, neither negative nor infinite", () => {
    expect(suggestedTodayPriority({ daysToExam: -3, effectiveProbability: 0.9, dependentsInScope: 0 })).toBeCloseTo(0.1, 12);
  });

  it("leaf concept (0 dependents) does not end up at 0", () => {
    expect(suggestedTodayPriority({ daysToExam: 9, effectiveProbability: 0.5, dependentsInScope: 0 })).toBeCloseTo(0.05, 12);
  });

  it("P' = 1 → priority 0", () => {
    expect(suggestedTodayPriority({ daysToExam: 1, effectiveProbability: 1, dependentsInScope: 5 })).toBe(0);
  });

  it("closer, higher priority; more dependents, higher priority", () => {
    const base = { effectiveProbability: 0.3, dependentsInScope: 1 };
    expect(suggestedTodayPriority({ ...base, daysToExam: 2 })).toBeGreaterThan(suggestedTodayPriority({ ...base, daysToExam: 10 }));
    expect(suggestedTodayPriority({ daysToExam: 2, effectiveProbability: 0.3, dependentsInScope: 4 })).toBeCloseTo((1 / 3) * 0.7 * 5, 12);
  });
});

describe("daysUntil (UTC, calendar days)", () => {
  it("same day → 0, at any hour", () => {
    expect(daysUntil("2026-11-09", new Date("2026-11-09T00:00:00Z"))).toBe(0);
    expect(daysUntil("2026-11-09", new Date("2026-11-09T23:59:59Z"))).toBe(0);
  });

  it("tomorrow → 1 even if a minute is missing (calendar days, not hours/24)", () => {
    expect(daysUntil("2026-11-10", new Date("2026-11-09T23:59:00Z"))).toBe(1);
    expect(daysUntil("2026-11-10", new Date("2026-11-09T00:00:00Z"))).toBe(1);
  });

  it("negative if already past", () => {
    expect(daysUntil("2026-11-01", new Date("2026-11-09T12:00:00Z"))).toBe(-8);
  });

  it("counted in UTC, not in the local time of `now`", () => {
    // 23:30 at UTC−3 on day 9 is already day 10 in UTC.
    expect(daysUntil("2026-11-10", new Date("2026-11-09T23:30:00-03:00"))).toBe(0);
    expect(daysUntil("2026-11-09", new Date("2026-11-09T23:30:00-03:00"))).toBe(-1);
  });

  it("crosses months and the DST change without drifting: 2026-11-09 → 2027-03-31 = 142", () => {
    expect(daysUntil("2027-03-31", new Date("2026-11-09T08:00:00Z"))).toBe(142);
  });
});
