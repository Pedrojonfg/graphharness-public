// GET /health (settings page, > 1 GB backup warning, risks R2/R4/R8; ADR 102 §6 `meta`). Always responds:
// each service that is down is flagged in its block and in `ok: false`.
import { isoNow } from "@graphharness/core";
import type { Health } from "@graphharness/contracts";
import { llmConfigFromEnv } from "@graphharness/llm";
import type { HubContext } from "./context.ts";
import { jobQueueStats } from "./jobs.ts";

/** The worker is considered alive if it finished or has had a job running for less than this (periodic ones run every 5–10 min). */
const WORKER_ALIVE_MS = 15 * 60_000;
const PROBE_TIMEOUT_MS = 5_000;
/** R8: warning when the backup repo exceeds 1 GB. */
const BACKUP_WARN_BYTES = 1_000_000_000;
const LH_QUESTION_SOURCES = "('lh_quiz','lh_probe','lh_recall','lh_practice')";

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

async function probe(fn: () => Promise<unknown>): Promise<{ reachable: boolean; error: string | null }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new Error(`no response within ${PROBE_TIMEOUT_MS / 1000} s`)), PROBE_TIMEOUT_MS);
    });
    await Promise.race([fn(), timeout]);
    return { reachable: true, error: null };
  } catch (err) {
    return { reachable: false, error: message(err) };
  } finally {
    clearTimeout(timer);
  }
}

export async function health(ctx: HubContext, env: NodeJS.ProcessEnv = process.env): Promise<Health> {
  const db = ctx.db;
  const now = ctx.now();
  const meta = (key: string): string | null => (db.prepare("SELECT value FROM meta WHERE key = ?").pluck().get(key) as string | undefined) ?? null;

  const [lh, evalProbe] = await Promise.all([
    probe(() => ctx.lh.graphStatus()),
    probe(async () => {
      if (!(await ctx.evalApi.health())) throw new Error("eval does not respond");
    }),
  ]);
  const lastSyncAt =
    meta("last_lh_sync_at") ??
    ((db.prepare("SELECT max(last_synced_at) FROM (SELECT last_synced_at FROM lh_propositions UNION ALL SELECT last_synced_at FROM lh_chains)").pluck().get() as
      | string
      | null) ?? null);

  const lastHeartbeatAt = (db.prepare("SELECT max(updated_at) FROM jobs WHERE status IN ('done','running')").pluck().get() as string | null) ?? null;
  const alive = lastHeartbeatAt !== null && now.getTime() - Date.parse(lastHeartbeatAt) <= WORKER_ALIVE_MS;

  const stats = jobQueueStats(db);
  const oldestQueuedAt = (db.prepare("SELECT min(created_at) FROM jobs WHERE status = 'queued'").pluck().get() as string | null) ?? null;

  const lastBackupAt = meta("last_backup_at");
  const bytesRaw = meta("backup_repo_bytes");
  const bytes = bytesRaw === null || !Number.isFinite(Number(bytesRaw)) ? null : Math.max(0, Math.round(Number(bytesRaw)));
  const lastBackupJob = db.prepare("SELECT status FROM jobs WHERE type = 'backup' AND status IN ('done','failed') ORDER BY updated_at DESC, id DESC LIMIT 1").pluck().get() as
    | "done"
    | "failed"
    | undefined;
  const lastOk = lastBackupJob ? lastBackupJob === "done" : lastBackupAt !== null ? true : null;

  const llmConfig = llmConfigFromEnv(env);
  const openai = llmConfig.provider === "openai-compatible";
  const since = isoNow(new Date(now.getTime() - 86_400_000));
  const usage = db.prepare("SELECT count(*) AS calls, coalesce(sum(ok = 0), 0) AS failed FROM llm_usage WHERE at >= ?").get(since) as { calls: number; failed: number };

  // R2: % of LH questions with a concept = questions with lh_* evidence / (those + unassigned_questions).
  const assigned = db
    .prepare(
      `SELECT count(DISTINCT coalesce(json_extract(ref_json, '$.chatId'), '') || '/' || coalesce(json_extract(ref_json, '$.toolCallId'), ref_json))
       FROM evidence_events WHERE source IN ${LH_QUESTION_SOURCES}`,
    )
    .pluck()
    .get() as number;
  const unassigned = db.prepare("SELECT count(*) FROM unassigned_questions").pluck().get() as number;
  const total = assigned + unassigned;

  return {
    ok: lh.reachable && evalProbe.reachable && alive,
    lh: { ...lh, lastSyncAt },
    eval: evalProbe,
    worker: { alive, lastHeartbeatAt },
    jobs: { queued: stats.queued, running: stats.running, failed: stats.failed, oldestQueuedAt },
    backup: { lastAt: lastBackupAt, lastOk, repoSizeBytes: bytes, sizeWarning: bytes !== null && bytes > BACKUP_WARN_BYTES },
    llm: {
      provider: llmConfig.provider,
      cheapModel: (openai ? llmConfig.modelCheap : undefined) ?? llmConfig.tierCheap,
      strongModel: (openai ? llmConfig.modelStrong : undefined) ?? llmConfig.tierStrong,
      calls24h: usage.calls,
      failed24h: usage.failed,
    },
    metrics: { questionsWithConceptPct: total === 0 ? null : (assigned / total) * 100 },
  };
}
