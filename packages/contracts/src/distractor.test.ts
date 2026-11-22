import { describe, expect, it } from "vitest";
import { computeDistractorWeights } from "./distractor.ts";

describe("computeDistractorWeights", () => {
  const a = "11111111-1111-4111-8111-111111111104";
  const b = "11111111-1111-4111-8111-111111111105";

  it("cold start uniform when counts are zero", () => {
    const w = computeDistractorWeights(
      [
        { errorId: a, count: 0, distractorWeightBase: 1 },
        { errorId: b, count: 0, distractorWeightBase: 1 },
      ],
      1,
    );
    expect(w).toEqual([
      { errorId: a, weight: 0.5 },
      { errorId: b, weight: 0.5 },
    ]);
  });

  it("smooths toward population counts", () => {
    const w = computeDistractorWeights(
      [
        { errorId: a, count: 9, distractorWeightBase: 1 },
        { errorId: b, count: 1, distractorWeightBase: 1 },
      ],
      1,
    );
    expect(w[0]!.weight).toBeCloseTo(10 / 12);
    expect(w[1]!.weight).toBeCloseTo(2 / 12);
  });

  it("uses prior floor when base is below floor", () => {
    const w = computeDistractorWeights(
      [{ errorId: a, count: 0, distractorWeightBase: 0 }],
      1,
    );
    expect(w[0]!.weight).toBe(1);
  });
});
