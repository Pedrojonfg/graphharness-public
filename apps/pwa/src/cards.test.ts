import { describe, expect, it } from "vitest";
import { cardInstanceConfirmation, cardMcq, cardParsons, cardPredict, cardSpotBug, cardText } from "./fixtures.ts";
import { allowsOverride, gradeLocally, reviewBody, inputKindOf } from "./cards.ts";

describe("local card grading", () => {
  it("text: normalizes (case, whitespace) and accepts the variants", () => {
    const c = cardText();
    expect(gradeLocally(c, { text: "  EigenValue " })).toBe(true);
    expect(gradeLocally(c, { text: "characteristic value" })).toBe(true);
    expect(gradeLocally(c, { text: "eigenvector" })).toBe(false);
    expect(gradeLocally(c, { text: "" })).toBe(false);
  });

  it("cloze with formula: compares normalized (minus sign, decimal commas)", () => {
    const c = cardText({ kind: "cloze", answer: { text: "-0.5", accepted: [] } });
    expect(gradeLocally(c, { text: "\u22120,5" })).toBe(true);
  });

  it("MCQ: correct only with the right option", () => {
    expect(gradeLocally(cardMcq(), { optionId: "o1" })).toBe(true);
    expect(gradeLocally(cardMcq(), { optionId: "o2" })).toBe(false);
  });

  it("the review body carries `correct` and `given` when graded locally", () => {
    expect(reviewBody(cardText(), { text: "eigenvalue" }, 4200.4)).toEqual({ correct: true, given: "eigenvalue", responseMs: 4200 });
  });

  it("template confirmation without an answer: not graded here, only `given` is sent", () => {
    const c = cardInstanceConfirmation();
    const value = [
      ["1", "0"],
      ["0", "1"],
    ];
    expect(gradeLocally(c, { value })).toBeNull();
    const body = reviewBody(c, { value }, 1000);
    expect(body).toEqual({ given: value, responseMs: 1000 });
    expect("correct" in body).toBe(false);
    expect(allowsOverride(c)).toBe(false);
  });

  it("'actually I was right' only on cloze/text/predict graded locally", () => {
    expect(allowsOverride(cardText())).toBe(true);
    expect(allowsOverride(cardPredict())).toBe(true);
    expect(allowsOverride(cardMcq())).toBe(false);
    expect(allowsOverride(cardParsons())).toBe(false);
  });

  it("parsons: exact id order", () => {
    const c = cardParsons();
    expect(gradeLocally(c, { order: ["l0", "l1"] })).toBe(true);
    expect(gradeLocally(c, { order: ["l1", "l0"] })).toBe(false);
    expect(reviewBody(c, { order: ["l0", "l1"] }, 100)).toEqual({
      correct: true,
      given: ["l0", "l1"],
      responseMs: 100,
    });
    expect(inputKindOf(c)).toBe("parsons");
  });

  it("predict: normalizes like text", () => {
    const c = cardPredict();
    expect(gradeLocally(c, { text: " 3 " })).toBe(true);
    expect(gradeLocally(c, { text: "4" })).toBe(false);
  });

  it("spot_bug: line by id", () => {
    const c = cardSpotBug();
    expect(gradeLocally(c, { lineId: "l1" })).toBe(true);
    expect(gradeLocally(c, { lineId: "l2" })).toBe(false);
    expect(inputKindOf(c)).toBe("spot_bug");
  });
});
