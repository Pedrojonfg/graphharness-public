import { AnswerValueSchema, type AnswerValue, type RecipeClientPayload } from "@graphharness/contracts";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { cellsToValue, answerGridFor, AnswerInput } from "./AnswerInput.tsx";

const matrix: RecipeClientPayload = { recipeVersion: 1, statement: "Compute $AB$", answerKind: "matrix", shape: { rows: 2, cols: 3 }, variables: [], choices: null };

describe("matrix and vector input", () => {
  it("grid → list of string rows, as eval expects (and satisfies AnswerValueSchema)", () => {
    const r = answerGridFor(matrix);
    expect(r).toEqual({ kind: "matrix", rows: 2, cols: 3 });
    const v = cellsToValue(r, [" 1", "2", "3/4", "0", "-1", "x "]);
    expect(v).toEqual([
      ["1", "2", "3/4"],
      ["0", "-1", "x"],
    ]);
    expect(AnswerValueSchema.safeParse(v).success).toBe(true);
  });

  it("vector uses `size` and yields a flat list", () => {
    const r = answerGridFor({ answerKind: "vector", shape: { size: 3 } });
    expect(cellsToValue(r, ["1", "2", "3"])).toEqual(["1", "2", "3"]);
  });

  it("with empty cells there is no value", () => {
    expect(cellsToValue(answerGridFor(matrix), ["1", "", "3", "4", "5", "6"])).toBeNull();
  });

  it("the component renders rows×columns cells and returns the value once they are filled", () => {
    const seen: (AnswerValue | null)[] = [];
    render(<AnswerInput instance={{ ...matrix, shape: { rows: 2, cols: 2 } }} onChange={(v) => seen.push(v)} />);
    const cells = ["Row 1, column 1", "Row 1, column 2", "Row 2, column 1", "Row 2, column 2"].map((l) => screen.getByLabelText(l));
    ["2", "0", "1", "-3"].forEach((v, i) => fireEvent.change(cells[i]!, { target: { value: v } }));
    expect(seen.at(-1)).toEqual([
      ["2", "0"],
      ["1", "-3"],
    ]);
  });
});
