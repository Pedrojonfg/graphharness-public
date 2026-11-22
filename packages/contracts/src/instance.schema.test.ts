import { describe, expect, it } from "vitest";
import { FormulaVerifyBodySchema } from "./instance.ts";

describe("FormulaVerifyBodySchema (038.13)", () => {
  it("accepts a sympy pair", () => {
    expect(FormulaVerifyBodySchema.safeParse({ left: "x+1", right: "1+x" }).success).toBe(true);
  });

  it("accepts a latex pair", () => {
    expect(
      FormulaVerifyBodySchema.safeParse({
        latexLeft: "x+1",
        latexRight: "1+x",
      }).success,
    ).toBe(true);
  });

  it("rejects mixing and incomplete pairs", () => {
    expect(FormulaVerifyBodySchema.safeParse({ left: "x" }).success).toBe(false);
    expect(
      FormulaVerifyBodySchema.safeParse({
        left: "x",
        right: "y",
        latexLeft: "a",
      }).success,
    ).toBe(false);
  });
});

describe("EvalStepGradeSchema", () => {
  it("accepts detectorKey null, as apps/eval returns it", async () => {
    const { EvalStepGradeSchema } = await import("./instance.js");
    expect(EvalStepGradeSchema.parse({ correct: true, detectorKey: null })).toEqual({ correct: true });
    expect(EvalStepGradeSchema.parse({ correct: false, detectorKey: "row_column_swap" })).toEqual({
      correct: false,
      detectorKey: "row_column_swap",
    });
  });
});
