// session-ingest / session-reingest and sessions-idle-check.
import { isoNow } from "@graphharness/core";
import { extractSessionItems, type AnsweredQuestion, type ChatDetail, type ConcludedPractice, type SessionExtraction } from "@graphharness/lh-client";
import { recordEvidence, weighted, type NewEvidence } from "@graphharness/hub/services/evidence";
import { enqueueJob } from "@graphharness/hub/services/jobs";
import type { HubContext } from "@graphharness/hub/services/context";
import { z } from "zod";
import { askJson, parseCursor, pretty, type IngestCursor } from "./common.ts";

/** Threshold of the `propositions` method of plan_node_map. */
export const PLAN_NODE_MAJORITY = 0.6;

export const AssignOutputSchema = z.object({ conceptId: z.string().nullable() });
export const JudgeOutputSchema = z.object({ verdict: z.enum(["correct", "partial", "incorrect"]), rationale: z.string() });

type LhSource = "lh_quiz" | "lh_probe" | "lh_recall" | "lh_practice";
const SOURCE_OF: Record<AnsweredQuestion["tool"], LhSource> = { quiz: "lh_quiz", probe: "lh_probe", explain: "lh_recall", recall: "lh_recall" };

interface Candidate {
  id: string;
  name: string;
  description: string;
}

interface Run {
  ctx: HubContext;
  chat: ChatDetail;
  extraction: SessionExtraction;
  subjectId: string | null;
  /** session-reingest: recomputes the node mappings that were left as null (except manual ones). */
  retryNull: boolean;
  nodeCache: Map<string, string | null>;
  candidates?: Candidate[];
}

/** Creates the lh_sessions row if the chat has not been synced yet (e.g. ingest called before lh-sync). */
function ensureSession(ctx: HubContext, chat: ChatDetail): void {
  ctx.db
    .prepare("INSERT OR IGNORE INTO lh_sessions (chat_id, title, kind) VALUES (?, ?, ?)")
    .run(chat.id, chat.title, chat.kind === "practice" ? "practice" : "teaching");
}

export async function runSessionIngest(ctx: HubContext, chatId: string): Promise<{ events: number; unassigned: number }> {
  const chat = await ctx.lh.getChat(chatId);
  ensureSession(ctx, chat);
  const row = ctx.db.prepare("SELECT subject_id, ingest_cursor_json FROM lh_sessions WHERE chat_id = ?").get(chatId) as {
    subject_id: string | null;
    ingest_cursor_json: string;
  };
  const cursor = parseCursor(row.ingest_cursor_json);
  const extraction = extractSessionItems(chat, cursor.messageId ? { afterMessageId: cursor.messageId } : undefined);
  if (!extraction.cursorFound) console.warn(`[session-ingest] ${chatId}: cursor ${cursor.messageId} is no longer in the record; everything is reprocessed (idempotent)`);
  for (const a of extraction.anomalies) console.warn(`[session-ingest] ${chatId} ${a.messageId}/${a.toolCallId ?? "-"}: ${a.reason}`);

  const result = await ingestItems({ ctx, chat, extraction, subjectId: row.subject_id, retryNull: false, nodeCache: new Map() });
  const next: IngestCursor = { messageId: extraction.lastMessageId, updatedAt: chat.updatedAt, messageCount: chat.messages.length };
  ctx.db.prepare("UPDATE lh_sessions SET ingest_cursor_json = ? WHERE chat_id = ?").run(JSON.stringify(next), chatId);
  return result;
}

/** session-reingest (manual): reprocesses the chat's questions without a concept, now that there may be more concepts. Does not move the cursor. */
export async function runSessionReingest(ctx: HubContext, chatId: string): Promise<{ events: number; unassigned: number }> {
  const pending = new Set(ctx.db.prepare("SELECT tool_call_id FROM unassigned_questions WHERE chat_id = ?").pluck().all(chatId) as string[]);
  if (pending.size === 0) return { events: 0, unassigned: 0 };
  const chat = await ctx.lh.getChat(chatId);
  ensureSession(ctx, chat);
  const subjectId = ctx.db.prepare("SELECT subject_id FROM lh_sessions WHERE chat_id = ?").pluck().get(chatId) as string | null;
  const all = extractSessionItems(chat);
  const extraction: SessionExtraction = {
    ...all,
    questions: all.questions.filter((q) => pending.has(q.toolCallId)),
    practices: all.practices.filter((p) => pending.has(p.concludeCallId)),
  };
  return ingestItems({ ctx, chat, extraction, subjectId, retryNull: true, nodeCache: new Map() });
}

async function ingestItems(run: Run): Promise<{ events: number; unassigned: number }> {
  let events = 0;
  let unassigned = 0;
  for (const q of run.extraction.questions) {
    if (q.dismissed) continue;
    const r = await ingestQuestion(run, q);
    events += r.events;
    unassigned += r.unassigned ? 1 : 0;
  }
  for (const p of run.extraction.practices) {
    if (p.dismissed || p.correct === null) continue; // dismissed: ignore
    const r = await ingestPractice(run, p);
    events += r.events;
    unassigned += r.unassigned ? 1 : 0;
  }
  return { events, unassigned };
}

/** Is there already evidence for this call? (avoids reassigning/re-judging and duplicating when the mapping changes). */
function alreadyIngested(run: Run, source: LhSource, toolCallId: string): boolean {
  return (
    run.ctx.db
      .prepare(
        "SELECT 1 FROM evidence_events WHERE source = ? AND json_extract(ref_json, '$.chatId') = ? AND json_extract(ref_json, '$.toolCallId') = ? LIMIT 1",
      )
      .get(source, run.chat.id, toolCallId) !== undefined
  );
}

function markUnassigned(run: Run, toolCallId: string, source: LhSource, payload: Record<string, unknown>): void {
  run.ctx.db
    .prepare(
      `INSERT INTO unassigned_questions (chat_id, tool_call_id, source, payload_json, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(chat_id, tool_call_id) DO UPDATE SET payload_json = excluded.payload_json`,
    )
    .run(run.chat.id, toolCallId, source, JSON.stringify(payload), isoNow(run.ctx.now()));
}

function record(run: Run, toolCallId: string, evs: NewEvidence[]): number {
  const { db } = run.ctx;
  return db.transaction(() => {
    let n = 0;
    for (const ev of evs) if (recordEvidence(db, ev, run.ctx.now()).inserted) n++;
    db.prepare("DELETE FROM unassigned_questions WHERE chat_id = ? AND tool_call_id = ?").run(run.chat.id, toolCallId);
    return n;
  })();
}

async function ingestQuestion(run: Run, q: AnsweredQuestion): Promise<{ events: number; unassigned: boolean }> {
  const source = SOURCE_OF[q.tool];
  if (q.responseFormat === "mcq" && q.correct === null) {
    console.warn(`[session-ingest] ${run.chat.id}/${q.toolCallId}: ${q.tool} without 'correct'; ignored`);
    return { events: 0, unassigned: false };
  }
  if (alreadyIngested(run, source, q.toolCallId)) {
    run.ctx.db.prepare("DELETE FROM unassigned_questions WHERE chat_id = ? AND tool_call_id = ?").run(run.chat.id, q.toolCallId);
    return { events: 0, unassigned: false };
  }
  // quiz/explain by plan node; probe/recall by LLM using the text (ADR 102 point 11).
  const conceptId = q.nodeId !== null ? await conceptForNode(run, q.nodeId) : await assignByLlm(run, { type: "question", tool: q.tool, text: q.questionText });
  if (conceptId === null) {
    markUnassigned(run, q.toolCallId, source, { kind: "question", tool: q.tool, nodeId: q.nodeId, questionText: q.questionText, correct: q.correct, at: q.answeredAt, responseFormat: q.responseFormat, confidence: q.confidence });
    return { events: 0, unassigned: true };
  }
  let correct = q.correct;
  let inferred = false;
  if (q.responseFormat === "open") {
    inferred = true;
    // "I don't know" in a free-text answer counts as incorrect without calling the judge (like dontKnow).
    correct = q.dontKnow ? false : (await judge(run, q)) === "correct"; // partial → incorrect
  }
  const events = record(run, q.toolCallId, [
    {
      conceptId,
      at: q.answeredAt,
      source,
      correct,
      responseFormat: q.responseFormat,
      inferred,
      ...weighted(run.ctx.config.weights, 1, { source, correct, confidence: q.confidence }),
      confidence: q.confidence,
      ref: { chatId: run.chat.id, toolCallId: q.toolCallId },
    },
  ]);
  return { events, unassigned: false };
}

async function ingestPractice(run: Run, p: ConcludedPractice): Promise<{ events: number; unassigned: boolean }> {
  if (alreadyIngested(run, "lh_practice", p.concludeCallId)) {
    run.ctx.db.prepare("DELETE FROM unassigned_questions WHERE chat_id = ? AND tool_call_id = ?").run(run.chat.id, p.concludeCallId);
    return { events: 0, unassigned: false };
  }
  // Step 1: target (proposition ids) → active concepts; one event per concept.
  const conceptOf = run.ctx.db.prepare(
    "SELECT cp.concept_id FROM concept_propositions cp JOIN concepts c ON c.id = cp.concept_id WHERE cp.proposition_id = ? AND c.status = 'active'",
  );
  const concepts = [...new Set(p.target.map((id) => conceptOf.pluck().get(id) as string | undefined).filter((c): c is string => c !== undefined))].sort();
  if (concepts.length === 0) {
    markUnassigned(run, p.concludeCallId, "lh_practice", { kind: "practice", problemCallId: p.problemCallId, target: p.target, outcome: p.outcome, rung: p.rung, correct: p.correct, at: p.at, responseFormat: p.responseFormat, verdict: p.verdict });
    return { events: 0, unassigned: true };
  }
  const events = record(
    run,
    p.concludeCallId,
    concepts.map((conceptId) => ({
      conceptId,
      at: p.at,
      source: "lh_practice" as const,
      correct: p.correct,
      responseFormat: p.responseFormat,
      ...weighted(run.ctx.config.weights, 1, { source: "lh_practice", correct: p.correct, missClass: p.missClass }),
      missClass: p.correct === false ? p.missClass : null,
      // UNIQUE(source, ref_json): with several concepts, the ref carries the concept so they do not collide.
      ref: concepts.length > 1 ? { chatId: run.chat.id, toolCallId: p.concludeCallId, conceptId } : { chatId: run.chat.id, toolCallId: p.concludeCallId },
    })),
  );
  return { events, unassigned: false };
}

/** Follows merges until an active concept; null if it does not exist or is retired. */
function activeConcept(run: Run, id: string | null): string | null {
  const get = run.ctx.db.prepare("SELECT status, merged_into FROM concepts WHERE id = ?");
  for (let cur = id, hops = 0; cur !== null && hops < 10; hops++) {
    const c = get.get(cur) as { status: string; merged_into: string | null } | undefined;
    if (!c) return null;
    if (c.status === "active") return cur;
    cur = c.status === "merged" ? c.merged_into : null;
  }
  return null;
}

/** Step 2: plan node → concept, cached in plan_node_map (`manual` mappings take precedence). */
async function conceptForNode(run: Run, nodeId: string): Promise<string | null> {
  if (run.nodeCache.has(nodeId)) return run.nodeCache.get(nodeId)!;
  const { db } = run.ctx;
  const row = db.prepare("SELECT concept_id, method FROM plan_node_map WHERE chat_id = ? AND plan_node_id = ?").get(run.chat.id, nodeId) as
    | { concept_id: string | null; method: string }
    | undefined;
  const cached = row ? activeConcept(run, row.concept_id) : null;
  if (row && (cached !== null || row.method === "manual" || (!run.retryNull && row.concept_id === null))) {
    run.nodeCache.set(nodeId, cached);
    return cached;
  }

  let conceptId = byPropositions(run, nodeId);
  let method: "propositions" | "llm" = "propositions";
  if (conceptId === null) {
    method = "llm";
    const label = run.extraction.plan?.nodes.find((n) => n.id === nodeId)?.title ?? nodeId;
    const questions = run.extraction.questions.filter((q) => q.nodeId === nodeId).map((q) => q.questionText);
    conceptId = await assignByLlm(run, { type: "plan-node", label, questions });
  }
  db.prepare(
    `INSERT INTO plan_node_map (chat_id, plan_node_id, concept_id, method) VALUES (?, ?, ?, ?)
     ON CONFLICT(chat_id, plan_node_id) DO UPDATE SET concept_id = excluded.concept_id, method = excluded.method
     WHERE plan_node_map.method <> 'manual'`,
  ).run(run.chat.id, nodeId, conceptId, method);
  run.nodeCache.set(nodeId, conceptId);
  return conceptId;
}

/** `propositions` method: majority concept (≥ 60 %) of the live propositions whose provenance falls in the node's span. */
function byPropositions(run: Run, nodeId: string): string | null {
  const span = run.extraction.plan?.spans[nodeId];
  if (!span || span.messageIds.length === 0) return null;
  const rows = run.ctx.db
    .prepare(
      `SELECT DISTINCT p.id AS id, cp.concept_id AS conceptId FROM lh_propositions p, json_each(p.provenance_json) j
       LEFT JOIN concept_propositions cp ON cp.proposition_id = p.id
       WHERE p.deleted = 0 AND json_extract(j.value, '$.chatId') = ? AND json_extract(j.value, '$.messageId') IN (SELECT value FROM json_each(?))`,
    )
    .all(run.chat.id, JSON.stringify(span.messageIds)) as { id: string; conceptId: string | null }[];
  if (rows.length === 0) return null;
  const counts = new Map<string, number>();
  for (const r of rows) {
    const c = activeConcept(run, r.conceptId);
    if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const best = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
  return best && best[1] / rows.length >= PLAN_NODE_MAJORITY ? best[0] : null;
}

/** Candidate concepts: the active ones of the session's subject; if it has none, all the active ones. */
function candidates(run: Run): Candidate[] {
  run.candidates ??= run.ctx.db
    .prepare(
      `SELECT id, name, description FROM concepts WHERE status = 'active' AND (? IS NULL OR subject_id = ?) ORDER BY name, id`,
    )
    .all(run.subjectId, run.subjectId) as Candidate[];
  return run.candidates;
}

/** Cheap LLM (concept-assign): picks one of the candidates or null. An id outside the list counts as null. */
async function assignByLlm(run: Run, item: Record<string, unknown>): Promise<string | null> {
  const list = candidates(run);
  if (list.length === 0) return null;
  const out = await askJson(run.ctx, "concept-assign", { item: pretty(item), concepts: pretty(list) }, AssignOutputSchema);
  return out.conceptId !== null && list.some((c) => c.id === out.conceptId) ? out.conceptId : null;
}

/** Cheap LLM judge for free-text answers. */
async function judge(run: Run, q: AnsweredQuestion): Promise<"correct" | "partial" | "incorrect"> {
  const out = await askJson(
    run.ctx,
    "recall-judge",
    {
      question: q.questionText,
      committed: q.committed ?? "(not available)",
      answer: q.text ?? "(no answer)",
      thinking: q.thinking ?? "(no reasoning)",
      teacher: q.nextTeacherText ?? "(no next message from the teacher)",
    },
    JudgeOutputSchema,
  );
  return out.verdict;
}

// ─── automatic close ────────────────────────────────────────────────

/**
 * `open` sessions with at least one answered question (with evidence or without a concept), with no `turn-started` since the last
 * `turn-settled`, and more than SESSION_IDLE_CLOSE_MIN minutes since it → `closing` + session-close {chatId}.
 */
export async function runSessionsIdleCheck(ctx: HubContext): Promise<{ closing: string[] }> {
  const { db } = ctx;
  const now = ctx.now().getTime();
  const idleMs = ctx.config.sessionIdleCloseMin * 60_000;
  const rows = db
    .prepare("SELECT chat_id, last_turn_started_at, last_turn_settled_at FROM lh_sessions WHERE hub_state = 'open' AND last_turn_settled_at IS NOT NULL")
    .all() as { chat_id: string; last_turn_started_at: string | null; last_turn_settled_at: string }[];
  const answered = db.prepare(
    `SELECT 1 WHERE EXISTS (SELECT 1 FROM evidence_events WHERE source IN ('lh_quiz','lh_probe','lh_recall','lh_practice') AND json_extract(ref_json, '$.chatId') = @chatId)
       OR EXISTS (SELECT 1 FROM unassigned_questions WHERE chat_id = @chatId)`,
  );
  const closing: string[] = [];
  for (const r of rows) {
    const settled = Date.parse(r.last_turn_settled_at);
    if (r.last_turn_started_at !== null && Date.parse(r.last_turn_started_at) > settled) continue; // turn in progress
    if (now - settled < idleMs) continue;
    if (answered.get({ chatId: r.chat_id }) === undefined) continue;
    const changed = db.prepare("UPDATE lh_sessions SET hub_state = 'closing' WHERE chat_id = ? AND hub_state = 'open'").run(r.chat_id).changes;
    if (changed === 0) continue;
    enqueueJob(db, "session-close", { chatId: r.chat_id }, { now: ctx.now() });
    closing.push(r.chat_id);
  }
  return { closing };
}
