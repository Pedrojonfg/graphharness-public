// ADR 105 §6 (19, 20): `prior-report` job. Waits for LH to finish extracting the imported material (like session-close, ADR 103 §3),
// syncs and curates, then builds the prior-knowledge report from the propositions of the imported paths.
import { createHash } from "node:crypto";
import { isoNow } from "@graphharness/core";
import type { HubContext } from "@graphharness/hub/services/context";
import { enqueueJob } from "@graphharness/hub/services/jobs";
import { buildPriorReport } from "@graphharness/hub/services/prior";
import type { JobHandlers } from "../runner.ts";
import { getMeta, META_LH_FILE_SOURCES } from "../ingest/common.ts";
import { runConceptCurate, runLhSync } from "./ingest.ts";
import { COVERAGE_MAX_WAIT_MS, COVERAGE_POLL_INTERVAL_MS } from "./sessions.ts";

/** `paths` are LH paths (relative to the materials folder). `startedAt` is set by the trigger; the job adds it if missing. */
export interface PriorReportPayload {
  subjectId: string;
  paths: string[];
  startedAt?: string;
  pollIntervalMs?: number;
  maxWaitMs?: number;
}

/**
 * While LH has ANY extraction in progress and less than `maxWaitMs` has passed since `startedAt`, the job is re-enqueued at
 * `pollIntervalMs` and ends. Idempotent by (subjectId, paths, startedAt): the report id is derived from that key.
 */
export async function runPriorReport(ctx: HubContext, payload: PriorReportPayload): Promise<{ status: "waiting" | "done" | "exists" }> {
  const startedAt = payload.startedAt ?? isoNow(ctx.now());
  const reportId = `prior_${createHash("sha256").update(JSON.stringify([payload.subjectId, payload.paths, startedAt])).digest("hex").slice(0, 24)}`;
  if (ctx.db.prepare("SELECT 1 FROM prior_reports WHERE id = ?").get(reportId)) return { status: "exists" };

  const maxWait = payload.maxWaitMs ?? COVERAGE_MAX_WAIT_MS;
  const running = (await ctx.lh.graphStatus()).length > 0;
  if (running && ctx.now().getTime() - Date.parse(startedAt) < maxWait) {
    const runAfter = new Date(ctx.now().getTime() + (payload.pollIntervalMs ?? COVERAGE_POLL_INTERVAL_MS));
    enqueueJob(ctx.db, "prior-report", { ...payload, startedAt }, { now: ctx.now(), runAfter });
    return { status: "waiting" };
  }
  if (running) console.warn(`[prior-report] LH is still extracting after ${maxWait / 1000} s; building the report with what is available`);

  await runLhSync(ctx);
  await runConceptCurate(ctx);
  const sources = JSON.parse(getMeta(ctx.db, META_LH_FILE_SOURCES) ?? "{}") as Record<string, string>;
  const srcIds = new Set(Object.entries(sources).filter(([, path]) => payload.paths.includes(path)).map(([src]) => src));
  const propositionIds = (ctx.db.prepare("SELECT id, provenance_json FROM lh_propositions WHERE deleted = 0 ORDER BY id").all() as { id: string; provenance_json: string }[])
    .filter((p) => (JSON.parse(p.provenance_json) as { chatId: string }[]).some((x) => srcIds.has(x.chatId)))
    .map((p) => p.id);
  await buildPriorReport(ctx, { subjectId: payload.subjectId, propositionIds, excludeSourcePaths: payload.paths, id: reportId });
  return { status: "done" };
}

export const handlers: JobHandlers = {
  "prior-report": async (ctx, job) => {
    const p = job.payload;
    if (typeof p.subjectId !== "string" || p.subjectId === "") throw new Error("prior-report: payload is missing subjectId");
    if (!Array.isArray(p.paths) || p.paths.length === 0 || p.paths.some((x) => typeof x !== "string" || x === "")) throw new Error("prior-report: payload is missing paths");
    const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
    await runPriorReport(ctx, {
      subjectId: p.subjectId,
      paths: p.paths as string[],
      startedAt: typeof p.startedAt === "string" && !Number.isNaN(Date.parse(p.startedAt)) ? p.startedAt : undefined,
      pollIntervalMs: num(p.pollIntervalMs),
      maxWaitMs: num(p.maxWaitMs),
    });
  },
};
