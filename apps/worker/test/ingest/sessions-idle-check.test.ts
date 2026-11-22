// Automatic close: 45 min without turn-started since the last turn-settled and ≥ 1 answered question.
import { describe, expect, it } from "vitest";
import { makeTestContext, seedConcept } from "@graphharness/hub/testing";
import { recordEvidence } from "@graphharness/hub/services/evidence";
import type { HubContext } from "@graphharness/hub/services/context";
import { handlers } from "../../src/handlers/ingest.ts";
import { count, jobs } from "./helpers.ts";

const NOW = Date.parse("2026-11-10T09:00:00.000Z");
const ago = (min: number): string => new Date(NOW - min * 60_000).toISOString();

function session(ctx: HubContext, chatId: string, o: { settledMinAgo: number | null; startedMinAgo?: number | null; state?: string; withEvidence?: boolean }): void {
  ctx.db
    .prepare("INSERT INTO lh_sessions (chat_id, title, kind, last_turn_settled_at, last_turn_started_at, hub_state) VALUES (?, ?, 'teaching', ?, ?, ?)")
    .run(chatId, chatId, o.settledMinAgo === null ? null : ago(o.settledMinAgo), o.startedMinAgo == null ? null : ago(o.startedMinAgo), o.state ?? "open");
  if (o.withEvidence !== false) {
    const c = seedConcept(ctx.db);
    recordEvidence(ctx.db, { conceptId: c, at: ago(60), source: "lh_probe", correct: true, responseFormat: "mcq", ref: { chatId, toolCallId: "t1" } }, ctx.now());
  }
}
const run = (ctx: HubContext) => handlers["sessions-idle-check"]!(ctx, { id: "j", type: "sessions-idle-check", payload: {}, status: "running", attempts: 1, runAfter: "", lastError: null });
const state = (ctx: HubContext, id: string) => ctx.db.prepare("SELECT hub_state FROM lh_sessions WHERE chat_id = ?").pluck().get(id) as string;

describe("sessions-idle-check", () => {
  it("46 min after the last turn-settled, with no later turn-started and with evidence → closing + session-close", async () => {
    const ctx = makeTestContext();
    session(ctx, "chat_old", { settledMinAgo: 46, startedMinAgo: 50 });
    await run(ctx);
    expect(state(ctx, "chat_old")).toBe("closing");
    expect(jobs(ctx.db, "session-close", "queued").map((j) => j.payload)).toEqual([{ chatId: "chat_old" }]);
  });

  it("44 min → nothing", async () => {
    const ctx = makeTestContext();
    session(ctx, "chat_recent", { settledMinAgo: 44, startedMinAgo: 50 });
    await run(ctx);
    expect(state(ctx, "chat_recent")).toBe("open");
    expect(jobs(ctx.db, "session-close")).toEqual([]);
  });

  it("no answered questions (no evidence for that session) → nothing", async () => {
    const ctx = makeTestContext();
    session(ctx, "chat_empty", { settledMinAgo: 120, startedMinAgo: 130, withEvidence: false });
    // Evidence from ANOTHER session does not count.
    session(ctx, "chat_other", { settledMinAgo: 10, startedMinAgo: 12 });
    await run(ctx);
    expect(state(ctx, "chat_empty")).toBe("open");
    expect(jobs(ctx.db, "session-close")).toEqual([]);
  });

  it("a turn-started after the last turn-settled (turn in progress) → nothing", async () => {
    const ctx = makeTestContext();
    session(ctx, "chat_running", { settledMinAgo: 90, startedMinAgo: 80 });
    await run(ctx);
    expect(state(ctx, "chat_running")).toBe("open");
    expect(jobs(ctx.db, "session-close")).toEqual([]);
  });

  it("no turn-settled yet → nothing; sessions already closing/closed/failed are neither touched nor re-enqueued", async () => {
    const ctx = makeTestContext();
    session(ctx, "chat_new", { settledMinAgo: null });
    session(ctx, "chat_closing", { settledMinAgo: 200, state: "closing" });
    session(ctx, "chat_closed", { settledMinAgo: 200, state: "closed" });
    session(ctx, "chat_failed", { settledMinAgo: 200, state: "failed" });
    await run(ctx);
    expect(state(ctx, "chat_new")).toBe("open");
    expect([state(ctx, "chat_closing"), state(ctx, "chat_closed"), state(ctx, "chat_failed")]).toEqual(["closing", "closed", "failed"]);
    expect(jobs(ctx.db, "session-close")).toEqual([]);
  });

  it("is idempotent and closes only the ones that qualify, each one once", async () => {
    const ctx = makeTestContext();
    session(ctx, "chat_a", { settledMinAgo: 46, startedMinAgo: 60 });
    session(ctx, "chat_b", { settledMinAgo: 100, startedMinAgo: 110 });
    session(ctx, "chat_c", { settledMinAgo: 5, startedMinAgo: 8 });
    await run(ctx);
    await run(ctx);
    expect(jobs(ctx.db, "session-close", "queued").map((j) => j.payload.chatId).sort()).toEqual(["chat_a", "chat_b"]);
    expect(count(ctx.db, "SELECT count(*) FROM lh_sessions WHERE hub_state = 'closing'")).toBe(2);
    expect(state(ctx, "chat_c")).toBe("open");
  });
});
