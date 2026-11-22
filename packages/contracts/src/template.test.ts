import { describe, expect, it } from "vitest";
import { uiGradingMethods } from "./template.ts";

describe("uiGradingMethods", () => {
  it("hides the selector with a single method", () => {
    expect(uiGradingMethods({ evaluatorKey: "a", gradingMethods: undefined })).toBeUndefined();
    expect(uiGradingMethods({ evaluatorKey: "a", gradingMethods: [{ evaluatorKey: "a", label: "One" }] })).toBeUndefined();
  });

  it("exposes options if there is more than one method", () => {
    const m = [
      { evaluatorKey: "a", label: "A" },
      { evaluatorKey: "b", label: "B" },
    ];
    expect(uiGradingMethods({ evaluatorKey: "a", gradingMethods: m })).toEqual(m);
  });
});
