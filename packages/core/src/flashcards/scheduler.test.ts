import { describe, expect, it } from "vitest";
import { gradeText } from "./grade.ts";
import {
  DEFAULT_EASE,
  firstReviewDelayDays,
  isDue,
  MIN_EASE,
  newSchedule,
  orderQueue,
  overrideToCorrect,
  priority,
  review,
} from "./scheduler.ts";

const DAY = 86_400_000;
const T0 = Date.parse("2026-10-19T10:00:00Z");

describe("first review (057)", () => {
  it("max(1, min(30, floor(days/4))); no date, 1 day", () => {
    const now = new Date(T0);
    expect(firstReviewDelayDays(now, null)).toBe(1);
    expect(firstReviewDelayDays(now, "2026-10-19")).toBe(1);
    expect(firstReviewDelayDays(now, "2026-11-02")).toBe(3);
    expect(firstReviewDelayDays(now, "2027-06-01")).toBe(30);
  });
});

describe("ordinal SM-2 (025)", () => {
  it("priority = (now − t_ref) / interval", () => {
    const s = newSchedule(T0, 2);
    expect(priority(s, T0 + DAY)).toBeCloseTo(0.5);
    expect(isDue(s, T0 + 2 * DAY)).toBe(true);
  });

  it("the first review is always real, even if it is early", () => {
    const r = review(newSchedule(T0, 3), { correct: true, responseMs: 10_000, now: T0 + 1000 });
    expect(r.early).toBe(false);
    expect(r.schedule).toMatchObject({ repetitions: 1, intervalDays: 3, ease: DEFAULT_EASE });
  });

  it("early success: neither ease nor interval grow; only the clock is reset", () => {
    const s1 = review(newSchedule(T0, 1), { correct: true, responseMs: 10_000, now: T0 + DAY }).schedule;
    const r = review(s1, { correct: true, responseMs: 1000, now: T0 + DAY + 1000 });
    expect(r.early).toBe(true);
    expect(r.schedule).toMatchObject({ ease: s1.ease, intervalDays: s1.intervalDays, repetitions: s1.repetitions, tRef: T0 + DAY + 1000 });
  });

  it("on-time success: interval × ease; fast raises ease and slow lowers it", () => {
    let s = review(newSchedule(T0, 1), { correct: true, responseMs: 10_000, now: T0 + DAY }).schedule;
    const fast = review(s, { correct: true, responseMs: 2000, now: T0 + 3 * DAY }).schedule;
    const slow = review(s, { correct: true, responseMs: 40_000, now: T0 + 3 * DAY }).schedule;
    expect(fast.ease).toBeGreaterThan(DEFAULT_EASE);
    expect(slow.ease).toBeLessThan(DEFAULT_EASE);
    expect(fast.intervalDays).toBeGreaterThan(slow.intervalDays);
    s = fast;
    expect(s.repetitions).toBe(2);
  });

  it("failure (also early): ease lowered, interval 1 day; never below the minimum", () => {
    let s = newSchedule(T0, 5);
    for (let i = 0; i < 10; i++) s = review(s, { correct: false, responseMs: 5000, now: T0 + i * 1000 }).schedule;
    expect(s).toMatchObject({ intervalDays: 1, repetitions: 0, ease: MIN_EASE });
  });

  it("\"actually went well\" within the window", () => {
    const before = review(newSchedule(T0, 1), { correct: true, responseMs: 10_000, now: T0 + DAY }).schedule;
    expect(overrideToCorrect(before, T0 + 3 * DAY, T0 + 3 * DAY + 30_000, 10_000)?.schedule.repetitions).toBe(2);
    expect(overrideToCorrect(before, T0 + 3 * DAY, T0 + 3 * DAY + 120_000, 10_000)).toBeNull();
  });

  it("infinite queue: all non-retired cards, from highest to lowest priority", () => {
    const cards = [
      { id: "a", schedule: newSchedule(T0, 4) },
      { id: "b", schedule: newSchedule(T0, 1) },
      { id: "c", schedule: newSchedule(T0, 1), retired: true },
    ];
    expect(orderQueue(cards, T0 + DAY).map((c) => c.id)).toEqual(["b", "a"]);
  });
});

describe("local grading", () => {
  it("compares normalized answers", () => {
    expect(gradeText("6*x^2 + 1", "6x^2+1".replace("6x", "6*x"))).toBe(true);
    expect(gradeText("-3/4", " −3/4 ")).toBe(true);
    expect(gradeText("1,5", "1.5")).toBe(true);
    expect(gradeText("5", "6")).toBe(false);
  });
});
