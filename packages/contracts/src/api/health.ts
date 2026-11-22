// GET /health (Settings screen, R2, R4, R8; ADR 102 §6 `meta`).
// Always 200: a service that is down is reported in its block and in `ok: false`, so that Settings can render it.
import { z } from "zod";
import { IsoDateTimeSchema } from "./common.ts";

const probe = z.object({
  reachable: z.boolean(),
  /** Message of the last failure, if any. */
  error: z.string().nullable(),
});

export const HealthSchema = z.object({
  /** Everything reachable and the worker alive. */
  ok: z.boolean(),
  lh: probe.extend({ lastSyncAt: IsoDateTimeSchema.nullable() }),
  eval: probe,
  worker: z.object({ alive: z.boolean(), lastHeartbeatAt: IsoDateTimeSchema.nullable() }),
  jobs: z.object({
    queued: z.number().int().nonnegative(),
    running: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    oldestQueuedAt: IsoDateTimeSchema.nullable(),
  }),
  backup: z.object({
    lastAt: IsoDateTimeSchema.nullable(),
    lastOk: z.boolean().nullable(),
    repoSizeBytes: z.number().int().nonnegative().nullable(),
    /** Warning from 1 GB on (R8). */
    sizeWarning: z.boolean(),
  }),
  llm: z.object({
    provider: z.enum(["claude-cli", "openai-compatible"]),
    cheapModel: z.string(),
    strongModel: z.string(),
    /** Calls in the last 24 h, from `llm_usage` (R4). */
    calls24h: z.number().int().nonnegative(),
    failed24h: z.number().int().nonnegative(),
  }),
  metrics: z.object({
    /** % of LH questions with an assigned concept (R2); null if there are no questions. */
    questionsWithConceptPct: z.number().min(0).max(100).nullable(),
  }),
});
export type Health = z.infer<typeof HealthSchema>;
