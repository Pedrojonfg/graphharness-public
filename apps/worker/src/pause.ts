// Pauses background jobs that use the cheap LLM while LH has a teacher turn in progress (ADR 105 point 18).
import { isoNow } from "@graphharness/core";
import type { Db } from "@graphharness/db";

/** Is there an LH session with a turn started, not yet settled, and started less than `staleMin` minutes ago? */
export function lhTurnInFlight(db: Db, now: Date, staleMin = 15): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM lh_sessions
         WHERE last_turn_started_at IS NOT NULL AND last_turn_started_at > ?
           AND (last_turn_settled_at IS NULL OR last_turn_settled_at < last_turn_started_at) LIMIT 1`,
      )
      .get(isoNow(new Date(now.getTime() - staleMin * 60_000))) !== undefined
  );
}

/** Job types deferred during an LH turn: those using the `cheap` LLM (`strong` and non-LLM jobs are not paused). */
export const PAUSABLE_JOB_TYPES: ReadonlySet<string> = new Set(["concept-curate", "concept-review", "session-ingest", "session-reingest", "cards-generate"]);
