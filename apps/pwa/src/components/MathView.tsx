// Ported from the GraphLearn web app (65b56d6; see docs/PROVENANCE.md).
// Only the formula-rendering part: KaTeX, text with $…$ and answer values (number, vector, matrix).
import "katex/dist/katex.min.css";
import katex from "katex";
import { useMemo } from "react";

export function MathView({ tex, display = false }: { tex: string; display?: boolean }) {
  const html = useMemo(
    () => katex.renderToString(tex, { throwOnError: false, displayMode: display, strict: "ignore", trust: false }),
    [tex, display],
  );
  return <span className={display ? "math math-block" : "math"} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** Text with formulas between $…$ (or $$…$$). The rest is rendered as plain text. */
export function TextWithMath({ text }: { text: string }) {
  const parts = text.split(/(\$\$[^$]+\$\$|\$[^$]+\$)/g).filter(Boolean);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("$$") ? (
          <MathView key={i} tex={p.slice(2, -2)} display />
        ) : p.startsWith("$") && p.length > 1 ? (
          <MathView key={i} tex={p.slice(1, -1)} />
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

/** Paragraphs separated by blank lines, each with its formulas. */
export function Paragraphs({ text }: { text: string }) {
  return (
    <>
      {text
        .split(/\n\s*\n/)
        .filter((p) => p.trim())
        .map((p, i) => (
          <p key={i}>
            <TextWithMath text={p} />
          </p>
        ))}
    </>
  );
}

/** SymPy notation ("3*x**2 + 1/2", "sqrt(2)") → LaTeX for display. Rendering only. */
export function sympyToTex(s: string): string {
  return s
    .replace(/\*\*/g, "^")
    .replace(/sqrt\(([^()]+)\)/g, "\\sqrt{$1}")
    .replace(/(-?\d+)\/(\d+)/g, "\\tfrac{$1}{$2}")
    .replace(/\^(\d{2,}|\([^()]+\))/g, (_, e: string) => `^{${e.replace(/^\(|\)$/g, "")}}`)
    .replace(/\*/g, " \\cdot ")
    .replace(/\bpi\b/g, "\\pi");
}

/** Value of an option or of the solution (number, expression, vector or matrix) as LaTeX. */
export function valueTex(v: unknown): string {
  if (Array.isArray(v) && v.length && Array.isArray(v[0]))
    return `\\begin{pmatrix}${(v as unknown[][]).map((r) => r.map((x) => sympyToTex(String(x))).join(" & ")).join(" \\\\ ")}\\end{pmatrix}`;
  if (Array.isArray(v)) return `\\left(${v.map((x) => sympyToTex(String(x))).join(",\\ ")}\\right)`;
  return sympyToTex(String(v));
}

/** Solution or option as displayed: text if it is prose (or contains $…$), formula otherwise. */
export function Value({ value }: { value: unknown }) {
  if (typeof value === "string" && (value.includes("$") || /\p{L}{3,}\s/u.test(value))) return <TextWithMath text={value} />;
  return <MathView tex={valueTex(value)} />;
}
