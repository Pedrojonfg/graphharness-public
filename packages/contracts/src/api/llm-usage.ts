// Hub LLM usage for the Settings screen (R4; ADR 102 §12): GET /llm-usage?days=7, aggregated from `llm_usage`.
import { z } from "zod";
import { IsoDateTimeSchema } from "./common.ts";

export const LlmUsageQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(7),
});
export type LlmUsageQuery = z.infer<typeof LlmUsageQuerySchema>;

export const LlmUsageSchema = z.object({
  days: z.number().int().min(1),
  /** Start of the window (now − days). */
  since: IsoDateTimeSchema,
  /** One row per (task, provider, model), from most to fewest calls. NULL tokens count as 0. */
  rows: z.array(
    z.object({
      task: z.string(),
      provider: z.string(),
      model: z.string(),
      calls: z.number().int().nonnegative(),
      ok: z.number().int().nonnegative(),
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
    }),
  ),
});
export type LlmUsage = z.infer<typeof LlmUsageSchema>;
