import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Value } from "./MathView.tsx";

const isMath = (value: unknown) => render(<Value value={value} />).container.querySelector(".katex") !== null;

describe("Value: prose or formula", () => {
  it("a value with a word of 3+ letters followed by a space is prose (any alphabet)", () => {
    expect(isMath("diagonalizable matrix")).toBe(false);
    expect(isMath("No real solution")).toBe(false);
    // accented / non-ASCII letters (written with \u escapes) count as letters too
    expect(isMath("na\u00efve approach")).toBe(false);
    expect(isMath("an \u00fcber simple case")).toBe(false);
    expect(isMath("\u03b1\u03b2\u03b3 case")).toBe(false);
    expect(isMath("\u00e9t\u00e9 ")).toBe(false);
  });
  it("a value containing $…$ is rendered as text with math", () => {
    expect(isMath("x = $1/2$")).toBe(true); // the formula part is still rendered with KaTeX
    expect(render(<Value value="x = $1/2$" />).container.textContent).toContain("x =");
  });
  it("numbers, expressions, vectors and matrices are formulas", () => {
    expect(isMath("3*x**2 + 1/2")).toBe(true);
    expect(isMath("sqrt(2)")).toBe(true);
    expect(isMath(42)).toBe(true);
    expect(isMath([1, 2])).toBe(true);
    expect(isMath([[1, 2], [3, 4]])).toBe(true);
    expect(isMath("ab")).toBe(true); // fewer than 3 letters in a row is not prose
  });
});
