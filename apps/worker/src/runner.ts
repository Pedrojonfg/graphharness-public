// Job loop: takes the next ready job, runs its handler, and completes it or retries with backoff.
import { claimNextJob, completeJob, deferJob, failJob, requeueStaleRunning, type JobRow } from "@graphharness/hub/services/jobs";
import type { HubContext } from "@graphharness/hub/services/context";
import { lhTurnInFlight, PAUSABLE_JOB_TYPES } from "./pause.ts";

export type JobHandler = (ctx: HubContext, job: JobRow) => Promise<void>;
export type JobHandlers = Record<string, JobHandler>;

const createdAtMs = (ctx: HubContext, id: string): number =>
  Date.parse(ctx.db.prepare("SELECT created_at FROM jobs WHERE id = ?").pluck().get(id) as string);

// constants instead of env (the worker does not read its own config); overridden through `opts` in runOnce.
export const TURN_PAUSE_DEFER_MS = 30_000;
export const TURN_PAUSE_MAX_DEFER_MS = 10 * 60_000;

/**
 * Runs at most one job. Returns the result, or null if nothing was ready.
 * A cheap-LLM job is deferred (`deferred`: back to the queue without consuming an attempt) while LH has a turn in progress,
 * unless it has been waiting more than `maxDeferMs` since it was created.
 */
export async function runOnce(
  ctx: HubContext,
  handlers: JobHandlers,
  { deferMs = TURN_PAUSE_DEFER_MS, maxDeferMs = TURN_PAUSE_MAX_DEFER_MS }: { deferMs?: number; maxDeferMs?: number } = {},
): Promise<{ job: JobRow; outcome: "done" | "retry" | "failed" | "deferred" } | null> {
  const now = ctx.now();
  const job = claimNextJob(ctx.db, now);
  if (!job) return null;
  if (PAUSABLE_JOB_TYPES.has(job.type) && lhTurnInFlight(ctx.db, now) && now.getTime() - createdAtMs(ctx, job.id) < maxDeferMs) {
    deferJob(ctx.db, job.id, new Date(now.getTime() + deferMs), now);
    return { job, outcome: "deferred" };
  }
  const handler = handlers[job.type];
  try {
    if (!handler) throw new Error(`job has no handler: ${job.type}`);
    await handler(ctx, job);
    completeJob(ctx.db, job.id, ctx.now());
    return { job, outcome: "done" };
  } catch (err) {
    console.error(`[worker] ${job.type} ${job.id} attempt ${job.attempts} failed:`, err);
    return { job, outcome: failJob(ctx.db, job.id, err, ctx.now()) };
  }
}

/** Drains the queue of whatever is already ready (tests and integration). */
export async function drain(ctx: HubContext, handlers: JobHandlers, max = 1000): Promise<number> {
  let n = 0;
  while (n < max && (await runOnce(ctx, handlers))) n++;
  return n;
}

export async function runForever(ctx: HubContext, handlers: JobHandlers, { idleMs = 2_000, signal }: { idleMs?: number; signal?: AbortSignal } = {}): Promise<void> {
  requeueStaleRunning(ctx.db, ctx.now());
  while (!signal?.aborted) {
    const r = await runOnce(ctx, handlers);
    if (!r) await new Promise((res) => setTimeout(res, idleMs));
  }
}
