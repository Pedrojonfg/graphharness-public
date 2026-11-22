// Sessions lane: session-close, report-session, report-master, backup.
import { spawn } from "node:child_process";
import { isoNow } from "@graphharness/core";
import type { HubContext } from "@graphharness/hub/services/context";
import { enqueueJob } from "@graphharness/hub/services/jobs";
import { generateMasterReport, generateSessionReport } from "@graphharness/hub/services/reports";
import { setSessionState } from "@graphharness/hub/services/sessions";
import type { JobHandlers } from "../runner.ts";
import { runConceptCurate, runEdgesDerive, runLhSync, runSessionIngest } from "./ingest.ts";
import { generateCardsForSession } from "./practice.ts";

/** Close step 1 (ADR 103 §3): GET /api/graph/status is polled every 10 s (re-enqueuing the job), for at most 15 min. */
export const COVERAGE_POLL_INTERVAL_MS = 10_000;
export const COVERAGE_MAX_WAIT_MS = 15 * 60_000;
/** Close step 7: debounce of the backup after a close. */
export const BACKUP_DEBOUNCE_MS = 2 * 60_000;
export const SESSION_CLOSE_BACKUP_REASON = "session close";

/**
 * Payload of `session-close`. Only `chatId` is set by the caller; `coverageStartedAt` is added by the job itself when it
 * re-enqueues itself while waiting for LH. `pollIntervalMs`/`maxWaitMs` replace the 10 s / 15 min defaults (configuration, tests).
 */
export interface SessionClosePayload {
  chatId: string;
  coverageStartedAt?: string;
  pollIntervalMs?: number;
  maxWaitMs?: number;
}

export type SessionCloseResult =
  /** LH is still extracting: `session-close` was re-enqueued to run after `pollIntervalMs` and this job ends. */
  | { status: "waiting"; nextJobId: string }
  | {
      status: "closed";
      /** LH's extraction did not finish in time: an incremental re-ingest was enqueued. */
      coverageTimedOut: boolean;
      reportId: string;
      masterReportId: string | null;
      cardIds: string[];
    };

/**
 * Close pipeline, without blocking the worker (ADR 103 §3):
 * 1. First pass: `extractCoverage` and the start time is recorded. While LH has an extraction for this chat and less than
 *    `maxWaitMs` has elapsed since the start (per `ctx.now()`), `session-close` is re-enqueued with `runAfter = now + pollIntervalMs`
 *    and this job ends. If the wait runs out, the pipeline continues and `session-reingest` is enqueued.
 * 2–7. lh-sync → concept-curate → edges-derive → session-ingest → cards → session report → master report →
 *    backup (2 min debounce). `closed` at the end; `failed` if anything fails (the error is rethrown so the runner retries).
 * Idempotent: each step is idempotent.
 */
export async function runSessionClose(ctx: HubContext, payload: SessionClosePayload): Promise<SessionCloseResult> {
  const { chatId } = payload;
  const interval = payload.pollIntervalMs ?? COVERAGE_POLL_INTERVAL_MS;
  const maxWait = payload.maxWaitMs ?? COVERAGE_MAX_WAIT_MS;
  if (!ctx.db.prepare("SELECT 1 FROM lh_sessions WHERE chat_id = ?").get(chatId)) throw new Error(`session-close: session ${chatId} is not in lh_sessions`);
  setSessionState(ctx, chatId, "closing");
  try {
    let startedAt = payload.coverageStartedAt;
    if (startedAt === undefined) {
      await ctx.lh.extractCoverage(chatId); // 202 "started" or 409 "already_running": both cases wait the same way
      startedAt = isoNow(ctx.now());
    }
    const running = (await ctx.lh.graphStatus()).some((r) => r.chatId === chatId);
    const waited = ctx.now().getTime() - Date.parse(startedAt);
    if (running && waited < maxWait) {
      const next: SessionClosePayload = { ...payload, coverageStartedAt: startedAt };
      const nextJobId = enqueueJob(ctx.db, "session-close", { ...next }, { now: ctx.now(), runAfter: new Date(ctx.now().getTime() + interval) });
      return { status: "waiting", nextJobId };
    }
    if (running) {
      console.warn(`[session-close] ${chatId}: LH extraction did not finish in ${maxWait / 1000} s; continuing and re-ingesting later`);
      enqueueJob(ctx.db, "session-reingest", { chatId }, { now: ctx.now(), runAfter: new Date(ctx.now().getTime() + maxWait) });
    }
    await runLhSync(ctx);
    await runConceptCurate(ctx);
    await runEdgesDerive(ctx);
    await runSessionIngest(ctx, chatId);
    const cardIds = await generateCardsForSession(ctx, chatId);
    const reportId = await generateSessionReport(ctx, chatId);
    // lh-sync may have set the subject during the close.
    const subjectId = (ctx.db.prepare("SELECT subject_id FROM lh_sessions WHERE chat_id = ?").pluck().get(chatId) as string | null) ?? null;
    const masterReportId = subjectId ? generateMasterReport(ctx, subjectId) : null;
    enqueueBackupDebounced(ctx, SESSION_CLOSE_BACKUP_REASON);
    setSessionState(ctx, chatId, "closed");
    return { status: "closed", coverageTimedOut: running, reportId, masterReportId, cardIds };
  } catch (err) {
    setSessionState(ctx, chatId, "failed");
    throw err;
  }
}

/**
 * Close step 7: 2 min debounce PER TYPE. If a `backup` is already queued (whatever its reason), another one is not enqueued:
 * its timer is reset to now + 2 min. Otherwise a new one is enqueued with that `runAfter`.
 */
export function enqueueBackupDebounced(ctx: HubContext, reason: string): string {
  const runAfter = new Date(ctx.now().getTime() + BACKUP_DEBOUNCE_MS);
  return ctx.db.transaction(() => {
    const queued = ctx.db.prepare("SELECT id FROM jobs WHERE type = 'backup' AND status = 'queued' ORDER BY run_after, id LIMIT 1").pluck().get() as
      | string
      | undefined;
    if (!queued) return enqueueJob(ctx.db, "backup", { reason }, { now: ctx.now(), runAfter, dedupe: false });
    ctx.db.prepare("UPDATE jobs SET run_after = ?, updated_at = ? WHERE id = ?").run(isoNow(runAfter), isoNow(ctx.now()), queued);
    return queued;
  })();
}

/** `backup` job: runs BACKUP_SCRIPT with the reason as an argument (no shell) and records `last_backup_at`. */
export async function runBackup(ctx: HubContext, reason: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(ctx.config.backupScript, [reason], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`backup failed (${signal ?? `exit code ${code}`}): ${stderr.trim()}`));
    });
  });
  const now = isoNow(ctx.now());
  ctx.db
    .prepare("INSERT INTO meta (key, value, updated_at) VALUES ('last_backup_at', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .run(now, now);
}

const str = (v: unknown, field: string): string => {
  if (typeof v !== "string" || v === "") throw new Error(`payload is missing ${field}`);
  return v;
};
const optNum = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);

export const handlers: JobHandlers = {
  "session-close": async (ctx, job) => {
    const p = job.payload;
    await runSessionClose(ctx, {
      chatId: str(p.chatId, "chatId"),
      coverageStartedAt: typeof p.coverageStartedAt === "string" && !Number.isNaN(Date.parse(p.coverageStartedAt)) ? p.coverageStartedAt : undefined,
      pollIntervalMs: optNum(p.pollIntervalMs),
      maxWaitMs: optNum(p.maxWaitMs),
    });
  },
  "report-session": async (ctx, job) => {
    await generateSessionReport(ctx, str(job.payload.chatId, "chatId"));
  },
  "report-master": async (ctx, job) => {
    generateMasterReport(ctx, str(job.payload.subjectId, "subjectId"));
  },
  backup: async (ctx, job) => {
    await runBackup(ctx, typeof job.payload.reason === "string" && job.payload.reason ? job.payload.reason : "manual");
  },
};
