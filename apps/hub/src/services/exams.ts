// Exams (D12, `exams`, P(prepared); REST /exams, MCP upsert_exam/list_exams).
import { daysUntil, goalPreparedProbability, isoNow, ulid } from "@graphharness/core";
import type { CreateExamBody, Exam, ExamListQuery, PatchExamBody } from "@graphharness/contracts";
import type { Db } from "@graphharness/db";
import { notFound } from "../errors.ts";
import type { HubContext } from "./context.ts";
import { effectiveStates } from "./evidence.ts";

interface ExamRow {
  id: string;
  subject_id: string;
  subject_name: string;
  title: string;
  date: string;
  scope_concept_ids_json: string;
  notes: string | null;
  created_at: string;
}

const EXAM_SELECT = `SELECT e.*, s.name AS subject_name FROM exams e JOIN subjects s ON s.id = e.subject_id`;

/** Effective scope of an exam: the given concepts or, if empty, the subject's active ones. */
export function examScope(db: Db, subjectId: string, scopeConceptIds: readonly string[]): string[] {
  if (scopeConceptIds.length > 0) return [...scopeConceptIds];
  return db.prepare("SELECT id FROM concepts WHERE subject_id = ? AND status = 'active' ORDER BY id").pluck().all(subjectId) as string[];
}

/** `goalPreparedProbability` over the scope's effective P' + number of `unknown` concepts (separately). */
export function examPreparation(ctx: HubContext, subjectId: string, scopeConceptIds: readonly string[]): { preparedProbability: number | null; unknownCount: number } {
  const scope = examScope(ctx.db, subjectId, scopeConceptIds);
  const states = effectiveStates(ctx.db, ctx.now(), scope);
  const probs = new Map<string, number>();
  let unknownCount = 0;
  for (const [id, s] of states) {
    if (s.probability !== null) probs.set(id, s.probability);
    if (s.state === "unknown") unknownCount++;
  }
  return { preparedProbability: goalPreparedProbability(scope, probs), unknownCount };
}

function toExam(ctx: HubContext, r: ExamRow): Exam {
  const scopeConceptIds = JSON.parse(r.scope_concept_ids_json) as string[];
  return {
    id: r.id,
    subjectId: r.subject_id,
    subjectName: r.subject_name,
    title: r.title,
    date: r.date,
    scopeConceptIds,
    notes: r.notes,
    createdAt: r.created_at,
    daysLeft: daysUntil(r.date, ctx.now()),
    ...examPreparation(ctx, r.subject_id, scopeConceptIds),
  };
}

export function getExam(ctx: HubContext, id: string): Exam {
  const row = ctx.db.prepare(`${EXAM_SELECT} WHERE e.id = ?`).get(id) as ExamRow | undefined;
  if (!row) throw notFound();
  return toExam(ctx, row);
}

/** By ascending date; `from`/`to` inclusive. */
export function listExams(ctx: HubContext, q: Partial<ExamListQuery> = {}): Exam[] {
  const where: string[] = [];
  const args: string[] = [];
  const add = (cond: string, v: string | undefined) => {
    if (v === undefined) return;
    where.push(cond);
    args.push(v);
  };
  add("e.subject_id = ?", q.subjectId);
  add("e.date >= ?", q.from);
  add("e.date <= ?", q.to);
  const rows = ctx.db
    .prepare(`${EXAM_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY e.date, e.created_at, e.id`)
    .all(...args) as ExamRow[];
  return rows.map((r) => toExam(ctx, r));
}

function assertSubject(db: Db, subjectId: string): void {
  if (!db.prepare("SELECT 1 FROM subjects WHERE id = ?").get(subjectId)) throw notFound();
}

function assertConcepts(db: Db, ids: readonly string[]): void {
  const has = db.prepare("SELECT 1 FROM concepts WHERE id = ?");
  for (const id of ids) if (!has.get(id)) throw notFound();
}

export function createExam(ctx: HubContext, body: CreateExamBody): Exam {
  assertSubject(ctx.db, body.subjectId);
  assertConcepts(ctx.db, body.scopeConceptIds);
  const id = ulid(ctx.now().getTime());
  ctx.db
    .prepare("INSERT INTO exams (id, subject_id, title, date, scope_concept_ids_json, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, body.subjectId, body.title, body.date, JSON.stringify(body.scopeConceptIds), body.notes ?? null, isoNow(ctx.now()));
  return getExam(ctx, id);
}

export function patchExam(ctx: HubContext, id: string, body: PatchExamBody): Exam {
  const cur = ctx.db.prepare("SELECT * FROM exams WHERE id = ?").get(id) as ExamRow | undefined;
  if (!cur) throw notFound();
  if (body.scopeConceptIds) assertConcepts(ctx.db, body.scopeConceptIds);
  ctx.db
    .prepare("UPDATE exams SET title = ?, date = ?, scope_concept_ids_json = ?, notes = ? WHERE id = ?")
    .run(
      body.title ?? cur.title,
      body.date ?? cur.date,
      body.scopeConceptIds ? JSON.stringify(body.scopeConceptIds) : cur.scope_concept_ids_json,
      body.notes === undefined ? cur.notes : body.notes,
      id,
    );
  return getExam(ctx, id);
}

/** Deletes the exam and its diagnostic passes (FK `diagnostics.exam_id`). */
export function deleteExam(ctx: HubContext, id: string): void {
  if (!ctx.db.prepare("SELECT 1 FROM exams WHERE id = ?").get(id)) throw notFound();
  ctx.db.transaction(() => {
    ctx.db.prepare("DELETE FROM diagnostics WHERE exam_id = ?").run(id);
    ctx.db.prepare("DELETE FROM exams WHERE id = ?").run(id);
  })();
}

/** MCP `upsert_exam`: without `id` it creates; with `id` it overwrites all fields (absent ones become empty). */
export function upsertExam(
  ctx: HubContext,
  input: { id?: string; subjectId: string; title: string; date: string; scopeConceptIds?: string[]; notes?: string },
): Exam {
  if (!input.id) return createExam(ctx, { ...input, scopeConceptIds: input.scopeConceptIds ?? [] });
  if (!ctx.db.prepare("SELECT 1 FROM exams WHERE id = ?").get(input.id)) throw notFound();
  assertSubject(ctx.db, input.subjectId);
  const scope = input.scopeConceptIds ?? [];
  assertConcepts(ctx.db, scope);
  ctx.db
    .prepare("UPDATE exams SET subject_id = ?, title = ?, date = ?, scope_concept_ids_json = ?, notes = ? WHERE id = ?")
    .run(input.subjectId, input.title, input.date, JSON.stringify(scope), input.notes ?? null, input.id);
  return getExam(ctx, input.id);
}
