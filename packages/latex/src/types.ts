/** State of a concept (same set as `ConceptState` of @graphharness/core). */
export type ConceptState = "solid" | "review" | "weak" | "unknown";

/** A TikZ fragment larger than this is omitted with a notice (GL-058). */
export const TIKZ_FRAGMENT_MAX_CHARS = 8000;

export interface TikzGraph {
  nodes: { id: string; name: string; state: ConceptState }[];
  edges: { from: string; to: string }[];
}

/** Session report data. All text is plain text (escaped); `llm.*` and the questions accept `$…$`. */
export interface SessionReportData {
  title: string;
  subject: string;
  /** Date already formatted for display. */
  date: string;
  /** Concepts touched, with their state before and after the session. */
  concepts: { name: string; before: ConceptState; after: ConceptState }[];
  questions: { text: string; correct: boolean }[];
  practices: { title: string; verdict: "correct" | "partial" | "incorrect" }[];
  errors: { summary: string; correction: string }[];
  declarations: { conceptName: string; status: "confirmed" | "refuted" }[];
  cardsCreated: number;
  /** Next concepts to work on (weak/review with the most dependents). */
  recommendation: { conceptName: string; state: ConceptState }[];
  /** LLM text: (a) summary, (b) review material, (c) errors and corrections. With `$…$`. */
  llm: { summary: string; review: string; errors: string };
  /** Formulas verified by eval: math LaTeX WITHOUT the `$`. */
  formulas: { label: string; expression: string }[];
  /** Complete `\begin{tikzpicture}…\end{tikzpicture}` (e.g. from `graphTikz`). */
  tikz?: string;
}

/** Master report data. */
export interface MasterReportData {
  subject: string;
  date: string;
  /** Review frontier: concepts to review now. */
  reviewFrontier: { name: string; state: ConceptState }[];
  weak: { name: string; probability: number }[];
  toReview: { name: string; probability: number }[];
  recurringErrors: { template: string; error: string; timesSeen: number }[];
  consolidated: string[];
  /** Upcoming exams; `preparedProbability` in 0..1. */
  exams: { title: string; date: string; daysLeft: number; preparedProbability: number }[];
  tikz?: string;
}

export interface RenderOptions {
  /** false = omit the TikZ (GL-058 retry). Default true. */
  includeTikz?: boolean;
}

/** `omitted`: notices of what was not included. They also appear in the `.tex`. */
export interface RenderResult {
  tex: string;
  omitted: string[];
}

/** Minimal subset of a ChildProcess to run pdflatex (injectable in tests). */
export interface LatexChildLike {
  stdout: { on(event: "data", cb: (chunk: Buffer | string) => void): unknown };
  stderr: { on(event: "data", cb: (chunk: Buffer | string) => void): unknown };
  on(event: "close", cb: (code: number | null) => void): unknown;
  on(event: "error", cb: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals | number): unknown;
}
export type LatexSpawn = (command: string, args: string[], opts: { cwd: string }) => LatexChildLike;

export interface CompileOptions {
  /** Working directory; created if it does not exist. Writes `doc.tex` and produces `doc.pdf`. */
  outDir: string;
  /** Default 25. */
  timeoutSec?: number;
  /** Retries after a timeout (not after a LaTeX error). Default 2. */
  retries?: number;
  spawn?: LatexSpawn;
}

/** `ok` = pdflatex exited with code 0. `pdfPath` only if ok. */
export interface CompileResult {
  ok: boolean;
  pdfPath?: string;
  log: string;
  timedOut?: boolean;
}

export interface FallbackResult extends CompileResult {
  /** Notices from the render that was compiled, plus the TikZ one if it had to be removed. */
  omitted: string[];
}

/** ADR 108: isolated TikZ fragment → PDF (+ SVG if pdftocairo responds). */
export interface FragmentCompileOptions {
  outDir: string;
  libraries?: string[];
  timeoutSec?: number;
  retries?: number;
  spawn?: LatexSpawn;
  pdftocairo?: LatexSpawn;
}

export interface FragmentCompileResult {
  ok: boolean;
  log: string;
  pdfPath?: string;
  svgPath?: string;
  timedOut?: boolean;
}
