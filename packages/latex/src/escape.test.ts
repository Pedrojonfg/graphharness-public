import { describe, expect, it } from "vitest";
import { escapeLatex, mathAwareEscape } from "./escape.ts";

describe("escapeLatex", () => {
  it.each([
    ["\\", "\\textbackslash{}"],
    ["{", "\\{"],
    ["}", "\\}"],
    ["$", "\\$"],
    ["&", "\\&"],
    ["#", "\\#"],
    ["_", "\\_"],
    ["%", "\\%"],
    ["^", "\\textasciicircum{}"],
    ["~", "\\textasciitilde{}"],
  ])("escapes %s", (ch, esc) => {
    expect(escapeLatex(ch)).toBe(esc);
    expect(escapeLatex(`a${ch}b`)).toBe(`a${esc}b`);
  });

  it("does not escape twice what was just escaped and leaves normal text alone", () => {
    expect(escapeLatex("\\{x}")).toBe("\\textbackslash{}\\{x\\}");
    expect(escapeLatex("Hello world, how are you? \u00bfok?")).toBe("Hello world, how are you? \u00bfok?");
  });
});

describe("mathAwareEscape", () => {
  it("keeps $x^2$ and escapes 50% & _ in the rest", () => {
    expect(mathAwareEscape("If $x^2$ equals 50% & a_b")).toBe("If $x^2$ equals 50\\% \\& a\\_b");
  });
  it("keeps several formulas and escapes what is between them", () => {
    expect(mathAwareEscape("$a_1$ and $\\frac{1}{2}$ # end")).toBe("$a_1$ and $\\frac{1}{2}$ \\# end");
  });
  it("a formula with dangerous commands is escaped entirely", () => {
    const out = mathAwareEscape("look $\\input{/etc/passwd}$ now");
    expect(out).not.toContain("$\\input");
    expect(out).toContain("\\$");
    expect(out).toContain("\\textbackslash{}input");
  });
  it("an unclosed $ is escaped", () => {
    expect(mathAwareEscape("costs 5$ today")).toBe("costs 5\\$ today");
  });
});
