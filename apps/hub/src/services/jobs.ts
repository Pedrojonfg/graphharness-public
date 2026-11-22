// Job queue: `jobs` table, 3 retries with exponential backoff. Handlers must be idempotent.
import { isoNow, ulid } from "@graphharness/core";
import type { Db } from "@graphharness/db";
import { canonicalJson } from "./evidence.ts";

export const MAX_JOB_ATTEMPTS = 3;
/** Backoff after attempt n (1-based): 1, 2, 4… minutes. */
export const backoffMs = (attempt: number): number => 60_000 * 2 ** (attempt - 1);

export interface JobRow {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  status: "queued" | "running" | "done" | "failed";
  attempts: number;
  runAfter: string;
  lastError: string | null;
}

interface RawJob {
  id: string;
  type: string;
  payload_json: string;
  status: JobRow["status"];
  attempts: number;
  run_after: string;
  last_error: string | null;
}

const toJob = (r: RawJob): JobRow => ({
  id: r.id,
  type: r.type,
  payload: JSON.parse(r.payload_json) as Record<string, unknown>,
  status: r.status,
  attempts: r.attempts,
  runAfter: r.run_after,
  lastError: r.last_error,
});

/**
 * Enqueues. With `dedupe` (default true) it does not duplicate a `queued` job of the same type and payload: it returns the existing one
 * (so the debounce of LH events and repeated triggers converge).
 */
export function enqueueJob(
  db: Db,
  type: string,
  payload: Record<string, unknown> = {},
  opts: { runAfter?: Date; dedupe?: boolean; now?: Date } = {},
): string {
  const now = opts.now ?? new Date();
  const json = canonicalJson(payload);
  return db.transaction(() => {
    if (opts.dedupe !== false) {
      const existing = db
        .prepare("SELECT id FROM jobs WHERE type = ? AND payload_json = ? AND status = 'queued'")
        .pluck()
        .get(type, json) as string | undefined;
      if (existing) return existing;
    }
    const id = ulid(now.getTime());
    db.prepare(
      `INSERT INTO jobs (id, type, payload_json, status, attempts, run_after, created_at, updated_at)
       VALUES (?, ?, ?, 'queued', 0, ?, ?, ?)`,
    ).run(id, type, json, isoNow(opts.runAfter ?? now), isoNow(now), isoNow(now));
    return id;
  })();
}

/** Takes the next ready job (run_after ≤ now) and marks it `running` with attempts+1. */
export function claimNextJob(db: Db, now: Date = new Date()): JobRow | null {
  return db.transaction(() => {
    const row = db
      .prepare("SELECT * FROM jobs WHERE status = 'queued' AND run_after <= ? ORDER BY run_after, rowid LIMIT 1")
      .get(isoNow(now)) as RawJob | undefined;
    if (!row) return null;
    db.prepare("UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?").run(isoNow(now), row.id);
    return toJob({ ...row, status: "running", attempts: row.attempts + 1 });
  })();
}

/** Returns a `running` job to the queue until `runAfter` without consuming the attempt `claimNextJob` added (pause for an LH turn). */
export function deferJob(db: Db, id: string, runAfter: Date, now: Date = new Date()): void {
  db.prepare("UPDATE jobs SET status = 'queued', attempts = max(attempts - 1, 0), run_after = ?, updated_at = ? WHERE id = ?").run(
    isoNow(runAfter),
    isoNow(now),
    id,
  );
}

export function completeJob(db: Db, id: string, now: Date = new Date()): void {
  db.prepare("UPDATE jobs SET status = 'done', last_error = NULL, updated_at = ? WHERE id = ?").run(isoNow(now), id);
}

/** Failure: re-enqueues with backoff if attempts remain; otherwise `failed`. */
export function failJob(db: Db, id: string, error: unknown, now: Date = new Date()): "retry" | "failed" {
  const job = db.prepare("SELECT attempts FROM jobs WHERE id = ?").get(id) as { attempts: number } | undefined;
  if (!job) throw new Error(`job ${id} does not exist`);
  const msg = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  if (job.attempts >= MAX_JOB_ATTEMPTS) {
    db.prepare("UPDATE jobs SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?").run(msg, isoNow(now), id);
    return "failed";
  }
  db.prepare("UPDATE jobs SET status = 'queued', last_error = ?, run_after = ?, updated_at = ? WHERE id = ?").run(
    msg,
    isoNow(new Date(now.getTime() + backoffMs(job.attempts))),
    isoNow(now),
    id,
  );
  return "retry";
}

/** Jobs left `running` by a worker restart go back to the queue (without spending an extra attempt). */
export function requeueStaleRunning(db: Db, now: Date = new Date()): number {
  return db.prepare("UPDATE jobs SET status = 'queued', attempts = max(attempts - 1, 0), updated_at = ? WHERE status = 'running'").run(isoNow(now))
    .changes;
}

export function jobQueueStats(db: Db): Record<JobRow["status"], number> {
  const out = { queued: 0, running: 0, done: 0, failed: 0 };
  for (const r of db.prepare("SELECT status, count(*) AS n FROM jobs GROUP BY status").all() as { status: JobRow["status"]; n: number }[])
    out[r.status] = r.n;
  return out;
}
