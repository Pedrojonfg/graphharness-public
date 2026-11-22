// Diagnostics from "Prepare exam" (GL-006/028/052/053; ADR 102 point 2). Answers are attempts
// with context='diagnostic' and `hub_diagnostic` evidence; the pass lives in `diagnostics.state_json`.
import {
  computeInferenceBump,
  dependentsCount,
  isoNow,
  resolveGradeCorrectDelta,
  resolveInferenceBumpScale,
  ulid,
  type ConceptEdge,
} from "@graphharness/core";
import { DIAGNOSTIC_MAX_ITEMS, type DiagnosticAnswerBody, type DiagnosticAnswerResponse, type DiagnosticState } from "@graphharness/contracts";
import { HubError, conflict, notFound } from "../errors.ts";
import type { HubContext } from "./context.ts";
import { touchMatchedError } from "./errors.ts";
import { effectiveStates, recordEvidence } from "./evidence.ts";
import { mcqOptionsFromPayload, publicOptions, withEval, type StoredMcqOption } from "./practice-common.ts";
import { activeTemplateOf, createInstance, getInstance } from "./templates.ts";

type Format = "mcq" | "open";
type FinishReason = "complete" | "max_items" | "nothing_to_ask";

interface CurrentItem {
  itemId: string;
  conceptId: string;
  instanceId: string;
  format: Format;
  options: StoredMcqOption[] | null;
}

interface PassState {
  /** Concepts still to ask about; `open` = the open question after a miss or an "I don't know". */
  queue: { conceptId: string; format: Format }[];
  unaskable: string[];
  /** Concepts that already had their open follow-up question. */
  followedUp: string[];
  current: CurrentItem | null;
  answered: { itemId: string; conceptId: string; outcome: "correct" | "incorrect" | "dont_know" }[];
  reason: FinishReason | null;
}

interface DiagnosticRow {
  id: string;
  exam_id: string;
  status: "open" | "done";
  state: PassState;
}

function load(ctx: HubContext, id: string): DiagnosticRow | undefined {
  const r = ctx.db.prepare("SELECT id, exam_id, status, state_json FROM diagnostics WHERE id = ?").get(id) as
    | { id: string; exam_id: string; status: "open" | "done"; state_json: string }
    | undefined;
  return r && { id: r.id, exam_id: r.exam_id, status: r.status, state: JSON.parse(r.state_json) as PassState };
}

function save(ctx: HubContext, d: DiagnosticRow): void {
  ctx.db
    .prepare("UPDATE diagnostics SET status = ?, state_json = ?, updated_at = ? WHERE id = ?")
    .run(d.status, JSON.stringify(d.state), isoNow(ctx.now()), d.id);
}

function finish(d: DiagnosticRow, reason: FinishReason): void {
  d.status = "done";
  d.state.reason = reason;
  d.state.current = null;
}

function usableEdges(ctx: HubContext): ConceptEdge[] {
  return (
    ctx.db.prepare("SELECT from_concept, to_concept, relation, confidence FROM concept_edges WHERE removed = 0").all() as {
      from_concept: string;
      to_concept: string;
      relation: ConceptEdge["relation"];
      confidence: ConceptEdge["confidence"];
    }[]
  ).map((e) => ({ from: e.from_concept, to: e.to_concept, relation: e.relation, confidence: e.confidence }));
}

/** Scope: `stale`, `unknown` or with a `pending` declaration. */
function needsDiagnosis(ctx: HubContext, conceptIds: readonly string[]): Set<string> {
  const states = effectiveStates(ctx.db, ctx.now(), conceptIds);
  const pending = new Set(ctx.db.prepare("SELECT DISTINCT concept_id FROM declarations WHERE status = 'pending'").pluck().all() as string[]);
  return new Set(conceptIds.filter((id) => {
    const s = states.get(id)!;
    return s.state === "unknown" || s.stale || pending.has(id);
  }));
}

/** Prepares the next question if none is in progress (eval generates the instance). Saves the state. */
async function ensureItem(ctx: HubContext, d: DiagnosticRow): Promise<void> {
  while (d.status === "open" && !d.state.current) {
    if (d.state.answered.length >= DIAGNOSTIC_MAX_ITEMS) {
      finish(d, "max_items");
      break;
    }
    const next = d.state.queue[0];
    if (!next) {
      finish(d, "complete");
      break;
    }
    const template = activeTemplateOf(ctx.db, next.conceptId);
    // Inference may have taken the concept out of scope; the open follow-up is always done.
    if (!template || (next.format === "mcq" && !needsDiagnosis(ctx, [next.conceptId]).has(next.conceptId))) {
      d.state.queue.shift();
      continue;
    }
    const inst = await withEval(() => createInstance(ctx, template.id));
    const options =
      next.format === "mcq" && !("comprehensionVersion" in inst.payload)
        ? mcqOptionsFromPayload(inst.payload as import("./eval-client.ts").RecipeInstancePayload)
        : null;
    d.state.queue.shift();
    d.state.current = { itemId: ulid(ctx.now().getTime()), conceptId: next.conceptId, instanceId: inst.id, format: options ? "mcq" : "open", options };
  }
  save(ctx, d);
}

function view(ctx: HubContext, d: DiagnosticRow): DiagnosticState {
  const cur = d.state.current;
  const conceptName = cur ? (ctx.db.prepare("SELECT name FROM concepts WHERE id = ?").pluck().get(cur.conceptId) as string) : null;
  return {
    id: d.id,
    examId: d.exam_id,
    status: d.status,
    answered: d.state.answered.length,
    maxItems: DIAGNOSTIC_MAX_ITEMS,
    item: cur
      ? {
          itemId: cur.itemId,
          conceptId: cur.conceptId,
          conceptName: conceptName!,
          format: cur.format,
          instance: getInstance(ctx.db, cur.instanceId)!.client,
          options: cur.options ? publicOptions(cur.options) : null,
        }
      : null,
    finished: d.status === "done" ? { reason: d.state.reason ?? "complete", unaskableConceptIds: d.state.unaskable } : null,
  };
}

/** POST /diagnostics {examId}: opens a pass or returns the one already open for that exam. */
export async function createDiagnostic(ctx: HubContext, examId: string): Promise<DiagnosticState> {
  const { db } = ctx;
  const exam = db.prepare("SELECT id, subject_id, scope_concept_ids_json FROM exams WHERE id = ?").get(examId) as
    | { id: string; subject_id: string; scope_concept_ids_json: string }
    | undefined;
  if (!exam) throw notFound();
  const openId = db.prepare("SELECT id FROM diagnostics WHERE exam_id = ? AND status = 'open' ORDER BY created_at DESC LIMIT 1").pluck().get(examId) as
    | string
    | undefined;
  if (openId) {
    const d = load(ctx, openId)!;
    await ensureItem(ctx, d);
    return view(ctx, d);
  }

  const declared = JSON.parse(exam.scope_concept_ids_json) as string[];
  const scope = (
    declared.length
      ? db.prepare(`SELECT id, name FROM concepts WHERE status = 'active' AND id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(declared))
      : db.prepare("SELECT id, name FROM concepts WHERE status = 'active' AND subject_id = ?").all(exam.subject_id)
  ) as { id: string; name: string }[];
  const ids = scope.map((c) => c.id);
  const targets = needsDiagnosis(ctx, ids);
  const edges = usableEdges(ctx);
  const scopeSet = new Set(ids);
  // First the concepts with the fewest dependents: getting them right raises their prerequisites by inference (GL-053).
  const ordered = scope
    .filter((c) => targets.has(c.id))
    .map((c) => ({ ...c, deps: dependentsCount(c.id, edges, scopeSet) }))
    .sort((a, b) => a.deps - b.deps || a.name.localeCompare(b.name));
  const askable = ordered.filter((c) => activeTemplateOf(db, c.id));
  const state: PassState = {
    queue: askable.map((c) => ({ conceptId: c.id, format: "mcq" })),
    unaskable: ordered.filter((c) => !activeTemplateOf(db, c.id)).map((c) => c.id),
    followedUp: [],
    current: null,
    answered: [],
    reason: askable.length ? null : "nothing_to_ask",
  };
  const now = ctx.now();
  const d: DiagnosticRow = { id: ulid(now.getTime()), exam_id: examId, status: askable.length ? "open" : "done", state };
  db.prepare("INSERT INTO diagnostics (id, exam_id, status, state_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    d.id,
    examId,
    d.status,
    JSON.stringify(state),
    isoNow(now),
    isoNow(now),
  );
  await ensureItem(ctx, d);
  return view(ctx, d);
}

/** POST /diagnostics/:id/answer. 409 already_answered | diagnostic_finished | wrong_format. */
export async function answerDiagnostic(ctx: HubContext, diagnosticId: string, body: DiagnosticAnswerBody): Promise<DiagnosticAnswerResponse> {
  const { db } = ctx;
  const d = load(ctx, diagnosticId);
  if (!d) throw notFound();
  if (d.state.answered.some((a) => a.itemId === body.itemId)) throw conflict("already_answered");
  if (d.status === "done") throw conflict("diagnostic_finished");
  const cur = d.state.current;
  if (!cur || cur.itemId !== body.itemId) throw notFound();
  const a = body.answer;
  if (a.kind !== "dont_know" && a.kind !== cur.format) throw conflict("wrong_format");

  const instance = getInstance(db, cur.instanceId)!;
  let correct = false;
  let detectorKey: string | null = null;
  let userInput: unknown = { dontKnow: true };
  if (a.kind === "mcq") {
    const opt = cur.options!.find((o) => o.id === a.optionId);
    if (!opt)
      throw new HubError(400, { error: "invalid_request", issues: [{ path: ["answer", "optionId"], message: "unknown option" }] });
    correct = opt.errorKey === null;
    detectorKey = opt.errorKey;
    userInput = { result: opt.value, optionId: opt.id };
  } else if (a.kind === "open") {
    const g = await withEval(() =>
      ctx.evalApi.grade(instance.payload as import("./eval-client.ts").RecipeInstancePayload, a.userInput.result),
    );
    correct = g.correct;
    detectorKey = g.correct ? null : (g.detectorKey ?? null);
    userInput = a.userInput;
  }
  const outcome = a.kind === "dont_know" ? "dont_know" : correct ? "correct" : "incorrect";

  const now = ctx.now();
  const at = isoNow(now);
  db.transaction(() => {
    const matched = touchMatchedError(db, instance.template_id, detectorKey, at);
    db.prepare(
      `INSERT INTO attempts (id, instance_id, context, user_input_json, correct, matched_error_id, unknown_pattern, hints_used, response_ms, created_at)
       VALUES (?, ?, 'diagnostic', ?, ?, ?, ?, 0, ?, ?)`,
    ).run(
      ulid(now.getTime()),
      instance.id,
      JSON.stringify(userInput),
      correct ? 1 : 0,
      matched,
      a.kind === "open" && !correct && !detectorKey ? 1 : 0,
      body.responseMs ?? null,
      at,
    );
    // "I don't know" counts as a miss, as in lh_quiz.
    recordEvidence(db, { conceptId: cur.conceptId, at, source: "hub_diagnostic", correct, responseFormat: cur.format, ref: { diagnosticId, itemId: cur.itemId } }, now);
    if (correct) {
      // Upward inference: raises the P of the prerequisites with weight = bump / Δcorrect.
      // Prerequisites of any active concept, even if they fall outside the exam's scope.
      const edges = usableEdges(ctx);
      const scale = resolveInferenceBumpScale();
      const candidates = db
        .prepare("SELECT DISTINCT e.from_concept FROM concept_edges e JOIN concepts c ON c.id = e.from_concept WHERE e.removed = 0 AND c.status = 'active'")
        .pluck()
        .all() as string[];
      for (const p of candidates) {
        if (p === cur.conceptId) continue;
        const bump = computeInferenceBump({ edges }, p, cur.conceptId, scale);
        if (bump === null) continue;
        recordEvidence(
          db,
          {
            conceptId: p,
            at,
            source: "hub_diagnostic",
            correct: true,
            responseFormat: cur.format,
            weight: bump / resolveGradeCorrectDelta(),
            ref: { diagnosticId, itemId: cur.itemId, inferredFrom: cur.conceptId },
          },
          now,
        );
      }
    } else if (a.kind === "mcq" && !d.state.followedUp.includes(cur.conceptId)) {
      // Miss on the MCQ (slip or not known?) → next open question for that concept. "I don't know" is already a clear answer.
      d.state.followedUp.push(cur.conceptId);
      d.state.queue.unshift({ conceptId: cur.conceptId, format: "open" });
    }
    d.state.answered.push({ itemId: cur.itemId, conceptId: cur.conceptId, outcome });
    d.state.current = null;
    save(ctx, d);
  })();
  await ensureItem(ctx, d);
  return { outcome, state: view(ctx, d) };
}
