// Pausing cheap jobs during an LH turn: lhTurnInFlight (lh_sessions, SSE markers from lh-events.ts),
// PAUSABLE_JOB_TYPES and the deferral in runOnce (back to queued, run_after = now + deferMs, without consuming an attempt).
import { describe, expect, it } from "vitest";
import { isoNow } from "@graphharness/core";
import type { Db } from "@graphharness/db";
import { enqueueJob } from "@graphharness/hub/services/jobs";
import { makeTestContext, setNow } from "@graphharness/hub/testing";
import { ALL_HANDLERS } from "../../src/handlers/index.ts";
import { lhTurnInFlight, PAUSABLE_JOB_TYPES } from "../../src/pause.ts";
import { runOnce, type JobHandlers } from "../../src/runner.ts";

const T0 = "2026-11-10T09:00:00.000Z";
const NOW = new Date(T0);
const MIN = 60_000;
const ago = (ms: number, from: Date = NOW): string => isoNow(new Date(from.getTime() - ms));
const after = (ms: number, from: Date = NOW): string => isoNow(new Date(from.getTime() + ms));

let chatN = 0;
function session(db: Db, started: string | null, settled: string | null): void {
  db.prepare("INSERT INTO lh_sessions (chat_id, title, kind, last_turn_started_at, last_turn_settled_at) VALUES (?, 't', 'teaching', ?, ?)").run(
    `chat_${++chatN}`,
    started,
    settled,
  );
}

type JobDbRow = { id: string; status: string; attempts: number; run_after: string; created_at: string };
const jobRow = (db: Db, id: string): JobDbRow => db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobDbRow;

/** Fake handlers that only record what was executed. */
function recorder() {
  const ran: string[] = [];
  const h = (type: string) => async () => {
    ran.push(type);
  };
  const handlers: JobHandlers = { "concept-curate": h("concept-curate"), "session-ingest": h("session-ingest"), "lh-sync": h("lh-sync"), "session-close": h("session-close") };
  return { ran, handlers };
}

describe("lhTurnInFlight", () => {
  it("no sessions → false", () => {
    const ctx = makeTestContext();
    expect(lhTurnInFlight(ctx.db, NOW)).toBe(false);
  });

  it("turn started 1 min ago and never settled → true", () => {
    const ctx = makeTestContext();
    session(ctx.db, ago(MIN), null);
    expect(lhTurnInFlight(ctx.db, NOW)).toBe(true);
  });

  it("turn started after the last settled one (new turn in progress) → true", () => {
    const ctx = makeTestContext();
    session(ctx.db, ago(MIN), ago(5 * MIN));
    expect(lhTurnInFlight(ctx.db, NOW)).toBe(true);
  });

  it("turn already settled (settled = started or settled > started) → false", () => {
    const ctx = makeTestContext();
    session(ctx.db, ago(2 * MIN), ago(2 * MIN));
    session(ctx.db, ago(3 * MIN), ago(MIN));
    expect(lhTurnInFlight(ctx.db, NOW)).toBe(false);
  });

  it("session without turns (both markers null) → false", () => {
    const ctx = makeTestContext();
    session(ctx.db, null, null);
    expect(lhTurnInFlight(ctx.db, NOW)).toBe(false);
  });

  it("turn not settled but old (16 min > 15) → false: the turn-settled is considered lost", () => {
    const ctx = makeTestContext();
    session(ctx.db, ago(16 * MIN), null);
    expect(lhTurnInFlight(ctx.db, NOW)).toBe(false);
  });

  it("configurable staleMin: 16 min with staleMin 30 → true", () => {
    const ctx = makeTestContext();
    session(ctx.db, ago(16 * MIN), null);
    expect(lhTurnInFlight(ctx.db, NOW, 30)).toBe(true);
  });

  it("one session in progress among several settled ones is enough", () => {
    const ctx = makeTestContext();
    session(ctx.db, ago(10 * MIN), ago(9 * MIN));
    session(ctx.db, ago(MIN), null);
    session(ctx.db, ago(20 * MIN), null);
    expect(lhTurnInFlight(ctx.db, NOW)).toBe(true);
  });
});

describe("PAUSABLE_JOB_TYPES", () => {
  it("includes the background jobs that use the cheap LLM", () => {
    for (const t of ["concept-curate", "concept-review", "session-ingest", "session-reingest", "cards-generate"]) expect(PAUSABLE_JOB_TYPES.has(t), t).toBe(true);
  });

  it("does not include lh-sync, session-close, backup or jobs without an LLM", () => {
    for (const t of ["lh-sync", "session-close", "backup", "edges-derive", "sessions-idle-check", "declarations-expire"])
      expect(PAUSABLE_JOB_TYPES.has(t), t).toBe(false);
  });

  it("all its types are registered jobs (no typos)", () => {
    for (const t of PAUSABLE_JOB_TYPES) expect(ALL_HANDLERS, t).toHaveProperty([t]);
  });
});

describe("runOnce with an LH turn in progress", () => {
  function setup() {
    const ctx = makeTestContext({ nowIso: T0 });
    const { ran, handlers } = recorder();
    return { ctx, ran, handlers };
  }

  it("recent pausable job → 'deferred': not executed, back to queued with run_after = now + 30 s and attempts untouched", async () => {
    const { ctx, ran, handlers } = setup();
    session(ctx.db, ago(MIN), null);
    const id = enqueueJob(ctx.db, "concept-curate", {}, { now: NOW });
    const r = await runOnce(ctx, handlers);
    expect(r?.outcome).toBe("deferred");
    expect(r?.job.id).toBe(id);
    expect(ran).toEqual([]);
    expect(jobRow(ctx.db, id)).toMatchObject({ status: "queued", attempts: 0, run_after: after(30_000) });
    // Not ready yet: nothing can run until run_after.
    expect(await runOnce(ctx, handlers)).toBeNull();
  });

  it("configurable deferMs", async () => {
    const { ctx, handlers } = setup();
    session(ctx.db, ago(MIN), null);
    const id = enqueueJob(ctx.db, "session-ingest", { chatId: "c" }, { now: NOW });
    expect((await runOnce(ctx, handlers, { deferMs: 5_000 }))?.outcome).toBe("deferred");
    expect(jobRow(ctx.db, id).run_after).toBe(after(5_000));
  });

  it("deferring several times does not consume attempts", async () => {
    const { ctx, ran, handlers } = setup();
    session(ctx.db, ago(MIN), null);
    const id = enqueueJob(ctx.db, "concept-curate", {}, { now: NOW });
    expect((await runOnce(ctx, handlers))?.outcome).toBe("deferred");
    setNow(ctx, after(30_000));
    expect((await runOnce(ctx, handlers))?.outcome).toBe("deferred");
    setNow(ctx, after(60_000));
    expect((await runOnce(ctx, handlers))?.outcome).toBe("deferred");
    expect(ran).toEqual([]);
    expect(jobRow(ctx.db, id)).toMatchObject({ status: "queued", attempts: 0, run_after: after(90_000) });
  });

  it("when the turn settles, the deferred job runs with its first attempt", async () => {
    const { ctx, ran, handlers } = setup();
    session(ctx.db, ago(MIN), null);
    const id = enqueueJob(ctx.db, "concept-curate", {}, { now: NOW });
    await runOnce(ctx, handlers);
    ctx.db.prepare("UPDATE lh_sessions SET last_turn_settled_at = ?").run(after(10_000));
    setNow(ctx, after(30_000));
    expect((await runOnce(ctx, handlers))?.outcome).toBe("done");
    expect(ran).toEqual(["concept-curate"]);
    expect(jobRow(ctx.db, id)).toMatchObject({ status: "done", attempts: 1 });
  });

  it("if the job has been queued for more than maxDeferMs (10 min), it runs anyway", async () => {
    const { ctx, ran, handlers } = setup();
    const id = enqueueJob(ctx.db, "concept-curate", {}, { now: new Date(ago(11 * MIN)) });
    session(ctx.db, ago(MIN), null);
    expect((await runOnce(ctx, handlers))?.outcome).toBe("done");
    expect(ran).toEqual(["concept-curate"]);
    expect(jobRow(ctx.db, id)).toMatchObject({ status: "done", attempts: 1 });
  });

  it("configurable maxDeferMs: 1 min → a job from 2 min ago runs", async () => {
    const { ctx, ran, handlers } = setup();
    enqueueJob(ctx.db, "concept-curate", {}, { now: new Date(ago(2 * MIN)) });
    session(ctx.db, ago(MIN), null);
    expect((await runOnce(ctx, handlers, { maxDeferMs: MIN }))?.outcome).toBe("done");
    expect(ran).toEqual(["concept-curate"]);
  });

  it("non-pausable jobs (lh-sync, session-close) always run", async () => {
    const { ctx, ran, handlers } = setup();
    session(ctx.db, ago(MIN), null);
    enqueueJob(ctx.db, "lh-sync", {}, { now: NOW });
    enqueueJob(ctx.db, "session-close", { chatId: "c" }, { now: NOW });
    expect((await runOnce(ctx, handlers))?.outcome).toBe("done");
    expect((await runOnce(ctx, handlers))?.outcome).toBe("done");
    expect(ran).toEqual(["lh-sync", "session-close"]);
  });

  it("a non-pausable job behind a deferred one runs on the next pass", async () => {
    const { ctx, ran, handlers } = setup();
    session(ctx.db, ago(MIN), null);
    enqueueJob(ctx.db, "concept-curate", {}, { now: NOW });
    enqueueJob(ctx.db, "lh-sync", {}, { now: NOW });
    expect((await runOnce(ctx, handlers))?.outcome).toBe("deferred");
    const r = await runOnce(ctx, handlers);
    expect(r?.job.type).toBe("lh-sync");
    expect(r?.outcome).toBe("done");
    expect(ran).toEqual(["lh-sync"]);
  });
});

describe("runOnce without an LH turn in progress (usual behavior)", () => {
  it.each([
    ["no sessions", null, null],
    ["settled turn", ago(2 * MIN), ago(MIN)],
    ["old unsettled turn (> 15 min)", ago(16 * MIN), null],
  ] as const)("%s → the pausable job runs (done, attempts 1)", async (_name, started, settled) => {
    const ctx = makeTestContext({ nowIso: T0 });
    const { ran, handlers } = recorder();
    if (started !== null) session(ctx.db, started, settled);
    const id = enqueueJob(ctx.db, "concept-curate", {}, { now: NOW });
    expect((await runOnce(ctx, handlers))?.outcome).toBe("done");
    expect(ran).toEqual(["concept-curate"]);
    expect(jobRow(ctx.db, id)).toMatchObject({ status: "done", attempts: 1 });
  });
});
