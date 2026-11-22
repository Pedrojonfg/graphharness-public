// Ported from graphlearn/apps/worker/src/pdf/latex.ts (65b56d6): escapeText, isSafeMath and lineWithMath.
// Changes: line breaks are not collapsed here (whoever renders decides the paragraphs).

/** Commands that cannot appear in math or in foreign TikZ (file reading/writing, macros). */
export const FORBIDDEN_TEX =
  /\\(?:input|include|write|def|edef|gdef|let|newcommand|renewcommand|immediate|openout|openin|read|catcode|csname|usepackage|documentclass|special|directlua|loop)\b/i;

const ESCAPES: Record<string, string> = {
  "\\": "\\textbackslash{}",
  "{": "\\{",
  "}": "\\}",
  $: "\\$",
  "&": "\\&",
  "#": "\\#",
  _: "\\_",
  "%": "\\%",
  "^": "\\textasciicircum{}",
  "~": "\\textasciitilde{}",
};

/** Symbols that the LLM writes in text and that pdflatex (utf8 + T1) does not know. */
const UNICODE_MATH: Record<string, string> = {
  "≠": "$\\neq$", "≤": "$\\leq$", "≥": "$\\geq$", "≈": "$\\approx$", "≡": "$\\equiv$",
  "∈": "$\\in$", "∉": "$\\notin$", "⊂": "$\\subset$", "⊆": "$\\subseteq$", "∪": "$\\cup$", "∩": "$\\cap$",
  "∅": "$\\emptyset$", "∀": "$\\forall$", "∃": "$\\exists$", "∞": "$\\infty$", "√": "$\\sqrt{}$",
  "→": "$\\to$", "⇒": "$\\Rightarrow$", "⇔": "$\\Leftrightarrow$", "↔": "$\\leftrightarrow$",
  "−": "-", "⋅": "$\\cdot$", "∓": "$\\mp$",
  "∑": "$\\sum$", "∏": "$\\prod$", "∫": "$\\int$", "∂": "$\\partial$", "∇": "$\\nabla$", "⊥": "$\\perp$",
  "⁻": "$^-$", "₀": "$_0$", "₁": "$_1$", "₂": "$_2$", "₃": "$_3$", "ₙ": "$_n$",
  "α": "$\\alpha$", "β": "$\\beta$", "γ": "$\\gamma$", "δ": "$\\delta$", "ε": "$\\varepsilon$", "θ": "$\\theta$",
  "λ": "$\\lambda$", "μ": "$\\mu$", "π": "$\\pi$", "σ": "$\\sigma$", "φ": "$\\varphi$", "ω": "$\\omega$",
  "Δ": "$\\Delta$", "Σ": "$\\Sigma$", "Ω": "$\\Omega$", "ℝ": "$\\mathbb{R}$", "ℕ": "$\\mathbb{N}$",
  "ℤ": "$\\mathbb{Z}$", "ℚ": "$\\mathbb{Q}$", "ℂ": "$\\mathbb{C}$",
  "“": "``", "”": "''", "‘": "`", "’": "'", "–": "--", "—": "---", "…": "\\ldots{}",
};

/** Escapes the 10 special LaTeX characters: \ { } $ & # _ % ^ ~ */
export function escapeLatex(s: string): string {
  return s
    .replace(/[\\{}$&#_%^~]/g, (ch) => ESCAPES[ch]!)
    // Outside ASCII + Latin-1: known symbol → its equivalent; unknown letter → "?"; the rest → space.
    .replace(/[^\x20-\x7E -ÿ\n\t]/gu, (ch) => UNICODE_MATH[ch] ?? (/[\p{L}\p{N}]/u.test(ch) ? "?" : " "));
}

/**
 * Math that can be left as is: no dangerous commands, no `$` and a reasonable size.
 * Nor unescaped `%` or `#`: a `%` would comment out the rest of the line (and the closing `$`).
 */
export function isSafeMath(tex: string): boolean {
  return !FORBIDDEN_TEX.test(tex) && tex.length <= 4000 && !tex.includes("$") && !/(^|[^\\])[%#]/.test(tex);
}

/** Text with `$…$` formulas: keeps the safe formulas and escapes the rest. A formula with dangerous commands (\input, \write, …) is escaped entirely. */
export function mathAwareEscape(s: string): string {
  return s
    .split(/(\$[^$]+\$)/g)
    .map((part) => {
      if (part.length >= 2 && part.startsWith("$") && part.endsWith("$") && isSafeMath(part.slice(1, -1))) return part;
      return escapeLatex(part);
    })
    .join("");
}
