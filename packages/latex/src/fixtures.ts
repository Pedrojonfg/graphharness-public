import type { MasterReportData, SessionReportData } from "./types.ts";

export const sessionData: SessionReportData = {
  title: "Derivatives session",
  subject: "Calculus I",
  date: "November 9, 2026",
  concepts: [
    { name: "Chain rule", before: "weak", after: "review" },
    { name: "Limits", before: "unknown", after: "solid" },
  ],
  questions: [
    { text: "What is the derivative of $x^2$ at 50%?", correct: true },
    { text: "Failed question", correct: false },
  ],
  practices: [{ title: "Differentiate composites", verdict: "partial" }],
  errors: [{ summary: "You forgot the inner derivative", correction: "Apply $f'(g(x))\\,g'(x)$" }],
  declarations: [{ conceptName: "Limits", status: "confirmed" }],
  cardsCreated: 4,
  recommendation: [{ conceptName: "Integrals", state: "weak" }],
  llm: { summary: "You reviewed $x^2$ and the chain rule.", review: "Worked example: $(x^2)'=2x$.", errors: "Error with a_b corrected." },
  formulas: [{ label: "Power rule derivative", expression: "\\frac{d}{dx}x^n = n x^{n-1}" }],
};

export const sessionTikz = "\\begin{tikzpicture}\n\\node[draw] (n0) at (0,0) {Limits};\n\\end{tikzpicture}";

export const masterData: MasterReportData = {
  subject: "Calculus I",
  date: "November 9, 2026",
  reviewFrontier: [{ name: "Chain rule", state: "review" }],
  weak: [{ name: "Integrals", probability: 0.21 }],
  toReview: [{ name: "Derivatives", probability: 0.55 }],
  recurringErrors: [{ template: "Differentiate composites", error: "Forgets the inner derivative", timesSeen: 3 }],
  consolidated: ["Limits", "Continuity"],
  exams: [{ title: "Midterm 1", date: "2026-11-20", daysLeft: 11, preparedProbability: 0.62 }],
};
