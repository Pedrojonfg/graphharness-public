// Hub LLM usage for the settings page (risk R4; ADR 102 §12): GET /llm-usage?days.
import { isoNow } from "@graphharness/core";
import type { LlmUsage } from "@graphharness/contracts";
import type { HubContext } from "./context.ts";

export function llmUsage(ctx: HubContext, days: number): LlmUsage {
  const since = isoNow(new Date(ctx.now().getTime() - days * 86_400_000));
  const rows = ctx.db
    .prepare(
      `SELECT task, provider, model, count(*) AS calls, coalesce(sum(ok), 0) AS ok,
         coalesce(sum(input_tokens), 0) AS inputTokens, coalesce(sum(output_tokens), 0) AS outputTokens
       FROM llm_usage WHERE at >= ? GROUP BY task, provider, model ORDER BY calls DESC, task, provider, model`,
    )
    .all(since) as LlmUsage["rows"];
  return { days, since, rows };
}
