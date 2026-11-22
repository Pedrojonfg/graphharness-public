// Sections and style ported from graphlearn/apps/worker/src/pdf/{latex,master}.ts (65b56d6):
// sessionDocument/masterDocument, map legend and isSafeTikz. Changes: fixed templates in
// templates/*.tex, session/master data (steps 5–6) and omission notices (GL-058) inside the .tex itself.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { escapeLatex, FORBIDDEN_TEX, isSafeMath, mathAwareEscape } from "./escape.ts";
import {
  type ConceptState,
  type MasterReportData,
  type RenderOptions,
  type RenderResult,
  type SessionReportData,
  TIKZ_FRAGMENT_MAX_CHARS,
} from "./types.ts";

export const TEMPLATES_DIR = fileURLToPath(new URL("../templates/", import.meta.url));

/** Notice when the TikZ is removed because it did not compile (also used by `compileWithFallback`). */
export const TIKZ_REMOVED_NOTICE = "The concept map (TikZ) did not compile and was removed from the document.";

const STATE_LABEL: Record<ConceptState, string> = { solid: "solid", review: "to review", weak: "weak", unknown: "no record" };
const VERDICT_LABEL = { correct: "correct", partial: "partial", incorrect: "incorrect" } as const;
const LEGEND =
  "{\\small \\textcolor{solid}{$\\blacksquare$} solid \\quad \\textcolor{review}{$\\blacksquare$} to review \\quad \\textcolor{weak}{$\\blacksquare$} weak \\quad \\textcolor{unknown}{$\\blacksquare$} no record}";

/** Plain text of one line. */
const esc = (s: string) => escapeLatex(oneLine(s));
/** Text with `$…$` of one line. */
const inlineMath = (s: string) => mathAwareEscape(oneLine(s));
const oneLine = (s: string) => s.replace(/\s*\n\s*/g, " ").trim();
/** Text with `$…$` in several paragraphs: each non-empty line is a paragraph. */
const blockMath = (s: string) =>
  s
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map(mathAwareEscape)
    .join("\n\n");
const pct = (p: number) => `${Math.round(p * 100)}\\%`;

function section(title: string, lines: string[]): string[] {
  return [`\\section*{${title}}`, ...lines];
}
function itemize(items: string[]): string[] {
  return ["\\begin{itemize}", ...items.map((i) => `  \\item ${i}`), "\\end{itemize}"];
}

/** A foreign TikZ fragment: no dangerous commands and no closing the document. */
function isSafeTikz(tikz: string): boolean {
  return !FORBIDDEN_TEX.test(tikz) && !/\\(?:begin|end)\s*\{document\}/.test(tikz);
}

/** "Concept map" section if the TikZ fits, is safe and is requested; otherwise the notice goes to `omitted`. */
function mapSection(tikz: string | undefined, includeTikz: boolean, omitted: string[]): string[] {
  if (!tikz) return [];
  if (!includeTikz) omitted.push(TIKZ_REMOVED_NOTICE);
  else if (tikz.length > TIKZ_FRAGMENT_MAX_CHARS)
    omitted.push(`The concept map (TikZ) exceeds ${TIKZ_FRAGMENT_MAX_CHARS} characters and was not included.`);
  else if (!isSafeTikz(tikz)) omitted.push("The concept map (TikZ) uses commands that are not allowed and was not included.");
  else return section("Concept map", ["\\begin{center}", tikz, "", "\\smallskip", LEGEND, "\\end{center}"]);
  return [];
}

function omittedSection(omitted: string[]): string[] {
  return omitted.length ? section("What could not be included", itemize(omitted.map(esc))) : [];
}

/**
 * Fills a template in a single pass (inserted text is not re-interpreted). The template's comment
 * lines are removed: they describe the placeholders and must not be filled.
 */
function fillTemplate(name: string, values: Record<string, string>): string {
  const tpl = readFileSync(join(TEMPLATES_DIR, name), "utf8")
    .split("\n")
    .filter((l) => !l.startsWith("%"))
    .join("\n");
  return tpl.replace(/<<([A-Z_]+)>>/g, (m, key: string) => {
    const v = values[key];
    if (v === undefined) throw new Error(`Template ${name} has a placeholder without a value: ${m}`);
    return v;
  });
}

/**
 * Fills templates/session.tex (placeholders `<<TITLE>> <<SUBJECT>> <<DATE>> <<BODY>>`).
 * Sections (`\section*`), only those with content: "Summary", "Concepts covered",
 * "Questions", "Practices", "Errors and corrections", "Declarations", "Cards created",
 * "Review material", "Verified formulas", "Concept map", "Next recommendation",
 * and "What could not be included" if `omitted` is not empty.
 */
export function renderSessionTex(data: SessionReportData, opts: RenderOptions = {}): RenderResult {
  const omitted: string[] = [];
  const body: string[] = [];
  const when = (cond: boolean, title: string, lines: () => string[]) => {
    if (cond) body.push(...section(title, lines()));
  };

  when(Boolean(data.llm.summary.trim()), "Summary", () => [blockMath(data.llm.summary)]);
  when(data.concepts.length > 0, "Concepts covered", () =>
    itemize(data.concepts.map((c) => `${esc(c.name)}: ${STATE_LABEL[c.before]} $\\to$ ${STATE_LABEL[c.after]}`)),
  );
  when(data.questions.length > 0, "Questions", () =>
    itemize(data.questions.map((q) => `${inlineMath(q.text)} --- \\textbf{${q.correct ? "correct" : "incorrect"}}`)),
  );
  when(data.practices.length > 0, "Practices", () =>
    itemize(data.practices.map((p) => `${esc(p.title)}: \\textbf{${VERDICT_LABEL[p.verdict]}}`)),
  );
  when(data.errors.length > 0 || Boolean(data.llm.errors.trim()), "Errors and corrections", () => [
    ...(data.errors.length
      ? itemize(data.errors.map((e) => (e.correction.trim() ? `${inlineMath(e.summary)}\\par\\textit{${inlineMath(e.correction)}}` : inlineMath(e.summary))))
      : []),
    blockMath(data.llm.errors),
  ]);
  when(data.declarations.length > 0, "Declarations", () =>
    itemize(data.declarations.map((d) => `${esc(d.conceptName)}: ${d.status === "confirmed" ? "confirmed" : "refuted"}`)),
  );
  when(data.cardsCreated > 0, "Cards created", () => [
    `${data.cardsCreated === 1 ? "1 card has been created" : `${data.cardsCreated} cards have been created`} for review.`,
  ]);
  when(Boolean(data.llm.review.trim()), "Review material", () => [blockMath(data.llm.review)]);

  const formulas = data.formulas.filter((f) => {
    if (isSafeMath(f.expression)) return true;
    omitted.push(`The formula "${oneLine(f.label)}" uses commands that are not allowed and was not included.`);
    return false;
  });
  when(formulas.length > 0, "Verified formulas", () => formulas.map((f) => `${esc(f.label)}: \\[ ${f.expression} \\]`));
  body.push(...mapSection(data.tikz, opts.includeTikz ?? true, omitted));
  when(data.recommendation.length > 0, "Next recommendation", () =>
    itemize(data.recommendation.map((r) => `${esc(r.conceptName)} (${STATE_LABEL[r.state]})`)),
  );
  body.push(...omittedSection(omitted));

  const tex = fillTemplate("session.tex", {
    TITLE: esc(data.title),
    SUBJECT: esc(data.subject),
    DATE: esc(data.date),
    BODY: body.join("\n"),
  });
  return { tex, omitted };
}

/**
 * Fills templates/master.tex. Sections: "Review frontier", "Weak concepts",
 * "Concepts to review", "Recurring errors", "Consolidated concepts", "Upcoming exams"
 * (with P(prepared) in %), "Concept map", and "What could not be included".
 */
export function renderMasterTex(data: MasterReportData, opts: RenderOptions = {}): RenderResult {
  const omitted: string[] = [];
  const list = (items: string[], empty: string) => (items.length ? itemize(items) : [empty]);
  const body = [
    ...section("Review frontier", list(data.reviewFrontier.map((c) => `${esc(c.name)} (${STATE_LABEL[c.state]})`), "Nothing to review right now.")),
    ...section("Weak concepts", list(data.weak.map((c) => `${esc(c.name)} --- ${pct(c.probability)}`), "None.")),
    ...section("Concepts to review", list(data.toReview.map((c) => `${esc(c.name)} --- ${pct(c.probability)}`), "None.")),
    ...section(
      "Recurring errors",
      list(
        data.recurringErrors.map((e) => `${esc(e.template)}: ${esc(e.error)} --- ${e.timesSeen} ${e.timesSeen === 1 ? "time" : "times"}`),
        "None.",
      ),
    ),
    ...section("Consolidated concepts", [data.consolidated.length ? `${data.consolidated.map(esc).join(", ")}.` : "None yet."]),
    ...section(
      "Upcoming exams",
      list(
        data.exams.map(
          (e) =>
            `${esc(e.title)}: ${esc(e.date)} (${e.daysLeft === 1 ? "1 day left" : `${e.daysLeft} days left`}) --- P(prepared) ${pct(e.preparedProbability)}`,
        ),
        "No upcoming exams.",
      ),
    ),
    ...mapSection(data.tikz, opts.includeTikz ?? true, omitted),
  ];
  body.push(...omittedSection(omitted));
  const tex = fillTemplate("master.tex", { SUBJECT: esc(data.subject), DATE: esc(data.date), BODY: body.join("\n") });
  return { tex, omitted };
}
