// ADR 106: evidence weight multipliers. m = clamp(missClass × confidence × time, WEIGHT_MIN, WEIGHT_MAX).
import { describe, expect, it } from "vitest";
import { evidenceWeightMultiplier as m, weightConfigFromEnv, type MissClass, type WeightInput } from "./weights.ts";

/** LH practice failure with a missClass. */
const practiceMiss = (missClass: MissClass | null): WeightInput => ({ source: "lh_practice", correct: false, missClass });

describe("evidenceWeightMultiplier: missClass (only failed lh_practice)", () => {
  it.each([
    ["careless", 0.4],
    ["execution", 0.8],
    ["cue", 1],
    ["discrimination", 1],
    ["structural", 1.2],
  ] as const)("failure %s → ×%s", (missClass, expected) => {
    expect(m(practiceMiss(missClass))).toBeCloseTo(expected, 10);
  });

  it("failure without missClass (null or absent) → ×1", () => {
    expect(m(practiceMiss(null))).toBeCloseTo(1, 10);
    expect(m({ source: "lh_practice", correct: false })).toBeCloseTo(1, 10);
  });

  it("success with missClass present → ignored", () => {
    expect(m({ source: "lh_practice", correct: true, missClass: "careless" })).toBeCloseTo(1, 10);
    expect(m({ source: "lh_practice", correct: true, missClass: "structural" })).toBeCloseTo(1, 10);
  });

  it("failure from another source with missClass → ignored", () => {
    expect(m({ source: "lh_quiz", correct: false, missClass: "careless" })).toBeCloseTo(1, 10);
    expect(m({ source: "hub_exercise", correct: false, missClass: "structural" })).toBeCloseTo(1, 10);
  });
});

describe("evidenceWeightMultiplier: confidence (any source, successes and failures)", () => {
  it.each([
    [0, 0.75],
    [50, 1],
    [100, 1.25],
    [70, 1.1],
  ])("confidence %s → ×%s", (confidence, expected) => {
    expect(m({ source: "lh_quiz", correct: true, confidence })).toBeCloseTo(expected, 10);
    expect(m({ source: "lh_quiz", correct: false, confidence })).toBeCloseTo(expected, 10);
  });

  it("no confidence (null or absent) → ×1", () => {
    expect(m({ source: "lh_probe", correct: true, confidence: null })).toBeCloseTo(1, 10);
    expect(m({ source: "lh_probe", correct: false })).toBeCloseTo(1, 10);
  });

  it("also applies outside LH (e.g. hub_exercise)", () => {
    expect(m({ source: "hub_exercise", correct: true, confidence: 100 })).toBeCloseTo(1.25, 10);
  });

  it("outside 0–100 is clamped to the range", () => {
    expect(m({ source: "lh_quiz", correct: true, confidence: 150 })).toBeCloseTo(1.25, 10);
    expect(m({ source: "lh_quiz", correct: true, confidence: -20 })).toBeCloseTo(0.75, 10);
  });
});

describe("evidenceWeightMultiplier: time (only flashcard and hub_exercise)", () => {
  it.each([
    [1000, 1.1],
    [5000, 1.1], // inclusive boundary
    [5001, 1],
    [10000, 1],
    [29999, 1],
    [30000, 0.9], // inclusive boundary
    [40000, 0.9],
  ])("flashcard at %s ms → ×%s", (responseMs, expected) => {
    expect(m({ source: "flashcard", correct: true, responseMs })).toBeCloseTo(expected, 10);
  });

  it("applies to successes and failures, and also to hub_exercise", () => {
    expect(m({ source: "flashcard", correct: false, responseMs: 3000 })).toBeCloseTo(1.1, 10);
    expect(m({ source: "hub_exercise", correct: true, responseMs: 3000 })).toBeCloseTo(1.1, 10);
    expect(m({ source: "hub_exercise", correct: false, responseMs: 40000 })).toBeCloseTo(0.9, 10);
  });

  it("no time → ×1", () => {
    expect(m({ source: "flashcard", correct: true, responseMs: null })).toBeCloseTo(1, 10);
    expect(m({ source: "hub_exercise", correct: true })).toBeCloseTo(1, 10);
  });

  it("ignored for LH sources (lh_quiz, lh_practice)", () => {
    expect(m({ source: "lh_quiz", correct: true, responseMs: 1000 })).toBeCloseTo(1, 10);
    expect(m({ source: "lh_quiz", correct: false, responseMs: 60000 })).toBeCloseTo(1, 10);
    expect(m({ source: "lh_practice", correct: true, responseMs: 1000 })).toBeCloseTo(1, 10);
  });
});

describe("evidenceWeightMultiplier: product and clamping", () => {
  it("correct = null (declaration) → ×1 even if it has confidence or time", () => {
    expect(m({ source: "declaration", correct: null, confidence: 100 })).toBeCloseTo(1, 10);
    expect(m({ source: "flashcard", correct: null, responseMs: 1000 })).toBeCloseTo(1, 10);
  });

  it("multiplies all three: failed practice execution × confidence 0 = 0.8 × 0.75 = 0.6", () => {
    expect(m({ source: "lh_practice", correct: false, missClass: "execution", confidence: 0 })).toBeCloseTo(0.6, 10);
  });

  it("confidence × time on a card: 100 and 3000 ms → 1.25 × 1.1 = 1.375", () => {
    expect(m({ source: "flashcard", correct: true, confidence: 100, responseMs: 3000 })).toBeCloseTo(1.375, 10);
  });

  it("careless × confidence 0 = 0.4 × 0.75 = 0.3 (within the lower bound)", () => {
    expect(m({ source: "lh_practice", correct: false, missClass: "careless", confidence: 0 })).toBeCloseTo(0.3, 10);
  });

  it("upper bound: structural × confidence 100 = 1.2 × 1.25 = exactly 1.5 (no more)", () => {
    expect(m({ source: "lh_practice", correct: false, missClass: "structural", confidence: 100 })).toBeCloseTo(1.5, 10);
  });

  it("upper bound with a config that exceeds it: clamped to WEIGHT_MAX", () => {
    const cfg = weightConfigFromEnv({ WEIGHT_MISS_STRUCTURAL: "2" }); // 2 × 1.25 = 2.5
    expect(m({ source: "lh_practice", correct: false, missClass: "structural", confidence: 100 }, cfg)).toBeCloseTo(1.5, 10);
  });

  it("lower bound with a config that pushes below 0.25: clamped to WEIGHT_MIN", () => {
    const cfg = weightConfigFromEnv({ WEIGHT_MISS_CARELESS: "0.1" }); // 0.1 × 0.75 = 0.075
    expect(m({ source: "lh_practice", correct: false, missClass: "careless", confidence: 0 }, cfg)).toBeCloseTo(0.25, 10);
  });
});

describe("weightConfigFromEnv", () => {
  const cases: WeightInput[] = [
    practiceMiss("careless"),
    practiceMiss("execution"),
    practiceMiss("cue"),
    practiceMiss("discrimination"),
    practiceMiss("structural"),
    { source: "lh_quiz", correct: true, confidence: 0 },
    { source: "lh_quiz", correct: true, confidence: 100 },
    { source: "flashcard", correct: true, responseMs: 5000 },
    { source: "flashcard", correct: true, responseMs: 30000 },
  ];

  it("no variables: the ADR default values (same as without config)", () => {
    const cfg = weightConfigFromEnv({});
    for (const c of cases) expect(m(c, cfg)).toBeCloseTo(m(c), 10);
    expect(m(practiceMiss("careless"), cfg)).toBeCloseTo(0.4, 10);
    expect(m({ source: "lh_quiz", correct: true, confidence: 100 }, cfg)).toBeCloseTo(1.25, 10);
  });

  it("missClass via env: WEIGHT_MISS_*", () => {
    const cfg = weightConfigFromEnv({
      WEIGHT_MISS_CARELESS: "0.5",
      WEIGHT_MISS_EXECUTION: "0.7",
      WEIGHT_MISS_CUE: "0.9",
      WEIGHT_MISS_DISCRIMINATION: "1.1",
      WEIGHT_MISS_STRUCTURAL: "1.3",
    });
    expect(m(practiceMiss("careless"), cfg)).toBeCloseTo(0.5, 10);
    expect(m(practiceMiss("execution"), cfg)).toBeCloseTo(0.7, 10);
    expect(m(practiceMiss("cue"), cfg)).toBeCloseTo(0.9, 10);
    expect(m(practiceMiss("discrimination"), cfg)).toBeCloseTo(1.1, 10);
    expect(m(practiceMiss("structural"), cfg)).toBeCloseTo(1.3, 10);
  });

  it("confidence via env: WEIGHT_CONF_BASE + WEIGHT_CONF_SPAN·c/100", () => {
    const cfg = weightConfigFromEnv({ WEIGHT_CONF_BASE: "0.5", WEIGHT_CONF_SPAN: "1" });
    expect(m({ source: "lh_quiz", correct: true, confidence: 0 }, cfg)).toBeCloseTo(0.5, 10);
    expect(m({ source: "lh_quiz", correct: true, confidence: 50 }, cfg)).toBeCloseTo(1, 10);
    expect(m({ source: "lh_quiz", correct: true, confidence: 90 }, cfg)).toBeCloseTo(1.4, 10);
  });

  it("time via env: thresholds and factors", () => {
    const cfg = weightConfigFromEnv({ WEIGHT_TIME_FAST_MS: "2000", WEIGHT_TIME_FAST: "1.2", WEIGHT_TIME_SLOW_MS: "10000", WEIGHT_TIME_SLOW: "0.8" });
    expect(m({ source: "flashcard", correct: true, responseMs: 2000 }, cfg)).toBeCloseTo(1.2, 10);
    expect(m({ source: "flashcard", correct: true, responseMs: 3000 }, cfg)).toBeCloseTo(1, 10);
    expect(m({ source: "flashcard", correct: true, responseMs: 10000 }, cfg)).toBeCloseTo(0.8, 10);
  });

  it("bounds via env: WEIGHT_MIN and WEIGHT_MAX", () => {
    const cfg = weightConfigFromEnv({ WEIGHT_MIN: "0.5", WEIGHT_MAX: "1.2" });
    expect(m(practiceMiss("careless"), cfg)).toBeCloseTo(0.5, 10);
    expect(m({ source: "lh_quiz", correct: true, confidence: 100 }, cfg)).toBeCloseTo(1.2, 10);
  });
});
