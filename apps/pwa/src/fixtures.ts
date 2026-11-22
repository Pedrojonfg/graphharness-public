// Synthetic test data that satisfies the contracts (validated with the contracts schemas when used).
import {
  CardQueueSchema,
  PriorReportListSchema,
  PriorReportSchema,
  SubjectListSchema,
  SyllabusSchema,
  WeekPlanSchema,
  type Card,
  type CardQueue,
  type PriorReport,
  type PriorReportSummary,
  type Subject,
  type Syllabus,
  type WeekPlanView,
} from "@graphharness/contracts";

const schedule = { priority: 1.4, due: true, intervalDays: 3, repetitions: 2 };

export function cardText(over: Partial<Card> = {}): Card {
  return {
    id: "c_text",
    conceptId: "k1",
    conceptName: "Eigenvalues",
    kind: "text",
    purpose: "review",
    declarationId: null,
    front: { text: "What is $\\lambda$ called if $Av = \\lambda v$?", instance: null },
    options: null,
    answer: { text: "eigenvalue", accepted: ["characteristic value"] },
    schedule,
    sourceChatId: null,
    createdAt: "2026-11-01T10:00:00.000Z",
    ...over,
  };
}

export function cardMcq(over: Partial<Card> = {}): Card {
  return cardText({
    id: "c_mcq",
    kind: "mcq",
    front: { text: "Trace of $\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix}$", instance: null },
    options: [
      { id: "o1", value: "5" },
      { id: "o2", value: "-2" },
    ],
    answer: { optionId: "o1" },
    ...over,
  });
}

export function cardParsons(over: Partial<Card> = {}): Card {
  return cardText({
    id: "c_parsons",
    kind: "parsons",
    front: {
      text: "Order the program.",
      instance: null,
      parsons: {
        lines: [
          { id: "l0", text: "x = 1", indent: 0 },
          { id: "l1", text: "print(x)", indent: 0 },
          { id: "d0", text: "print(y)", indent: 0, distractor: true },
        ],
      },
    },
    answer: { order: ["l0", "l1"] },
    ...over,
  });
}

export function cardPredict(over: Partial<Card> = {}): Card {
  return cardText({
    id: "c_predict",
    kind: "predict",
    front: { text: "What does it print?", instance: null },
    answer: { text: "3", accepted: ["3.0"] },
    ...over,
  });
}

export function cardSpotBug(over: Partial<Card> = {}): Card {
  return cardText({
    id: "c_spot",
    kind: "spot_bug",
    front: {
      text: "Which line fails?",
      instance: null,
      parsons: {
        lines: [
          { id: "l0", text: "a = [1, 2]", indent: 0 },
          { id: "l1", text: "b = a", indent: 0 },
          { id: "l2", text: "b.append(3)", indent: 0 },
          { id: "l3", text: "print(len(a))", indent: 0 },
        ],
      },
    },
    answer: { lineId: "l1" },
    ...over,
  });
}

/** Confirmation item of a template with an open answer: no `answer`, the Hub grades it. */
export function cardInstanceConfirmation(): Card {
  return cardText({
    id: "c_conf",
    purpose: "confirmation",
    declarationId: "d1",
    front: {
      text: null,
      instance: { recipeVersion: 1, statement: "Compute $A^2$", answerKind: "matrix", shape: { rows: 2, cols: 2 }, variables: [], choices: null },
    },
    answer: null,
  });
}

export function queue(cards: Card[]): CardQueue {
  return CardQueueSchema.parse({
    cards,
    total: cards.length,
    dueCount: cards.length,
    confirmationPending: cards.filter((c) => c.purpose === "confirmation").length,
    nextOffset: null,
  });
}

/** Three-day plan starting Monday 9 November: one day with all three actions, one empty and one more. */
export function plan(over: Partial<WeekPlanView> = {}): WeekPlanView {
  return WeekPlanSchema.parse({
    from: "2026-11-09",
    days: [
      {
        date: "2026-11-09",
        items: [
          { conceptId: "k1", conceptName: "Eigenvalues", subjectId: "s1", kind: "cards", why: "3 cards due today" },
          { conceptId: "k2", conceptName: "Diagonalization", subjectId: "s1", kind: "exercises", why: "Exam in 5 days and it is weak" },
          { conceptId: "k3", conceptName: "Determinants", subjectId: "s1", kind: "session", why: "No record and it is a prerequisite" },
        ],
      },
      { date: "2026-11-10", items: [] },
      {
        date: "2026-11-11",
        items: [{ conceptId: "k4", conceptName: "Limits", subjectId: null, kind: "session", why: "You marked it as weak" }],
      },
    ],
    unscheduledCount: 3,
    ...over,
  });
}

export function subjects(): Subject[] {
  const base = { kind: "computable_math", courseNotation: null, lhSourceFolder: null, createdAt: "2026-09-01T10:00:00.000Z", archivedAt: null };
  return SubjectListSchema.parse([
    { ...base, id: "s1", name: "Linear algebra", slug: "linear-algebra" },
    { ...base, id: "s2", name: "Calculus", slug: "calculus", kind: "general" },
  ]);
}

const summaryPrior: PriorReportSummary = {
  id: "p1",
  subjectId: "s1",
  paths: ["algebra/topic1.pdf", "algebra/topic2.pdf"],
  createdAt: "2026-11-12T09:30:00.000Z",
  total: 10,
  counts: { known: 7, stale: 2, weak: 0, new: 1 },
  percentages: { known: 70, stale: 20, weak: 0, new: 10 },
};

/** Two reports: one with no "weak" (0 %) and one with only "weak" and "new". */
export function priorReports(): { reports: PriorReportSummary[] } {
  return PriorReportListSchema.parse({
    reports: [
      summaryPrior,
      {
        ...summaryPrior,
        id: "p2",
        paths: ["calculus/a.pdf", "calculus/b.pdf", "calculus/c.pdf"],
        createdAt: "2026-11-05T09:30:00.000Z",
        total: 4,
        counts: { known: 0, stale: 0, weak: 2, new: 2 },
        percentages: { known: 0, stale: 0, weak: 50, new: 50 },
      },
    ],
  });
}

/** Full report of 5 propositions: 3 known, 1 stale, 0 weak, 1 new. */
export function priorReport(over: Partial<PriorReport> = {}): PriorReport {
  const item = (propositionId: string, name: string, bucket: string, matched: [string, string] | null) => ({
    propositionId,
    name,
    bucket,
    relation: matched ? "same" : "new",
    matchedConceptId: matched?.[0] ?? null,
    matchedConceptName: matched?.[1] ?? null,
  });
  return PriorReportSchema.parse({
    ...summaryPrior,
    total: 5,
    counts: { known: 3, stale: 1, weak: 0, new: 1 },
    percentages: { known: 60, stale: 20, weak: 0, new: 20 },
    items: [
      item("q1", "Eigenvalue definition", "known", ["k1", "Eigenvalues"]),
      item("q2", "Characteristic polynomial", "known", ["k5", "Characteristic polynomial"]),
      item("q3", "Trace and determinant", "known", ["k3", "Determinants"]),
      item("q4", "Diagonalizable matrix", "stale", ["k2", "Diagonalization"]),
      item("q5", "Jordan canonical form", "new", null),
    ],
    ...over,
  });
}

/** Linear algebra syllabus: two topics seen (one nested) and one not seen. */
export function syllabus(): Syllabus {
  return SyllabusSchema.parse({
    items: [
      { id: "t1", position: 0, level: 0, title: "Vector spaces", seen: true, conceptId: "k6", conceptName: "Vector space", state: "solid", stale: false },
      { id: "t2", position: 1, level: 1, title: "Bases and dimension", seen: true, conceptId: "k7", conceptName: "Basis", state: "review", stale: true },
      { id: "t3", position: 2, level: 0, title: "Jordan form", seen: false, conceptId: null, conceptName: null, state: null, stale: null },
    ],
  });
}

/** Fake fetch: `handler` receives method and URL and returns [status, body]. It records the calls. */
export function fakeFetch(handler: (method: string, url: string, body: unknown) => [number, unknown]) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  const fn = async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body });
    const [status, json] = handler(method, url, body);
    return new Response(status === 204 ? null : JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
  };
  return { fn: fn as typeof fetch, calls };
}
