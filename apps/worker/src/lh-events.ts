// SSE subscription to LH with a 5 s debounce and a full reconciliation on reconnect.
// Debounce: each relevant event restarts a 5 s timer; after 5 s of quiet, ONE lh-sync and one
// session-ingest per chat with turn-settled in the burst. Aborting discards what is pending.
import { isoNow } from "@graphharness/core";
import type { ServerEvent } from "@graphharness/lh-client";
import { enqueueJob } from "@graphharness/hub/services/jobs";
import type { HubContext } from "@graphharness/hub/services/context";

export const LH_EVENTS_DEBOUNCE_MS = 5_000;

export interface ListenOptions {
  debounceMs?: number;
  /** Reconnect backoff: starts at `minBackoffMs` and doubles up to `maxBackoffMs`. */
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

const SYNC_EVENTS: ReadonlySet<ServerEvent["type"]> = new Set(["turn-settled", "chats-changed", "sources-changed", "record-changed"]);

/**
 * Immediate effect of an event on the database: turn markers and reopening of closed sessions.
 * Returns whether the event requires a sync (debounce).
 */
export function applyLhEvent(ctx: HubContext, event: ServerEvent): boolean {
  const now = isoNow(ctx.now());
  if (event.type === "turn-started") {
    // Turn in progress; a closed session that receives a new turn is reopened (the next close is incremental).
    ctx.db
      .prepare(
        `UPDATE lh_sessions SET last_turn_started_at = ?,
           hub_state = CASE WHEN hub_state = 'closed' THEN 'open' ELSE hub_state END,
           closed_at = CASE WHEN hub_state = 'closed' THEN NULL ELSE closed_at END
         WHERE chat_id = ?`,
      )
      .run(now, event.chatId);
  }
  if (event.type === "turn-settled") ctx.db.prepare("UPDATE lh_sessions SET last_turn_settled_at = ? WHERE chat_id = ?").run(now, event.chatId);
  return SYNC_EVENTS.has(event.type);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Listens to `GET /api/events` until `signal` aborts. If the stream closes or fails, it reconnects with backoff
 * exponential and, on each reconnection, enqueues an immediate lh-sync (full reconciliation: something may have been missed).
 */
export async function listenLhEvents(ctx: HubContext, signal: AbortSignal, opts: ListenOptions = {}): Promise<void> {
  const debounceMs = opts.debounceMs ?? LH_EVENTS_DEBOUNCE_MS;
  const minBackoff = opts.minBackoffMs ?? 1_000;
  const maxBackoff = opts.maxBackoffMs ?? 60_000;

  let timer: ReturnType<typeof setTimeout> | null = null;
  const settledChats = new Set<string>();
  const flush = (): void => {
    timer = null;
    if (signal.aborted) return;
    enqueueJob(ctx.db, "lh-sync", {}, { now: ctx.now() });
    for (const chatId of settledChats) enqueueJob(ctx.db, "session-ingest", { chatId }, { now: ctx.now() });
    settledChats.clear();
  };
  const cancel = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
    settledChats.clear();
  };
  signal.addEventListener("abort", cancel, { once: true });

  let backoff = minBackoff;
  let reconnect = false;
  while (!signal.aborted) {
    if (reconnect) enqueueJob(ctx.db, "lh-sync", {}, { now: ctx.now() });
    try {
      await ctx.lh.subscribeEvents(
        (event) => {
          backoff = minBackoff; // the stream works: the next cut starts from zero
          if (!applyLhEvent(ctx, event)) return;
          if (event.type === "turn-settled") settledChats.add(event.chatId);
          if (timer) clearTimeout(timer);
          timer = setTimeout(flush, debounceMs);
        },
        { signal },
      );
    } catch (err) {
      console.error("[lh-events] LH event stream interrupted:", err);
    }
    if (signal.aborted) break;
    await sleep(backoff, signal);
    backoff = Math.min(backoff * 2, maxBackoff);
    reconnect = true;
  }
  cancel();
}
