import { describe, expect, it } from "vitest";
import { canonicalUserInputJson, userInputPatternHash } from "./error-pattern.ts";

describe("userInputPatternHash (048)", () => {
  it("is stable for key order", () => {
    const a = { result: [[1, 2], [3, 4]] };
    const b = { result: [[1, 2], [3, 4]] };
    expect(userInputPatternHash(a)).toBe(userInputPatternHash(b));
    expect(canonicalUserInputJson({ z: 1, a: 2 })).toBe('{"a":2,"z":1}');
  });
});
