// Deterministic daily brief (ADR 102 §9; GET /brief and MCP `get_daily_brief`) and the pieces it shares
// with the subject overview: exam view with P(prepared) and recurring errors.
import {
  daysUntil,
  dependentsCount,
  goalPreparedProbability,
  isDue,
  SUGGESTED_STATE_LABEL,
  suggestedKind,
  suggestedTodayPriority,
  whenLabel,
  type ConceptEdge as CoreEdge,
} from "@graphharness/core";
import { SessionReportDataSchema, type DailyBrief, type Exam } from "@graphharness/contracts";
import type { Db } from "@graphharness/db";
import type { HubContext } from "./context.ts";
import { effectiveStates } from "./evidence.ts";

export interface ExamRow {
  id: string;
  subject_id: string;
  title: string;
  date: string;
  scope_concept_ids_json: string;
  notes: string | null;
  created_at: string;
}

const DAY_MS = 86_400_000;
/** The brief's "Exams soon": from today to 30 days ahead. */
const EXAMS_SOON_DAYS = 30;
const WEAKEST_LIMIT = 5;
const RECURRING_LIMIT = 5;
const SUGGESTED_CONCEPTS = 6;

export const parseIds = (raw: string): string[] => {
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return []; // corrupt scope = the whole subject
  }
};

/** Scope of an exam: its concepts, or all active concepts of the subject if empty. */
export function examScope(db: Db, exam: Pick<ExamRow, "subject_id" | "scope_concept_ids_json">): string[] {
  const ids = parseIds(exam.scope_concept_ids_json);
  if (ids.length) return ids;
  return db.prepare("SELECT id FROM concepts WHERE subject_id = ? AND status = 'active' ORDER BY id").pluck().all(exam.subject_id) as string[];
}

/** Exam in the contracts shape, with P(prepared) (`goalPreparedProbability`) and the number of `unknown` concepts at `now`. */
export function examViews(ctx: HubContext, rows: readonly ExamRow[], now: Date): Exam[] {
  const subjectName = ctx.db.prepare("SELECT name FROM subjects WHERE id = ?").pluck();
  return rows.map((r) => {
    const scope = examScope(ctx.db, r);
    const states = effectiveStates(ctx.db, now, scope);
    const probs = new Map<string, number>();
    for (const [id, s] of states) if (s.probability !== null) probs.set(id, s.probability);
    return {
      id: r.id,
      subjectId: r.subject_id,
      subjectName: (subjectName.get(r.subject_id) as string | undefined) ?? "",
      title: r.title,
      date: r.date,
      scopeConceptIds: parseIds(r.scope_concept_ids_json),
      notes: r.notes,
      createdAt: r.created_at,
      daysLeft: daysUntil(r.date, now),
      preparedProbability: goalPreparedProbability(scope, probs),
      unknownCount: [...states.values()].filter((s) => s.state === "unknown").length,
    };
  });
}

/** Template errors of active concepts, from most to least seen. */
export function recurringErrorRows(db: Db, opts: { subjectId?: string; minTimesSeen: number; limit: number }) {
  return db
    .prepare(
      `SELECT t.id AS templateId, t.name AS templateName, e.key, e.description, e.times_seen AS timesSeen
       FROM template_errors e JOIN templates t ON t.id = e.template_id JOIN concepts c ON c.id = t.concept_id
       LEFT JOIN subjects s ON s.id = c.subject_id
       WHERE e.times_seen >= ? AND c.status = 'active' AND (? IS NULL OR c.subject_id = ?) AND s.archived_at IS NULL
       ORDER BY e.times_seen DESC, e.last_seen_at DESC, e.id LIMIT ?`,
    )
    .all(opts.minTimesSeen, opts.subjectId ?? null, opts.subjectId ?? null, opts.limit) as {
    templateId: string;
    templateName: string;
    key: string;
    description: string;
    timesSeen: number;
  }[];
}

/** The first ≤ 3 sentences of a text. */
export function firstSentences(text: string, max = 3): string {
  const sentences = text.trim().replace(/\s+/g, " ").match(/[^.!?…]+(?:[.!?…]+|$)/g) ?? [];
  return sentences
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, max)
    .join(" ");
}

const KIND_LABEL = { session: "LH session on", cards: "Review cards of", exercises: "Exercises on" } as const;

/** Daily brief. `date` (YYYY-MM-DD, UTC) defaults to today; for another day, states are computed at noon of that day. */
export function dailyBrief(ctx: HubContext, date?: string): DailyBrief {
  const db = ctx.db;
  const realNow = ctx.now();
  const today = realNow.toISOString().slice(0, 10);
  const day = date ?? today;
  const now = day === today ? realNow : new Date(`${day}T12:00:00.000Z`);
  const yesterday = new Date(Date.parse(`${day}T00:00:00.000Z`) - DAY_MS).toISOString().slice(0, 10);

  // Active concepts outside archived subjects.
  const concepts = db
    .prepare(
      `SELECT c.id, c.name, c.subject_id, s.name AS subject FROM concepts c LEFT JOIN subjects s ON s.id = c.subject_id
       WHERE c.status = 'active' AND s.archived_at IS NULL ORDER BY c.id`,
    )
    .all() as { id: string; name: string; subject_id: string | null; subject: string | null }[];
  const states = effectiveStates(db, now, concepts.map((c) => c.id));

  // Exams of non-archived subjects, from today onwards.
  const examRows = db
    .prepare(
      `SELECT e.* FROM exams e JOIN subjects s ON s.id = e.subject_id
       WHERE s.archived_at IS NULL AND e.date >= ? ORDER BY e.date, e.id`,
    )
    .all(day) as ExamRow[];
  const exams = examViews(ctx, examRows, now);
  const examsSoon = exams
    .filter((e) => e.daysLeft >= 0 && e.daysLeft <= EXAMS_SOON_DAYS)
    .map((e) => ({ title: e.title, subject: e.subjectName, date: e.date, daysLeft: e.daysLeft, preparedProbability: e.preparedProbability, unknownCount: e.unknownCount }));

  // Cards: the review cards that are due + the pending confirmation ones (which go first).
  const cards = db.prepare("SELECT purpose, ease, interval_days, repetitions, t_ref, reviewed FROM cards WHERE retired = 0").all() as {
    purpose: "review" | "confirmation";
    ease: number;
    interval_days: number;
    repetitions: number;
    t_ref: number;
    reviewed: number;
  }[];
  const confirmationPending = cards.filter((c) => c.purpose === "confirmation").length;
  const dueReview = cards.filter(
    (c) =>
      c.purpose === "review" &&
      isDue({ ease: c.ease, intervalDays: c.interval_days, repetitions: c.repetitions, tRef: c.t_ref, reviewed: c.reviewed === 1 }, now.getTime()),
  ).length;

  // Weakest: with evidence and not solid (or aged solid), from lowest to highest P'.
  const weakest = concepts
    .map((c) => ({ c, s: states.get(c.id)! }))
    .filter(({ s }) => s.probability !== null && (s.state !== "solid" || s.stale))
    .sort((a, b) => a.s.probability! - b.s.probability! || (a.c.id < b.c.id ? -1 : 1))
    .slice(0, WEAKEST_LIMIT)
    .map(({ c, s }) => ({ conceptId: c.id, name: c.name, subject: c.subject, state: s.state, probability: s.probability, stale: s.stale, lastEvidenceAt: s.updatedAt }));

  // Yesterday's sessions (UTC day): last turn or close yesterday, or yesterday's evidence with that chatId.
  const chatIds = db
    .prepare(
      `SELECT chat_id FROM lh_sessions WHERE substr(last_turn_settled_at, 1, 10) = @y OR substr(closed_at, 1, 10) = @y
       UNION SELECT DISTINCT json_extract(ref_json, '$.chatId') FROM evidence_events
         WHERE substr(at, 1, 10) = @y AND json_extract(ref_json, '$.chatId') IS NOT NULL`,
    )
    .pluck()
    .all({ y: yesterday }) as string[];
  const sessionRow = db.prepare("SELECT chat_id, title FROM lh_sessions WHERE chat_id = ?");
  const touched = db.prepare(
    `SELECT DISTINCT c.id AS conceptId, c.name FROM evidence_events ev JOIN concepts c ON c.id = ev.concept_id
     WHERE json_extract(ev.ref_json, '$.chatId') = ? ORDER BY c.name, c.id`,
  );
  const lastReport = db.prepare("SELECT data_json FROM reports WHERE kind = 'session' AND chat_id = ? ORDER BY created_at DESC, id DESC LIMIT 1").pluck();
  const yesterdaySessions = chatIds
    .map((id) => sessionRow.get(id) as { chat_id: string; title: string } | undefined)
    .filter((s): s is { chat_id: string; title: string } => s !== undefined)
    .sort((a, b) => (a.chat_id < b.chat_id ? -1 : 1))
    .map((s) => {
      const raw = lastReport.get(s.chat_id) as string | undefined;
      let highlights: string | null = null;
      if (raw) {
        const parsed = SessionReportDataSchema.safeParse(JSON.parse(raw));
        const summary = parsed.success ? parsed.data.text?.summary : undefined;
        highlights = summary ? firstSentences(summary) || null : null;
      }
      return { chatId: s.chat_id, title: s.title, conceptsTouched: touched.all(s.chat_id) as { conceptId: string; name: string }[], highlights };
    });

  const recurringErrors = recurringErrorRows(db, { minTimesSeen: 2, limit: RECURRING_LIMIT }).map((r) => ({
    template: r.templateName,
    error: r.description,
    timesSeen: r.timesSeen,
  }));

  return {
    date: day,
    examsSoon,
    dueCards: { count: dueReview + confirmationPending, confirmationPending },
    weakest,
    yesterday: yesterdaySessions,
    recurringErrors,
    suggestedToday: suggestedToday(ctx, { concepts, states, exams }),
  };
}

/**
 * ADR 102 §9: priority = exam proximity × (1 − P') × (1 + dependents in scope), no LLM.
 * Scope: that of the nearest exam that includes the concept; without an exam, its subject. The first 6 are grouped
 * by what to do: with an active template → exercises; with cards → cards; otherwise → LH session.
 */
function suggestedToday(
  ctx: HubContext,
  input: {
    concepts: { id: string; name: string; subject_id: string | null }[];
    states: ReturnType<typeof effectiveStates>;
    exams: Exam[];
  },
): DailyBrief["suggestedToday"] {
  const db = ctx.db;
  const edges = graphEdges(db);
  const examScopes = input.exams.map((e) => ({ exam: e, scope: new Set(examScope(db, { subject_id: e.subjectId, scope_concept_ids_json: JSON.stringify(e.scopeConceptIds) })) }));
  const bySubject = new Map<string | null, Set<string>>();
  for (const c of input.concepts) {
    if (!bySubject.has(c.subject_id)) bySubject.set(c.subject_id, new Set());
    bySubject.get(c.subject_id)!.add(c.id);
  }
  const kindFlags = suggestedKindFlags(db);

  const ranked = input.concepts
    .map((c) => {
      const s = input.states.get(c.id)!;
      if (s.state === "solid" && !s.stale) return null;
      const near = examScopes.filter((x) => x.scope.has(c.id) && x.exam.daysLeft >= 0).sort((a, b) => a.exam.daysLeft - b.exam.daysLeft)[0];
      const scope = near?.scope ?? bySubject.get(c.subject_id)!;
      const dependents = dependentsCount(c.id, edges, scope);
      const priority = suggestedTodayPriority({ daysToExam: near?.exam.daysLeft ?? null, effectiveProbability: s.probability, dependentsInScope: dependents });
      return { c, s, near: near?.exam ?? null, dependents, priority };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null && x.priority > 0)
    .sort((a, b) => b.priority - a.priority || (a.c.id < b.c.id ? -1 : 1))
    .slice(0, SUGGESTED_CONCEPTS);

  const groups = new Map<"session" | "cards" | "exercises", typeof ranked>();
  for (const x of ranked) {
    const kind = suggestedKind(kindFlags(x.c.id));
    if (!groups.has(kind)) groups.set(kind, []);
    groups.get(kind)!.push(x);
  }
  return [...groups].map(([kind, items]) => {
    const why = items
      .map((x) => {
        const parts: string[] = [SUGGESTED_STATE_LABEL[x.s.state]];
        if (x.near) parts.push(`exam "${x.near.title}" ${whenLabel(x.near.daysLeft)}`);
        if (x.dependents > 0) parts.push(`${x.dependents} ${x.dependents === 1 ? "concept depends" : "concepts depend"} on it`);
        return `${x.c.name} (${parts.join("; ")})`;
      })
      .join(", ");
    return { kind, conceptIds: items.map((x) => x.c.id), why: `${KIND_LABEL[kind]}: ${why}.` };
  });
}

/** All edges of the graph, in core's shape. */
export function graphEdges(db: Db): CoreEdge[] {
  return (
    db.prepare("SELECT from_concept, to_concept, relation, confidence, removed FROM concept_edges").all() as {
      from_concept: string;
      to_concept: string;
      relation: "requires" | "illustrates";
      confidence: "high" | "medium" | "low";
      removed: number;
    }[]
  ).map((r) => ({ from: r.from_concept, to: r.to_concept, relation: r.relation, confidence: r.confidence, removed: r.removed === 1 }));
}

/** Input of `suggestedKind` for a concept: active template / non-retired review cards. */
export function suggestedKindFlags(db: Db): (conceptId: string) => { hasTemplate: boolean; hasCards: boolean } {
  const tpl = db.prepare("SELECT 1 FROM templates WHERE concept_id = ? AND status = 'active'");
  const cards = db.prepare("SELECT 1 FROM cards WHERE concept_id = ? AND retired = 0 AND purpose = 'review'");
  return (id) => ({ hasTemplate: tpl.get(id) !== undefined, hasCards: cards.get(id) !== undefined });
}
