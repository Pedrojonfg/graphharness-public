// Ingest lane: lh-sync, concept-curate, edges-derive, concept-review, session-ingest, session-reingest, sessions-idle-check.
// The logic lives in ../ingest/*.ts; this file holds the boundary functions (called by session-close) and the handler registry.
import type { HubContext } from "@graphharness/hub/services/context";
import type { JobHandlers } from "../runner.ts";
import { runConceptCurate as curate, runConceptReview } from "../ingest/curate.ts";
import { runEdgesDerive as derive } from "../ingest/edges.ts";
import { runSessionIngest as ingest, runSessionReingest, runSessionsIdleCheck } from "../ingest/session.ts";
import { runLhSync as sync } from "../ingest/sync.ts";

/** GET /api/graph + /api/chats → upsert of lh_propositions/lh_chains/lh_sessions; enqueues concept-curate and session-ingest. */
export async function runLhSync(ctx: HubContext): Promise<{ newPropositions: number; chatsToIngest: string[] }> {
  return sync(ctx);
}
/** Assigns ALL live propositions without a concept (in batches of 40). Returns the concepts created. */
export async function runConceptCurate(ctx: HubContext): Promise<{ assigned: number; createdConceptIds: string[] }> {
  return curate(ctx);
}
/** Recomputes the derived concept_edges from the live chains. */
export async function runEdgesDerive(ctx: HubContext): Promise<{ edges: number; removedForCycles: number }> {
  return derive(ctx);
}
/** Ingests the session from its ingest_cursor (idempotent). */
export async function runSessionIngest(ctx: HubContext, chatId: string): Promise<{ events: number; unassigned: number }> {
  return ingest(ctx, chatId);
}

function chatIdOf(payload: Record<string, unknown>, type: string): string {
  const chatId = payload.chatId;
  if (typeof chatId !== "string" || chatId === "") throw new Error(`${type}: chatId missing from the payload`);
  return chatId;
}

export const handlers: JobHandlers = {
  "lh-sync": async (ctx) => {
    await runLhSync(ctx);
  },
  "concept-curate": async (ctx) => {
    await runConceptCurate(ctx);
  },
  "edges-derive": async (ctx) => {
    await runEdgesDerive(ctx);
  },
  "concept-review": async (ctx) => {
    await runConceptReview(ctx);
  },
  "session-ingest": async (ctx, job) => {
    await runSessionIngest(ctx, chatIdOf(job.payload, job.type));
  },
  "session-reingest": async (ctx, job) => {
    await runSessionReingest(ctx, chatIdOf(job.payload, job.type));
  },
  "sessions-idle-check": async (ctx) => {
    await runSessionsIdleCheck(ctx);
  },
};
