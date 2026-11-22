// Lens votes per core node (ADR 109 §6–7): LH writes them (POST) and the teacher reads them aggregated (GET, MCP).
import { isoNow, ulid } from "@graphharness/core";
import type { LensFeedbackBody, LensFeedbackList, LensFeedbackQuery, LensFeedbackSaved } from "@graphharness/contracts";
import { badRequest } from "../errors.ts";
import { resolveTarget } from "./agent-tools.ts";
import type { HubContext } from "./context.ts";

/** Idempotent per (chat, node, label): re-voting updates `liked` and `updated_at` and keeps `created_at`. */
export async function saveLensFeedback(ctx: HubContext, body: LensFeedbackBody): Promise<LensFeedbackSaved> {
  const concept = await resolveTarget(ctx, body);
  const votes = new Map<string, boolean>(); // the last repeated label wins
  for (const l of body.lenses) votes.set(l.label, l.liked);
  const now = ctx.now();
  const at = isoNow(now);
  const upsert = ctx.db.prepare(
    `INSERT INTO lens_feedback (id, chat_id, concept_id, node_id, lens_label, liked, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (chat_id, node_id, lens_label) DO UPDATE SET liked = excluded.liked, updated_at = excluded.updated_at`,
  );
  ctx.db.transaction(() => {
    for (const [label, liked] of votes) upsert.run(ulid(now.getTime()), body.chatId, concept.id, body.nodeId, label, liked ? 1 : 0, at, at);
  })();
  return { saved: votes.size, conceptId: concept.id, conceptName: concept.name };
}

export async function listLensFeedback(ctx: HubContext, q: LensFeedbackQuery): Promise<LensFeedbackList> {
  if ((q.conceptId === undefined) === (q.conceptQuery === undefined)) throw badRequest("invalid_request", { message: "provide conceptId or conceptQuery, not both" });
  const concept = await resolveTarget(ctx, q);
  const lenses = ctx.db
    .prepare(
      `SELECT lens_label AS label, sum(liked) AS likedCount, count(*) AS shownCount, max(updated_at) AS lastAt
       FROM lens_feedback WHERE concept_id = ?
       GROUP BY lens_label ORDER BY likedCount DESC, shownCount DESC, label`,
    )
    .all(concept.id) as LensFeedbackList["lenses"];
  return { conceptId: concept.id, conceptName: concept.name, lenses };
}
