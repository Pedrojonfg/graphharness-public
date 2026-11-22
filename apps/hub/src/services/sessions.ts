// Mirrored LH sessions (`lh_sessions`): open (start_session), list and close (enqueues session-close).
import { isoNow } from "@graphharness/core";
import type { CloseSessionResponse, HubSessionState, LhSession, SessionListQuery, StartSessionBody, StartSessionResponse } from "@graphharness/contracts";
import type { GraphContextPick } from "@graphharness/lh-client";
import { notFound } from "../errors.ts";
import type { HubContext } from "./context.ts";
import { effectiveStates } from "./evidence.ts";
import { enqueueJob } from "./jobs.ts";
import { resolveMaterialPath, subjectMaterialsFolder } from "./materials.ts";

/** LH accepts up to 64 propositions in `graphContext`. */
export const GRAPH_CONTEXT_MAX = 64;

export function sessionUrl(ctx: HubContext, chatId: string): string {
  return `${ctx.config.lhPublicUrl.replace(/\/+$/, "")}/chat/${encodeURIComponent(chatId)}`;
}

interface SessionRow {
  chat_id: string;
  title: string;
  kind: "teaching" | "practice";
  subject_id: string | null;
  started_by: "learner" | "agent" | null;
  hub_state: HubSessionState;
  last_turn_settled_at: string | null;
  closed_at: string | null;
  report_id: string | null;
}

/** GET /sessions: from newest to oldest (by last known activity; tie → the last mirrored). */
export function listSessions(ctx: HubContext, q: SessionListQuery): LhSession[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (q.subjectId !== undefined) {
    where.push("s.subject_id = ?");
    args.push(q.subjectId);
  }
  if (q.hubState !== undefined) {
    where.push("s.hub_state = ?");
    args.push(q.hubState);
  }
  const rows = ctx.db
    .prepare(
      `SELECT s.*, (SELECT r.id FROM reports r WHERE r.kind = 'session' AND r.chat_id = s.chat_id ORDER BY r.created_at DESC, r.id DESC LIMIT 1) AS report_id
       FROM lh_sessions s ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY max(coalesce(s.last_turn_settled_at, ''), coalesce(s.last_turn_started_at, ''), coalesce(s.closed_at, '')) DESC, s.rowid DESC
       LIMIT ?`,
    )
    .all(...args, q.limit) as SessionRow[];
  return rows.map((r) => ({
    chatId: r.chat_id,
    title: r.title,
    kind: r.kind,
    subjectId: r.subject_id,
    startedBy: r.started_by,
    hubState: r.hub_state,
    lastTurnSettledAt: r.last_turn_settled_at,
    closedAt: r.closed_at,
    url: sessionUrl(ctx, r.chat_id),
    reportId: r.report_id,
  }));
}

/**
 * POST /sessions/:chatId/close and MCP `close_session` (manual close): `closing` + enqueues `session-close`.
 * Idempotent: if it is already `closing`, it does not enqueue again.
 */
export function closeSession(ctx: HubContext, chatId: string): CloseSessionResponse {
  return ctx.db.transaction((): CloseSessionResponse => {
    const row = ctx.db.prepare("SELECT hub_state FROM lh_sessions WHERE chat_id = ?").get(chatId) as { hub_state: HubSessionState } | undefined;
    if (!row) throw notFound();
    if (row.hub_state === "closing") return { chatId, hubState: "closing", queued: false };
    ctx.db.prepare("UPDATE lh_sessions SET hub_state = 'closing' WHERE chat_id = ?").run(chatId);
    enqueueJob(ctx.db, "session-close", { chatId }, { now: ctx.now() });
    return { chatId, hubState: "closing", queued: true };
  })();
}

interface PickRow {
  id: string;
  name: string;
  statement: string;
  concept_id: string;
}

/**
 * Up to 64 live propositions of the focus concepts (or of the whole subject), first those of concepts
 * weak/review/stale, then by ascending P' (no evidence = 0.5) and by concept name.
 */
export function graphContextPicks(ctx: HubContext, subjectId: string, focusConceptIds?: readonly string[]): GraphContextPick[] {
  const conceptIds = focusConceptIds?.length
    ? [...focusConceptIds]
    : (ctx.db.prepare("SELECT id FROM concepts WHERE subject_id = ? AND status = 'active'").pluck().all(subjectId) as string[]);
  if (conceptIds.length === 0) return [];
  const states = effectiveStates(ctx.db, ctx.now(), conceptIds);
  const rows = ctx.db
    .prepare(
      `SELECT p.id, p.name, p.statement, cp.concept_id FROM lh_propositions p
       JOIN concept_propositions cp ON cp.proposition_id = p.id
       WHERE p.deleted = 0 AND cp.concept_id IN (${conceptIds.map(() => "?").join(",")})
       ORDER BY p.first_seen_at, p.id`,
    )
    .all(...conceptIds) as PickRow[];
  const rank = (conceptId: string): [number, number] => {
    const s = states.get(conceptId);
    const needsWork = s && (s.state === "weak" || s.state === "review" || s.stale);
    return [needsWork ? 0 : 1, s?.probability ?? 0.5];
  };
  const order = new Map(conceptIds.map((id, i) => [id, i]));
  return rows
    .map((r) => ({ r, k: rank(r.concept_id) }))
    .sort((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1] || order.get(a.r.concept_id)! - order.get(b.r.concept_id)!)
    .slice(0, GRAPH_CONTEXT_MAX)
    .map(({ r }) => ({ id: r.id, name: r.name, statement: r.statement }));
}

function firstMessage(goal: string, materialPaths: readonly string[], focusNames: readonly string[]): string {
  const parts = [`Session goal: ${goal}`];
  if (materialPaths.length)
    parts.push(`Material for this session (read it with your file tools):\n${materialPaths.map((p) => `- ${p}`).join("\n")}`);
  if (focusNames.length) parts.push(`Concepts to focus on: ${focusNames.join(", ")}.`);
  return parts.join("\n\n");
}

/**
 * start_session / POST /sessions: creates the chat in LH with `graphContext`, saves `lh_sessions` and sends the first
 * message (goal + absolute material paths). An LH 503 `models_not_configured` passes through unchanged (LhError).
 */
export async function startSession(ctx: HubContext, body: StartSessionBody, startedBy: "agent" | "learner"): Promise<StartSessionResponse> {
  const folder = subjectMaterialsFolder(ctx.db, body.subjectId); // 404 if the subject does not exist
  const focus = body.focusConceptIds ?? [];
  const nameOf = ctx.db.prepare("SELECT name FROM concepts WHERE id = ?").pluck();
  const focusNames = focus.map((id) => {
    const name = nameOf.get(id) as string | undefined;
    if (name === undefined) throw notFound();
    return name;
  });
  const materialPaths = (body.materialPaths ?? []).map((p, i) => resolveMaterialPath(ctx.config.materialsDir, folder, p, ["materialPaths", i]).absolute);
  const picks = graphContextPicks(ctx, body.subjectId, focus);

  const title = body.goal.length > 100 ? `${body.goal.slice(0, 99)}…` : body.goal;
  const chat = await ctx.lh.createChat({
    title,
    kind: body.kind === "teaching" ? "teach" : "practice",
    ...(picks.length ? { graphContext: { propositions: picks } } : {}),
  });
  // Saved before the first message: even if LH rejects it, the chat already exists and lh-sync must not lose the subject.
  ctx.db
    .prepare(
      `INSERT INTO lh_sessions (chat_id, title, kind, subject_id, started_by, hub_state) VALUES (?, ?, ?, ?, ?, 'open')
       ON CONFLICT(chat_id) DO UPDATE SET subject_id = excluded.subject_id, started_by = excluded.started_by, kind = excluded.kind`,
    )
    .run(chat.id, chat.title || title, body.kind, body.subjectId, startedBy);
  await ctx.lh.sendMessage(chat.id, firstMessage(body.goal, materialPaths, focusNames));
  return { chatId: chat.id, url: sessionUrl(ctx, chat.id) };
}

/** Timestamp of the close (`closed`) or failure (`failed`) of the close pipeline. */
export function setSessionState(ctx: HubContext, chatId: string, state: HubSessionState): void {
  if (state === "closed") ctx.db.prepare("UPDATE lh_sessions SET hub_state = 'closed', closed_at = ? WHERE chat_id = ?").run(isoNow(ctx.now()), chatId);
  else ctx.db.prepare("UPDATE lh_sessions SET hub_state = ? WHERE chat_id = ?").run(state, chatId);
}
