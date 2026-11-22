import { describe, expect, it } from "vitest";
import { masterData, sessionData, sessionTikz } from "./fixtures.ts";
import { renderMasterTex, renderSessionTex } from "./render.ts";
import { TIKZ_FRAGMENT_MAX_CHARS } from "./types.ts";

const SESSION_SECTIONS = [
  "Summary", "Concepts covered", "Questions", "Practices", "Errors and corrections", "Declarations",
  "Cards created", "Review material", "Verified formulas", "Concept map", "Next recommendation",
];
const MASTER_SECTIONS = [
  "Review frontier", "Weak concepts", "Concepts to review", "Recurring errors",
  "Consolidated concepts", "Upcoming exams",
];
const bigTikz = (n: number) => `\\begin{tikzpicture}\n${"% filler\n".repeat(Math.ceil(n / 9))}\\end{tikzpicture}`;

describe("renderSessionTex", () => {
  const { tex, omitted } = renderSessionTex({ ...sessionData, tikz: sessionTikz });

  it("is a complete document without unfilled placeholders", () => {
    expect(tex).toContain("\\documentclass");
    expect(tex).toContain("\\begin{document}");
    expect(tex.trimEnd().endsWith("\\end{document}")).toBe(true);
    expect(tex).not.toMatch(/<<[A-Z_]+>>/);
    expect(omitted).toEqual([]);
  });
  it.each(SESSION_SECTIONS)("contains the section «%s»", (s) => {
    expect(tex).toMatch(new RegExp(`\\\\section\\*?\\{${s}\\}`));
  });
  it("includes title, subject and date", () => {
    expect(tex).toContain("Derivatives session");
    expect(tex).toContain("Calculus I");
    expect(tex).toContain("November 9, 2026");
  });
  it("keeps the formulas of the LLM text and of the questions, and escapes the rest", () => {
    expect(tex).toContain("$x^2$");
    expect(tex).toContain("50\\%");
    expect(tex).toContain("a\\_b");
    expect(tex).toContain("$f'(g(x))\\,g'(x)$");
  });
  it("verified formulas go as unescaped display math", () => {
    expect(tex).toContain("\\frac{d}{dx}x^n = n x^{n-1}");
  });
  it("shows the verdict and the before/after of the concepts", () => {
    expect(tex).toContain("Chain rule");
    expect(tex).toContain("Differentiate composites");
    expect(tex).toMatch(/partial/i);
    expect(tex).toContain("Integrals");
  });
  it("includes the TikZ when it fits", () => {
    expect(tex).toContain("\\node[draw] (n0)");
  });
  it(`omits with a notice the TikZ over ${TIKZ_FRAGMENT_MAX_CHARS} characters`, () => {
    const big = bigTikz(TIKZ_FRAGMENT_MAX_CHARS + 100);
    expect(big.length).toBeGreaterThan(TIKZ_FRAGMENT_MAX_CHARS);
    const r = renderSessionTex({ ...sessionData, tikz: big });
    expect(r.tex).not.toContain("% filler");
    expect(r.omitted).toHaveLength(1);
    expect(r.omitted[0]).toMatch(/TikZ|graph|concept map/i);
    expect(r.tex).toContain("What could not be included");
    expect(r.tex).toContain(r.omitted[0]!.replace(/[%&_#]/g, (c) => `\\${c}`));
  });
  it("a TikZ exactly at the limit is included", () => {
    const pad = "% x\n";
    const head = "\\begin{tikzpicture}\n";
    const tail = "\\end{tikzpicture}";
    const body = pad.repeat(Math.floor((TIKZ_FRAGMENT_MAX_CHARS - head.length - tail.length) / pad.length));
    const t = head + body + tail;
    expect(t.length).toBeLessThanOrEqual(TIKZ_FRAGMENT_MAX_CHARS);
    const r = renderSessionTex({ ...sessionData, tikz: t });
    expect(r.omitted).toEqual([]);
    expect(r.tex).toContain("% x");
  });
  it("includeTikz:false omits it with a notice", () => {
    const r = renderSessionTex({ ...sessionData, tikz: sessionTikz }, { includeTikz: false });
    expect(r.tex).not.toContain("\\node[draw] (n0)");
    expect(r.omitted).toHaveLength(1);
  });
  it("without tikz there is no notice or map section", () => {
    const r = renderSessionTex(sessionData);
    expect(r.omitted).toEqual([]);
    expect(r.tex).not.toContain("Concept map");
  });
  it("user text with LaTeX special characters does not break the document", () => {
    const r = renderSessionTex({ ...sessionData, title: "100% #1 & {a}", errors: [{ summary: "x_y", correction: "~z" }] });
    expect(r.tex).toContain("100\\% \\#1 \\& \\{a\\}");
    expect(r.tex).toContain("x\\_y");
  });
});

describe("renderMasterTex", () => {
  const { tex, omitted } = renderMasterTex({ ...masterData, tikz: sessionTikz });

  it("complete document without unfilled placeholders", () => {
    expect(tex).toContain("\\begin{document}");
    expect(tex).not.toMatch(/<<[A-Z_]+>>/);
    expect(omitted).toEqual([]);
  });
  it.each([...MASTER_SECTIONS, "Concept map"])("contains the section «%s»", (s) => {
    expect(tex).toMatch(new RegExp(`\\\\section\\*?\\{${s}\\}`));
  });
  it("shows the exams with P(prepared) as a percentage, plus the errors and consolidated data", () => {
    expect(tex).toContain("Midterm 1");
    expect(tex).toMatch(/62\s*\\?%/);
    expect(tex).toContain("Forgets the inner derivative");
    expect(tex).toContain("Continuity");
    expect(tex).toContain("Integrals");
  });
  it("omits the oversized TikZ with a notice", () => {
    const r = renderMasterTex({ ...masterData, tikz: bigTikz(TIKZ_FRAGMENT_MAX_CHARS + 100) });
    expect(r.tex).not.toContain("% filler");
    expect(r.omitted).toHaveLength(1);
    expect(r.tex).toContain("What could not be included");
  });
  it("includeTikz:false omits it with a notice", () => {
    const r = renderMasterTex({ ...masterData, tikz: sessionTikz }, { includeTikz: false });
    expect(r.tex).not.toContain("\\node[draw] (n0)");
    expect(r.omitted).toHaveLength(1);
  });
});
