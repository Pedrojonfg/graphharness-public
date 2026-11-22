// Session reports and master document (D11, GL-019/029/058) and their on-demand PDF.
// splitEquation/verifyFormula ported from graphlearn/packages/llm/src/explain.ts (65b56d6).
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  daysUntil,
  dependentsCount,
  effectiveState,
  isoNow,
  rebuildState,
  ulid,
  type ConceptEdge,
  type ConceptState,
} from "@graphharness/core";
import {
  EvidenceSourceSchema,
  type MasterReport,
  type MasterReportData,
  type RenderReportResponse,
  type Report,
  type ReportListQuery,
  type ReportSummary,
  type SessionReport,
  type SessionReportData,
} from "@graphharness/contracts";
import type { Db } from "@graphharness/db";
import {
  compileWithFallback,
  graphTikz,
  renderMasterTex,
  renderSessionTex,
  type MasterReportData as MasterTexData,
  type RenderOptions,
  type RenderResult,
  type SessionReportData as SessionTexData,
} from "@graphharness/latex";
import { extractSessionItems } from "@graphharness/lh-client";
import { fillPrompt, loadPrompt } from "@graphharness/llm";
import { z } from "zod";
import { HubError, notFound } from "../errors.ts";
import type { HubContext } from "./context.ts";
import { conceptEvents, effectiveStates } from "./evidence.ts";
import { examPreparation } from "./exams.ts";

type OmittedSection = { sectionKey: string; reason: string };

// ---------------------------------------------------------------- formulas (verification with eval)

/** Splits an equality "a = b = c" into its members (outside braces). */
export function splitEquation(latex: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < latex.length; i++) {
    const ch = latex[i]!;
    if (ch === "{") depth++;
    if (ch === "}") depth--;
    // An "=" that is not part of \leq, \geq, \neq… (those carry no "="), nor of "==".
    if (ch === "=" && depth === 0 && latex[i + 1] !== "=") {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur.trim());
  return out.filter((p) => p.length > 0);
}

/** A member that is just a name (c_{11}, \det A, x') is not checked: the rest is verified. */
const isName = (s: string) => /^(\\[a-zA-Z]+\s*)?[a-zA-Z](_\{?[\w,]+\}?)?('|\^\{?\\prime\}?)?(\s*\\?[a-zA-Z]+)?$/.test(s.trim());

/** All checkable equalities must be true according to eval, and at least one. `verify` null = could not be read. */
export async function verifyFormula(latex: string, verify: (left: string, right: string) => Promise<boolean | null>): Promise<boolean> {
  const members = splitEquation(latex);
  if (members.length < 2) return false;
  const start = isName(members[0]!) ? 1 : 0;
  const checkable = members.slice(start);
  if (checkable.length < 2) return false;
  for (let i = 0; i + 1 < checkable.length; i++) {
    if ((await verify(checkable[i]!, checkable[i + 1]!)) !== true) return false;
  }
  return true;
}

// ---------------------------------------------------------------- common utilities

function loadEdges(db: Db): ConceptEdge[] {
  return (
    db.prepare("SELECT from_concept, to_concept, relation, confidence, removed FROM concept_edges").all() as {
      from_concept: string;
      to_concept: string;
      relation: ConceptEdge["relation"];
      confidence: ConceptEdge["confidence"];
      removed: number;
    }[]
  ).map((e) => ({ from: e.from_concept, to: e.to_concept, relation: e.relation, confidence: e.confidence, removed: e.removed === 1 }));
}

/** TikZ graph of some concepts with their state and the (non-removed) `requires` edges between them. */
function conceptsTikz(db: Db, nodes: { id: string; name: string; state: ConceptState }[]): string | undefined {
  if (nodes.length === 0) return undefined;
  const ids = new Set(nodes.map((n) => n.id));
  const edges = loadEdges(db)
    .filter((e) => e.relation === "requires" && !e.removed && ids.has(e.from) && ids.has(e.to))
    .map((e) => ({ from: e.from, to: e.to }));
  return graphTikz({ nodes, edges });
}

const displayDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Madrid" });

/** Warnings from `@graphharness/latex` → the contract's omitted sections. */
function latexOmitted(reasons: string[]): OmittedSection[] {
  return reasons.map((reason) => ({ sectionKey: /TikZ/.test(reason) ? "tikz" : /formula/i.test(reason) ? "formula" : "latex", reason }));
}

/** Omissions that do not come from the render (formulas eval did not verify): kept when compiling. */
const DATA_OMISSION_KEY = "formula_unverified";

interface ReportRow {
  id: string;
  kind: "session" | "master";
  chat_id: string | null;
  subject_id: string | null;
  data_json: string;
  tex: string | null;
  pdf_path: string | null;
  omitted_json: string;
  created_at: string;
}

/** One report per session and one per subject: regenerating updates the row (and the previous PDF stops being valid). */
function saveReport(
  ctx: HubContext,
  r: { kind: "session" | "master"; chatId: string | null; subjectId: string | null; data: unknown; tex: string; omitted: OmittedSection[] },
): string {
  return ctx.db.transaction(() => {
    const existing = (
      r.kind === "session"
        ? ctx.db.prepare("SELECT id FROM reports WHERE kind = 'session' AND chat_id = ? ORDER BY created_at DESC LIMIT 1").pluck().get(r.chatId)
        : ctx.db.prepare("SELECT id FROM reports WHERE kind = 'master' AND subject_id = ? ORDER BY created_at DESC LIMIT 1").pluck().get(r.subjectId)
    ) as string | undefined;
    const now = isoNow(ctx.now());
    if (existing) {
      ctx.db
        .prepare("UPDATE reports SET subject_id = ?, data_json = ?, tex = ?, pdf_path = NULL, omitted_json = ?, created_at = ? WHERE id = ?")
        .run(r.subjectId, JSON.stringify(r.data), r.tex, JSON.stringify(r.omitted), now, existing);
      return existing;
    }
    const id = ulid(ctx.now().getTime());
    ctx.db
      .prepare("INSERT INTO reports (id, kind, chat_id, subject_id, data_json, tex, pdf_path, omitted_json, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)")
      .run(id, r.kind, r.chatId, r.subjectId, JSON.stringify(r.data), r.tex, JSON.stringify(r.omitted), now);
    return id;
  })();
}

// ---------------------------------------------------------------- session report

const SessionTextSchema = z.object({
  summary: z.string().min(1).max(8000),
  reviewMaterial: z.array(z.object({ title: z.string().min(1).max(300), body: z.string().min(1).max(8000) })).max(10).default([]),
  mistakes: z.array(z.object({ mistake: z.string().min(1).max(2000), correction: z.string().min(1).max(4000) })).max(15).default([]),
  formulas: z.array(z.object({ label: z.string().min(1).max(200), latex: z.string().min(1).max(600) })).max(12).default([]),
});

/** Cap on the transcript sent to the LLM. it is cut at the end; normal sessions fit whole. */
const TRANSCRIPT_MAX_CHARS = 150_000;

const SOURCE_LABEL: Record<string, string> = {
  lh_quiz: "test",
  lh_probe: "probe",
  lh_recall: "free recall",
  lh_practice: "practice",
  hub_exercise: "exercise",
  hub_diagnostic: "diagnostic",
  flashcard: "card",
  declaration: "declaration",
  confirmation: "confirmation",
};
const PRACTICE_VERDICT = { solved: "correct", solvedWithHints: "partial" } as const;

interface SessionEventRow {
  concept_id: string;
  at: string;
  source: string;
  correct: number | null;
}

/** Data from code + LLM text. Also returns the discarded (unverified) formulas. */
export async function buildSessionReportData(ctx: HubContext, chatId: string): Promise<{ data: SessionReportData; omitted: OmittedSection[] }> {
  const db = ctx.db;
  const now = ctx.now();
  const session = db.prepare("SELECT title, subject_id FROM lh_sessions WHERE chat_id = ?").get(chatId) as { title: string; subject_id: string | null } | undefined;
  if (!session) throw notFound();
  const subjectName = session.subject_id
    ? ((db.prepare("SELECT name FROM subjects WHERE id = ?").pluck().get(session.subject_id) as string | undefined) ?? null)
    : null;

  const events = db
    .prepare(
      `SELECT concept_id, at, source, correct FROM evidence_events WHERE json_extract(ref_json, '$.chatId') = ? ORDER BY at, ingested_at, id`,
    )
    .all(chatId) as SessionEventRow[];
  const sessionStart = events[0]?.at ?? null;
  const closedAt = isoNow(now);

  // Concepts touched: with evidence from the session or with propositions born in it.
  const fromProps = db
    .prepare(
      `SELECT DISTINCT cp.concept_id FROM lh_propositions p
       JOIN concept_propositions cp ON cp.proposition_id = p.id, json_each(p.provenance_json) j
       WHERE json_extract(j.value, '$.chatId') = ?`,
    )
    .pluck()
    .all(chatId) as string[];
  const nameOf = new Map(
    (db.prepare("SELECT id, name FROM concepts").all() as { id: string; name: string }[]).map((c) => [c.id, c.name]),
  );
  const touchedIds = [...new Set([...events.map((e) => e.concept_id), ...fromProps])].filter((id) => nameOf.has(id));
  const after = effectiveStates(db, now, touchedIds);
  const beforeAt = sessionStart ?? closedAt;
  const conceptsTouched = touchedIds
    .map((id) => {
      const prior = conceptEvents(db, id).filter((e) => Date.parse(e.at) < Date.parse(beforeAt));
      const before = effectiveState(rebuildState(prior), new Date(beforeAt));
      const a = after.get(id)!;
      return {
        conceptId: id,
        name: nameOf.get(id)!,
        before: before.state,
        after: a.state,
        probabilityBefore: before.probability,
        probabilityAfter: a.probability,
      };
    })
    .sort((x, y) => x.name.localeCompare(y.name, "en"));

  // Questions: with a concept (evidence) and without one (unassigned_questions).
  const questions: SessionReportData["questions"] = events
    .filter((e) => e.source === "lh_quiz" || e.source === "lh_probe" || e.source === "lh_recall")
    .map((e) => ({ source: e.source as SessionReportData["questions"][number]["source"], conceptId: e.concept_id, correct: e.correct === null ? null : e.correct === 1, at: e.at }));
  for (const u of db.prepare("SELECT source, payload_json, created_at FROM unassigned_questions WHERE chat_id = ?").all(chatId) as {
    source: string;
    payload_json: string;
    created_at: string;
  }[]) {
    const source = EvidenceSourceSchema.safeParse(u.source);
    if (!source.success) continue;
    const p = JSON.parse(u.payload_json) as { correct?: unknown; at?: unknown };
    const correct = typeof p.correct === "boolean" ? p.correct : p.correct === 1 ? true : p.correct === 0 ? false : null;
    const at = typeof p.at === "string" && !Number.isNaN(Date.parse(p.at)) ? new Date(p.at).toISOString() : u.created_at;
    questions.push({ source: source.data, conceptId: null, correct, at });
  }
  questions.sort((a, b) => a.at.localeCompare(b.at));

  // Practices: outcome and verdict are only in LH's log (conclude arguments).
  const extraction = extractSessionItems(await ctx.lh.getChat(chatId));
  const conceptOfProp = db.prepare("SELECT concept_id FROM concept_propositions WHERE proposition_id = ?").pluck();
  const practices = extraction.practices
    .filter((p) => !p.dismissed)
    .map((p) => ({
      conceptIds: [...new Set(p.target.map((id) => conceptOfProp.get(id) as string | undefined).filter((c): c is string => c !== undefined))],
      outcome: p.outcome,
      verdict: p.verdict,
    }));

  // Template errors and declarations resolved during the session (between its first event and the close).
  const inList = touchedIds.map(() => "?").join(",");
  const errors =
    sessionStart && touchedIds.length
      ? (
          db
            .prepare(
              `SELECT te.template_id, te.key, te.description, count(*) AS n FROM attempts a
               JOIN template_errors te ON te.id = a.matched_error_id JOIN templates t ON t.id = te.template_id
               WHERE a.created_at >= ? AND a.created_at <= ? AND t.concept_id IN (${inList})
               GROUP BY te.id ORDER BY n DESC, te.key`,
            )
            .all(sessionStart, closedAt, ...touchedIds) as { template_id: string; key: string; description: string; n: number }[]
        ).map((e) => ({ templateId: e.template_id, errorKey: e.key, description: e.description, times: e.n }))
      : [];
  const declarations =
    sessionStart && touchedIds.length
      ? (
          db
            .prepare(
              `SELECT id, concept_id, target_state, status FROM declarations
               WHERE status IN ('confirmed','refuted') AND resolved_at >= ? AND resolved_at <= ? AND concept_id IN (${inList})
               ORDER BY resolved_at, id`,
            )
            .all(sessionStart, closedAt, ...touchedIds) as { id: string; concept_id: string; target_state: "solid" | "review" | "weak"; status: "confirmed" | "refuted" }[]
        ).map((d) => ({ declarationId: d.id, conceptId: d.concept_id, name: nameOf.get(d.concept_id)!, targetState: d.target_state, status: d.status }))
      : [];
  const cardsCreated = db.prepare("SELECT count(*) FROM cards WHERE source_chat_id = ?").pluck().get(chatId) as number;
  const nextRecommendation = recommendNext(ctx, session.subject_id);

  // Text (strong LLM) from LH's transcript; if it fails, the report keeps only the data.
  const omitted: OmittedSection[] = [];
  let text: SessionReportData["text"] = null;
  let verifiedFormulas: SessionReportData["verifiedFormulas"] = [];
  try {
    const transcript = (await ctx.lh.getChatMarkdown(chatId)).slice(0, TRANSCRIPT_MAX_CHARS);
    const prompt = loadPrompt("report-session");
    const res = await ctx.llm.complete({
      task: "report-session",
      tier: "strong",
      promptVersion: prompt.version,
      system: fillPrompt(prompt.text, {
        title: session.title,
        subject: subjectName ?? "no subject",
        concepts: conceptsTouched.map((c) => c.name).join(", ") || "(none)",
      }),
      messages: [{ role: "user", content: transcript }],
      jsonSchema: SessionTextSchema,
    });
    const out = SessionTextSchema.parse(res.json);
    text = { summary: out.summary, reviewMaterial: out.reviewMaterial, mistakes: out.mistakes };
    const verify = (l: string, r: string) => ctx.evalApi.verifyLatex(l, r).catch(() => null); // unreadable by eval = unverified
    for (const f of out.formulas) {
      const latex = f.latex.trim().replace(/^\$+|\$+$/g, "").trim();
      if (await verifyFormula(latex, verify)) verifiedFormulas.push({ label: f.label, latex });
      else omitted.push({ sectionKey: DATA_OMISSION_KEY, reason: `The formula "${f.label}" could not be verified and is not included.` });
    }
  } catch (err) {
    console.warn(`[reports] report of ${chatId} without LLM text:`, err);
    text = null;
    verifiedFormulas = [];
  }

  const data: SessionReportData = {
    schemaVersion: 1,
    chatId,
    title: session.title,
    subjectId: session.subject_id,
    subjectName,
    closedAt,
    conceptsTouched,
    questions,
    practices,
    errors,
    declarations,
    cardsCreated,
    nextRecommendation,
    text,
    verifiedFormulas,
  };
  return { data, omitted };
}

/** The 3 weak/review concepts of the subject (or of all, if the session has none) with the most dependents. */
export function recommendNext(ctx: HubContext, subjectId: string | null): SessionReportData["nextRecommendation"] {
  const concepts = (
    subjectId
      ? ctx.db.prepare("SELECT id, name FROM concepts WHERE subject_id = ? AND status = 'active'").all(subjectId)
      : ctx.db.prepare("SELECT id, name FROM concepts WHERE status = 'active'").all()
  ) as { id: string; name: string }[];
  const states = effectiveStates(ctx.db, ctx.now(), concepts.map((c) => c.id));
  const edges = loadEdges(ctx.db);
  return concepts
    .map((c) => ({ c, s: states.get(c.id)! }))
    .filter(({ s }) => s.state === "weak" || s.state === "review")
    .map(({ c, s }) => ({ conceptId: c.id, name: c.name, state: s.state, dependents: dependentsCount(c.id, edges), p: s.probability ?? 0.5 }))
    .sort((a, b) => b.dependents - a.dependents || a.p - b.p || a.name.localeCompare(b.name, "en"))
    .slice(0, 3)
    .map(({ p: _p, ...r }) => r);
}

function sessionTexInput(db: Db, data: SessionReportData, withTikz: boolean): SessionTexData {
  const nameOf = new Map(data.conceptsTouched.map((c) => [c.conceptId, c.name]));
  const conceptName = (id: string | null) => (id ? (nameOf.get(id) ?? (db.prepare("SELECT name FROM concepts WHERE id = ?").pluck().get(id) as string | undefined)) : undefined);
  const t = data.text;
  return {
    title: data.title,
    subject: data.subjectName ?? "No subject",
    date: displayDate(data.closedAt),
    concepts: data.conceptsTouched.map((c) => ({ name: c.name, before: c.before, after: c.after })),
    questions: data.questions
      .filter((q): q is typeof q & { correct: boolean } => q.correct !== null)
      .map((q) => ({ text: `${conceptName(q.conceptId) ?? "Question without a concept"} (${SOURCE_LABEL[q.source] ?? q.source})`, correct: q.correct })),
    practices: data.practices.map((p) => {
      const names = p.conceptIds.map((id) => conceptName(id) ?? id).join(", ") || "Problem without a concept";
      return {
        title: p.verdict ? `${names}. ${p.verdict}` : names,
        verdict: PRACTICE_VERDICT[p.outcome as keyof typeof PRACTICE_VERDICT] ?? "incorrect",
      };
    }),
    errors: data.errors.map((e) => ({ summary: `${e.description} (${e.times} ${e.times === 1 ? "time" : "times"})`, correction: "" })),
    declarations: data.declarations
      .filter((d): d is typeof d & { status: "confirmed" | "refuted" } => d.status === "confirmed" || d.status === "refuted")
      .map((d) => ({ conceptName: d.name, status: d.status })),
    cardsCreated: data.cardsCreated,
    recommendation: data.nextRecommendation.map((r) => ({ conceptName: r.name, state: r.state })),
    llm: {
      summary: t?.summary ?? "",
      review: (t?.reviewMaterial ?? []).map((r) => `${r.title}\n${r.body}`).join("\n"),
      errors: (t?.mistakes ?? []).map((m) => `${m.mistake}\nCorrection: ${m.correction}`).join("\n"),
    },
    formulas: data.verifiedFormulas.map((f) => ({ label: f.label, expression: f.latex })),
    tikz: withTikz ? conceptsTikz(db, data.conceptsTouched.map((c) => ({ id: c.conceptId, name: c.name, state: c.after }))) : undefined,
  };
}

/** Job `report-session`: data + text + .tex saved in `reports`. Does NOT compile. */
export async function generateSessionReport(ctx: HubContext, chatId: string): Promise<string> {
  const { data, omitted } = await buildSessionReportData(ctx, chatId);
  const rendered = renderSessionTex(sessionTexInput(ctx.db, data, true));
  return saveReport(ctx, {
    kind: "session",
    chatId,
    subjectId: data.subjectId,
    data,
    tex: rendered.tex,
    omitted: [...omitted, ...latexOmitted(rendered.omitted)],
  });
}

// ---------------------------------------------------------------- master document

export function buildMasterReportData(ctx: HubContext, subjectId: string): MasterReportData {
  const db = ctx.db;
  const now = ctx.now();
  const subject = db.prepare("SELECT name FROM subjects WHERE id = ?").get(subjectId) as { name: string } | undefined;
  if (!subject) throw notFound();
  const concepts = db.prepare("SELECT id, name FROM concepts WHERE subject_id = ? AND status = 'active' ORDER BY name, id").all(subjectId) as {
    id: string;
    name: string;
  }[];
  const states = effectiveStates(db, now, concepts.map((c) => c.id));
  const stateOf = (id: string) => states.get(id)?.state ?? effectiveStates(db, now, [id]).get(id)!.state;
  const prereqs = new Map<string, string[]>();
  for (const e of loadEdges(db)) {
    if (e.relation !== "requires" || e.removed || e.confidence === "low") continue;
    prereqs.set(e.to, [...(prereqs.get(e.to) ?? []), e.from]);
  }

  const reviewFrontier = concepts
    .filter((c) => states.get(c.id)!.state !== "solid" && (prereqs.get(c.id) ?? []).every((p) => stateOf(p) === "solid"))
    .map((c) => ({ conceptId: c.id, name: c.name, state: states.get(c.id)!.state }));
  const weakAndReview = concepts
    .map((c) => ({ c, s: states.get(c.id)! }))
    .filter(({ s }) => s.state === "weak" || s.state === "review")
    .sort((a, b) => (a.s.probability ?? 0) - (b.s.probability ?? 0))
    .map(({ c, s }) => ({ conceptId: c.id, name: c.name, state: s.state, probability: s.probability, stale: s.stale }));
  const recurringErrors = (
    db
      .prepare(
        `SELECT te.template_id, t.name AS template_name, te.key, te.description, te.times_seen, te.last_seen_at FROM template_errors te
         JOIN templates t ON t.id = te.template_id JOIN concepts c ON c.id = t.concept_id
         WHERE c.subject_id = ? AND te.times_seen >= 1 ORDER BY te.times_seen DESC, te.last_seen_at DESC LIMIT 10`,
      )
      .all(subjectId) as { template_id: string; template_name: string; key: string; description: string; times_seen: number; last_seen_at: string | null }[]
  ).map((e) => ({
    templateId: e.template_id,
    templateName: e.template_name,
    errorKey: e.key,
    description: e.description,
    timesSeen: e.times_seen,
    lastSeenAt: e.last_seen_at,
  }));
  const unpatternedFailures = db
    .prepare(
      `SELECT count(*) FROM unknown_errors ue JOIN templates t ON t.id = ue.template_id JOIN concepts c ON c.id = t.concept_id
       WHERE ue.status = 'open' AND c.subject_id = ?`,
    )
    .pluck()
    .get(subjectId) as number;
  const consolidated = concepts.filter((c) => states.get(c.id)!.state === "solid").map((c) => ({ conceptId: c.id, name: c.name }));
  const today = isoNow(now).slice(0, 10);
  const upcomingExams = (
    db.prepare("SELECT id, title, date, scope_concept_ids_json FROM exams WHERE subject_id = ? AND date >= ? ORDER BY date, id").all(subjectId, today) as {
      id: string;
      title: string;
      date: string;
      scope_concept_ids_json: string;
    }[]
  ).map((e) => ({
    examId: e.id,
    title: e.title,
    date: e.date,
    daysLeft: daysUntil(e.date, now),
    ...examPreparation(ctx, subjectId, JSON.parse(e.scope_concept_ids_json) as string[]),
  }));

  return {
    schemaVersion: 1,
    subjectId,
    subjectName: subject.name,
    generatedAt: isoNow(now),
    reviewFrontier,
    weakAndReview,
    recurringErrors,
    unpatternedFailures,
    consolidated,
    upcomingExams,
  };
}

function masterTexInput(db: Db, data: MasterReportData, withTikz: boolean): MasterTexData {
  const byState = (state: "weak" | "review") =>
    data.weakAndReview.filter((c) => c.state === state).map((c) => ({ name: c.name, probability: c.probability ?? 0 }));
  let tikz: string | undefined;
  if (withTikz) {
    const rows = db.prepare("SELECT id, name FROM concepts WHERE subject_id = ? AND status = 'active' ORDER BY name, id").all(data.subjectId) as {
      id: string;
      name: string;
    }[];
    const states = effectiveStates(db, new Date(data.generatedAt), rows.map((r) => r.id));
    tikz = conceptsTikz(db, rows.map((r) => ({ id: r.id, name: r.name, state: states.get(r.id)!.state })));
  }
  return {
    subject: data.subjectName,
    date: displayDate(data.generatedAt),
    reviewFrontier: data.reviewFrontier.map((c) => ({ name: c.name, state: c.state })),
    weak: byState("weak"),
    toReview: byState("review"),
    recurringErrors: data.recurringErrors.map((e) => ({ template: e.templateName, error: e.description || e.errorKey, timesSeen: e.timesSeen })),
    consolidated: data.consolidated.map((c) => c.name),
    // with no concepts with evidence in scope, P(prepared) is null; in the PDF it counts as 0 %.
    exams: data.upcomingExams.map((e) => ({ title: e.title, date: e.date, daysLeft: e.daysLeft, preparedProbability: e.preparedProbability ?? 0 })),
    tikz,
  };
}

/** Job `report-master`: recomputes the data and regenerates the .tex. Does NOT compile. */
export function generateMasterReport(ctx: HubContext, subjectId: string): string {
  const data = buildMasterReportData(ctx, subjectId);
  const rendered = renderMasterTex(masterTexInput(ctx.db, data, true));
  return saveReport(ctx, { kind: "master", chatId: null, subjectId, data, tex: rendered.tex, omitted: latexOmitted(rendered.omitted) });
}

// ---------------------------------------------------------------- reading (REST /reports, MCP get_session_report)

const masterTitle = (subjectName: string) => `Documento maestro: ${subjectName}`;

function toReport(row: ReportRow): Report {
  const base = { id: row.id, createdAt: row.created_at, hasPdf: row.pdf_path !== null, omitted: JSON.parse(row.omitted_json) as OmittedSection[] };
  if (row.kind === "session") {
    const data = JSON.parse(row.data_json) as SessionReportData;
    return { ...base, kind: "session", chatId: row.chat_id!, subjectId: row.subject_id, title: data.title, data } satisfies SessionReport;
  }
  const data = JSON.parse(row.data_json) as MasterReportData;
  return { ...base, kind: "master", chatId: null, subjectId: row.subject_id!, title: masterTitle(data.subjectName), data } satisfies MasterReport;
}

export function listReports(ctx: HubContext, q: ReportListQuery): ReportSummary[] {
  const where: string[] = [];
  const args: string[] = [];
  if (q.kind) {
    where.push("kind = ?");
    args.push(q.kind);
  }
  if (q.subjectId) {
    where.push("subject_id = ?");
    args.push(q.subjectId);
  }
  const rows = ctx.db
    .prepare(`SELECT * FROM reports ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id DESC`)
    .all(...args) as ReportRow[];
  return rows.map((row) => {
    const { data: _data, ...summary } = toReport(row);
    return summary as ReportSummary;
  });
}

function reportRow(ctx: HubContext, id: string): ReportRow {
  const row = ctx.db.prepare("SELECT * FROM reports WHERE id = ?").get(id) as ReportRow | undefined;
  if (!row) throw notFound();
  return row;
}

export function getReport(ctx: HubContext, id: string): Report {
  return toReport(reportRow(ctx, id));
}

/** MCP `get_session_report`: the chat's latest session report (data + summary, without .tex or PDF). */
export function getSessionReportByChat(ctx: HubContext, chatId: string): SessionReport {
  const row = ctx.db.prepare("SELECT * FROM reports WHERE kind = 'session' AND chat_id = ? ORDER BY created_at DESC, id DESC LIMIT 1").get(chatId) as
    | ReportRow
    | undefined;
  if (!row) throw notFound();
  return toReport(row) as SessionReport;
}

// ---------------------------------------------------------------- on-demand PDF

/**
 * POST /reports/:id/render and MCP `render_pdf`: compiles the stored .tex in `<reportsDir>/<id>/`; if it does not compile,
 * it regenerates it without TikZ (GL-058). 422 `latex_failed` if that fails too.
 */
export async function renderReport(ctx: HubContext, id: string): Promise<RenderReportResponse> {
  const row = reportRow(ctx, id);
  const stored = JSON.parse(row.omitted_json) as OmittedSection[];
  const kept = stored.filter((o) => o.sectionKey === DATA_OMISSION_KEY);
  const rebuild = (o: Required<RenderOptions>): RenderResult =>
    row.kind === "session"
      ? renderSessionTex(sessionTexInput(ctx.db, JSON.parse(row.data_json) as SessionReportData, o.includeTikz), o)
      : renderMasterTex(masterTexInput(ctx.db, JSON.parse(row.data_json) as MasterReportData, o.includeTikz), o);
  const build = (o: Required<RenderOptions>): RenderResult =>
    o.includeTikz && row.tex !== null
      ? { tex: row.tex, omitted: stored.filter((s) => s.sectionKey !== DATA_OMISSION_KEY).map((s) => s.reason) }
      : rebuild(o);
  const result = await compileWithFallback(build, {
    outDir: join(ctx.config.reportsDir, id),
    timeoutSec: ctx.config.tikzCompileTimeoutSec,
    retries: ctx.config.tikzCompileMaxRetries,
  });
  if (!result.ok || !result.pdfPath) {
    throw new HubError(422, {
      error: "latex_failed",
      message: result.timedOut ? "The PDF compilation exceeded the maximum time." : "The report does not compile, not even without the concept map.",
    });
  }
  const omitted = [...kept, ...latexOmitted(result.omitted)];
  ctx.db.prepare("UPDATE reports SET pdf_path = ?, omitted_json = ? WHERE id = ?").run(result.pdfPath, JSON.stringify(omitted), id);
  return { reportId: id, path: result.pdfPath, pdfUrl: `/api/v1/reports/${encodeURIComponent(id)}/pdf`, omitted };
}

/** GET /reports/:id/pdf: path of the compiled PDF; 409 `not_rendered` if there is none. */
export function reportPdfPath(ctx: HubContext, id: string): string {
  const row = reportRow(ctx, id);
  if (!row.pdf_path || !existsSync(row.pdf_path)) throw new HubError(409, { error: "not_rendered", message: "The PDF has not been generated yet." });
  return row.pdf_path;
}
