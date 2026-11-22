// listenLhEvents (trigger 1 and reopening) with a fake subscribeEvents and simulated clocks.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeLh, makeTestContext } from "@graphharness/hub/testing";
import type { HubContext } from "@graphharness/hub/services/context";
import type { LhClient, ServerEvent } from "@graphharness/lh-client";
import { listenLhEvents } from "../../src/lh-events.ts";
import { count, jobs } from "./helpers.ts";

const T0 = "2026-11-10T09:00:00.000Z";
const DEBOUNCE = 5_000;

interface Conn {
  emit: (e: ServerEvent) => void;
  end: () => void;
  signal: AbortSignal;
}

/** Fake subscribeEvents: each call is a connection the test controls. */
function stream(opts: { failFirst?: boolean } = {}) {
  const conns: Conn[] = [];
  const lh: LhClient = fakeLh({
    subscribeEvents: (onEvent, o) =>
      new Promise<void>((resolve, reject) => {
        if (opts.failFirst && conns.length === 0) {
          conns.push({ emit: () => {}, end: () => {}, signal: o.signal });
          reject(new Error("LH is not responding"));
          return;
        }
        const conn: Conn = { emit: onEvent, end: resolve, signal: o.signal };
        conns.push(conn);
        o.signal.addEventListener("abort", () => resolve());
      }),
  });
  return { conns, lh };
}

const settle = () => vi.advanceTimersByTimeAsync(0);
const sessionRow = (ctx: HubContext, id: string) =>
  ctx.db.prepare("SELECT hub_state, last_turn_started_at, last_turn_settled_at, closed_at FROM lh_sessions WHERE chat_id = ?").get(id) as Record<string, string | null>;
const addSession = (ctx: HubContext, id: string, state = "open") =>
  ctx.db.prepare("INSERT INTO lh_sessions (chat_id, title, kind, hub_state) VALUES (?, ?, 'teaching', ?)").run(id, id, state);

async function start(over: { failFirst?: boolean } = {}) {
  const s = stream(over);
  const ctx = makeTestContext({ lh: s.lh, now: () => new Date() });
  const ac = new AbortController();
  const done = listenLhEvents(ctx, ac.signal);
  await settle();
  ctx.db.prepare("DELETE FROM jobs").run(); // discards a possible initial reconciliation
  return { ...s, ctx, ac, done };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(T0));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("listenLhEvents", () => {
  it("turn-started / turn-settled update last_turn_started_at / last_turn_settled_at with the context clock", async () => {
    const { ctx, conns, ac, done } = await start();
    addSession(ctx, "chat_x");
    expect(conns).toHaveLength(1);
    conns[0]!.emit({ type: "turn-started", chatId: "chat_x" });
    await settle();
    expect(sessionRow(ctx, "chat_x").last_turn_started_at).toBe(T0);
    await vi.advanceTimersByTimeAsync(2_000);
    conns[0]!.emit({ type: "turn-settled", chatId: "chat_x" });
    await settle();
    expect(sessionRow(ctx, "chat_x").last_turn_settled_at).toBe("2026-11-10T09:00:02.000Z");
    expect(sessionRow(ctx, "chat_x").last_turn_started_at).toBe(T0);
    ac.abort();
    await done;
  });

  it("several consecutive events → ONE lh-sync and ONE session-ingest after the 5 s debounce from the last one", async () => {
    const { ctx, conns, ac, done } = await start();
    addSession(ctx, "chat_x");
    const c = conns[0]!;
    c.emit({ type: "turn-started", chatId: "chat_x" });
    await vi.advanceTimersByTimeAsync(1_000);
    c.emit({ type: "turn-settled", chatId: "chat_x" });
    await vi.advanceTimersByTimeAsync(1_000);
    c.emit({ type: "record-changed", chatId: "chat_x" });
    await vi.advanceTimersByTimeAsync(1_000);
    c.emit({ type: "turn-settled", chatId: "chat_x" });
    c.emit({ type: "chats-changed" });
    await vi.advanceTimersByTimeAsync(DEBOUNCE - 1_000);
    expect(jobs(ctx.db, "lh-sync")).toEqual([]);
    expect(jobs(ctx.db, "session-ingest")).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(jobs(ctx.db, "lh-sync", "queued")).toHaveLength(1);
    expect(jobs(ctx.db, "session-ingest", "queued").map((j) => j.payload)).toEqual([{ chatId: "chat_x" }]);
    // Does not keep enqueuing without new events.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(jobs(ctx.db, "lh-sync")).toHaveLength(1);
    expect(jobs(ctx.db, "session-ingest")).toHaveLength(1);
    ac.abort();
    await done;
  });

  it("session-ingest for each distinct chat with turn-settled", async () => {
    const { ctx, conns, ac, done } = await start();
    addSession(ctx, "chat_x");
    addSession(ctx, "chat_y");
    conns[0]!.emit({ type: "turn-settled", chatId: "chat_x" });
    conns[0]!.emit({ type: "turn-settled", chatId: "chat_y" });
    await vi.advanceTimersByTimeAsync(DEBOUNCE + 100);
    expect(jobs(ctx.db, "session-ingest", "queued").map((j) => j.payload.chatId).sort()).toEqual(["chat_x", "chat_y"]);
    expect(jobs(ctx.db, "lh-sync", "queued")).toHaveLength(1);
    ac.abort();
    await done;
  });

  it("closed session + turn-started → back to 'open' (reopening)", async () => {
    const { ctx, conns, ac, done } = await start();
    addSession(ctx, "chat_x", "closed");
    ctx.db.prepare("UPDATE lh_sessions SET closed_at = ? WHERE chat_id = 'chat_x'").run("2026-11-10T08:00:00.000Z");
    conns[0]!.emit({ type: "turn-started", chatId: "chat_x" });
    await settle();
    expect(sessionRow(ctx, "chat_x").hub_state).toBe("open");
    expect(sessionRow(ctx, "chat_x").last_turn_started_at).toBe(T0);
    ac.abort();
    await done;
  });

  it("an 'open' session stays 'open' with its turns and another session is not altered", async () => {
    const { ctx, conns, ac, done } = await start();
    addSession(ctx, "chat_x");
    addSession(ctx, "chat_z", "closed");
    conns[0]!.emit({ type: "turn-started", chatId: "chat_x" });
    await settle();
    expect(sessionRow(ctx, "chat_x").hub_state).toBe("open");
    expect(sessionRow(ctx, "chat_z").hub_state).toBe("closed");
    expect(count(ctx.db, "SELECT count(*) FROM lh_sessions")).toBe(2);
    ac.abort();
    await done;
  });

  it("when the stream is cut it reconnects and does a full reconciliation (lh-sync)", async () => {
    const { ctx, conns, ac, done } = await start();
    conns[0]!.end();
    for (let i = 0; i < 90 && conns.length < 2; i++) await vi.advanceTimersByTimeAsync(1_000);
    expect(conns).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(DEBOUNCE + 100);
    expect(jobs(ctx.db, "lh-sync", "queued").length).toBeGreaterThanOrEqual(1);
    ac.abort();
    await done;
  });

  it("if subscribeEvents rejects (LH down) it also reconnects", async () => {
    const s = await start({ failFirst: true });
    for (let i = 0; i < 90 && s.conns.length < 2; i++) await vi.advanceTimersByTimeAsync(1_000);
    expect(s.conns).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(DEBOUNCE + 100);
    expect(jobs(s.ctx.db, "lh-sync", "queued").length).toBeGreaterThanOrEqual(1);
    s.ac.abort();
    await s.done;
  });

  it("stops when the signal is aborted: resolves, aborts the connection and does not reconnect", async () => {
    const { conns, ac, done, ctx } = await start();
    const signal = conns[0]!.signal;
    ac.abort();
    await vi.advanceTimersByTimeAsync(0);
    await expect(done).resolves.toBeUndefined();
    expect(signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(conns).toHaveLength(1);
    expect(jobs(ctx.db, "lh-sync")).toEqual([]);
  });

  it("aborting with a pending debounce enqueues nothing afterwards", async () => {
    const { ctx, conns, ac, done } = await start();
    addSession(ctx, "chat_x");
    conns[0]!.emit({ type: "turn-settled", chatId: "chat_x" });
    await vi.advanceTimersByTimeAsync(1_000);
    ac.abort();
    await done;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(jobs(ctx.db)).toEqual([]);
  });
});
