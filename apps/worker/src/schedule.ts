// Periodic triggers: lh-sync reconciliation every 10 min, sessions-idle-check every 5 min, declarations-expire hourly, weekly concept-review.
// The nightly backup is triggered by systemd (hub-backup.timer), not by this module.
import { enqueueJob } from "@graphharness/hub/services/jobs";
import type { HubContext } from "@graphharness/hub/services/context";

export const PERIODIC: { type: string; everyMs: number }[] = [
  { type: "lh-sync", everyMs: 10 * 60_000 },
  { type: "sessions-idle-check", everyMs: 5 * 60_000 },
  { type: "declarations-expire", everyMs: 60 * 60_000 },
  { type: "concept-review", everyMs: 7 * 24 * 60 * 60_000 },
];

/** Enqueues the periodic jobs that are due (dedupe avoids duplicates if the previous one is still queued). */
export function tickSchedule(ctx: HubContext, last: Map<string, number>): void {
  const now = ctx.now().getTime();
  for (const p of PERIODIC) {
    if (now - (last.get(p.type) ?? 0) < p.everyMs) continue;
    enqueueJob(ctx.db, p.type, {}, { now: ctx.now() });
    last.set(p.type, now);
  }
}
