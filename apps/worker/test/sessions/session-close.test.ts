// L4 — session-close job (ADR 105) with the REAL pipeline (runLhSync, curator, ingestion...) over an already seeded database.
import { RenderReportResponseSchema, SessionReportDataSchema } from "@graphharness/contracts";
import type { ChatDetail, GraphSnapshot, GraphStatusRun } from "@graphharness/lh-client";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { call, brokenLlm, autoLlm, conceptIn, count, fakeJob, insertSession, mastery, subject, world, NOW, type Ctx } from "../../../hub/test/knowledge/helpers.ts";
import { sessionsTools } from "../../../hub/src/mcp/sessions.ts";
import { fakeLh, seedProposition, setNow } from "../../../hub/src/testing.ts";
import { enqueueJob } from "../../../hub/src/services/jobs.ts";
import { ALL_HANDLERS } from "../../src/handlers/index.ts";
import { drain, runOnce } from "../../src/runner.ts";

const FIX = new URL("../../../../packages/lh-client/fixtures/synthetic/http/", import.meta.url);
const CHAT: ChatDetail = JSON.parse(readFileSync(new URL("chat.json", FIX), "utf8"));
const MARKDOWN = readFileSync(new URL("chat-markdown.md", FIX), "utf8");
const CHAT_ID = CHAT.id;

const pdflatexOk = (() => {
  try {
    execFileSync("pdflatex", ["--version"], { stdio: "ignore" });
    return true;
  } catch (e) {
    console.warn("pdflatex not available; skipping the render:", (e as Error).message);
    return false;
  }
})();

interface Calls {
  extract: string[];
  status: number;
}

function setup(opts: { llm?: ReturnType<typeof autoLlm>; alreadyRunning?: boolean } = {}) {
  const calls: Calls = { extract: [], status: 0 };
  // extractions "in progress" according to LH; the tests empty it to simulate that it finished
  const runs: { current: GraphStatusRun[] } = { current: [] };
  let subjectId = "";
  const propsInDb: { id: string; name: string; statement: string }[] = [];
  const lh = fakeLh({
    async extractCoverage(chatId: string) {
      calls.extract.push(chatId);
      return { status: opts.alreadyRunning ? ("already_running" as const) : ("started" as const) };
    },
    async graphStatus() {
      calls.status++;
      return runs.current;
    },
    async getChat(id: string) {
      if (id !== CHAT_ID) throw new Error(`unexpected getChat: ${id}`);
      return CHAT;
    },
    async getChatMarkdown() {
      return MARKDOWN;
    },
    async listChats() {
      return [];
    },
    // the LH graph = exactly the propositions already seeded, no chains: lh-sync has nothing new to do
    async getGraph(): Promise<GraphSnapshot> {
      return {
        propositions: propsInDb.map((p) => ({ id: p.id, name: p.name, statement: p.statement, aliases: [], provenance: [], createdAt: NOW })),
        chains: [],
      };
    },
  });
  const reportsDir = mkdtempSync(join(tmpdir(), "gh-close-"));
  const w = world({ lh, llm: opts.llm ?? autoLlm(), config: { reportsDir } });
  subjectId = subject(w.ctx, "Linear Algebra");
  const c1 = conceptIn(w.ctx, subjectId, "Eigenvalues");
  const c2 = conceptIn(w.ctx, subjectId, "Diagonalization");
  for (const [c, i] of [[c1, 1], [c2, 2]] as const) {
    const id = seedProposition(w.ctx.db, { name: `prop-${i}`, statement: `Statement ${i}`, conceptId: c });
    propsInDb.push({ id, name: `prop-${i}`, statement: `Statement ${i}` });
  }
  mastery(w.ctx, c1, "weak");
  insertSession(w.ctx.db, { chatId: CHAT_ID, title: CHAT.title, kind: "practice", subjectId, hubState: "open" });
  return { ...w, calls, runs, s: subjectId, c1, c2, reportsDir };
}

const closeAndDrain = async (ctx: Ctx) => {
  await sessionsTools.close_session!(ctx, { chatId: CHAT_ID });
  return drain(ctx, ALL_HANDLERS);
};
const queuedBackups = (ctx: Ctx) => ctx.db.prepare("SELECT run_after FROM jobs WHERE type = 'backup' AND status = 'queued'").all() as { run_after: string }[];

const liveRun = (chatId = CHAT_ID): GraphStatusRun => ({ id: chatId, chatId, title: "extraction", phase: "extracting", startedAt: 0 });
const queuedClose = (ctx: Ctx) => ctx.db.prepare("SELECT run_after FROM jobs WHERE type = 'session-close' AND status = 'queued'").all() as { run_after: string }[];
const stateOf = (ctx: Ctx) => ctx.db.prepare("SELECT hub_state FROM lh_sessions WHERE chat_id = ?").pluck().get(CHAT_ID);
const at = (offsetMs: number): string => new Date(Date.parse(NOW) + offsetMs).toISOString();

let t: ReturnType<typeof setup>;
beforeEach(() => {
  t = setup();
});

describe("session-close (full pipeline)", () => {
  it("forced extraction, session 'closed', report with an uncompiled .tex, master and debounced backup", async () => {
    const { ctx, calls, s } = t;
    await closeAndDrain(ctx);

    expect(calls.extract).toEqual([CHAT_ID]);
    const sess = ctx.db.prepare("SELECT hub_state, closed_at FROM lh_sessions WHERE chat_id = ?").get(CHAT_ID) as { hub_state: string; closed_at: string | null };
    expect(sess.hub_state).toBe("closed");
    expect(sess.closed_at).not.toBeNull();
    expect(ctx.db.prepare("SELECT status FROM jobs WHERE type = 'session-close'").pluck().all()).toEqual(["done"]);

    const rep = ctx.db.prepare("SELECT * FROM reports WHERE kind = 'session' AND chat_id = ?").get(CHAT_ID) as Record<string, any>;
    expect(rep).toBeTruthy();
    expect(rep.tex).toContain("\\begin{document}");
    expect(rep.pdf_path).toBeNull(); // not compiled until requested
    const data = SessionReportDataSchema.parse(JSON.parse(rep.data_json));
    expect(data).toMatchObject({ chatId: CHAT_ID, subjectId: s, subjectName: "Linear Algebra" });
    expect(data.text).not.toBeNull(); // the fake LLM answered

    const masters = ctx.db.prepare("SELECT tex, pdf_path FROM reports WHERE kind = 'master' AND subject_id = ?").all(s) as { tex: string; pdf_path: string | null }[];
    expect(masters).toHaveLength(1);
    expect(masters[0]!.tex).toContain("\\begin{document}");
    expect(masters[0]!.pdf_path).toBeNull();

    const backups = queuedBackups(ctx);
    expect(backups).toHaveLength(1);
    expect(backups[0]!.run_after >= new Date(Date.parse(NOW) + 120_000).toISOString()).toBe(true);
  });

  it("extraction 409 (already_running) is treated as already running and the close finishes anyway", async () => {
    const w = setup({ alreadyRunning: true });
    await closeAndDrain(w.ctx);
    expect(w.calls.extract).toEqual([CHAT_ID]);
    expect(w.ctx.db.prepare("SELECT hub_state FROM lh_sessions WHERE chat_id = ?").pluck().get(CHAT_ID)).toBe("closed");
  });

  it("waits until graphStatus has no extractions before continuing (it queries it at least once)", async () => {
    await closeAndDrain(t.ctx);
    expect(t.calls.status).toBeGreaterThanOrEqual(1);
  });

  it("is idempotent: closing again does not duplicate the master nor the queued backup", async () => {
    const { ctx, s } = t;
    await closeAndDrain(ctx);
    ctx.db.prepare("UPDATE lh_sessions SET hub_state = 'open', closed_at = NULL WHERE chat_id = ?").run(CHAT_ID);
    await closeAndDrain(ctx);
    expect(count(ctx.db, "SELECT count(*) FROM reports WHERE kind = 'master' AND subject_id = ?", s)).toBe(1);
    expect(queuedBackups(ctx)).toHaveLength(1);
    expect(ctx.db.prepare("SELECT hub_state FROM lh_sessions WHERE chat_id = ?").pluck().get(CHAT_ID)).toBe("closed");
  });

  it("does not duplicate the backup if one was already queued (even with another payload)", async () => {
    const { ctx } = t;
    enqueueJob(ctx.db, "backup", { reason: "timer" }, { now: new Date(NOW), runAfter: new Date(Date.parse(NOW) + 3600_000) });
    await closeAndDrain(ctx);
    expect(queuedBackups(ctx)).toHaveLength(1);
  });

  it("if the LLM fails, the report is saved with data only (text null) and the session closes", async () => {
    const w = setup({ llm: brokenLlm() });
    await closeAndDrain(w.ctx);
    expect(w.ctx.db.prepare("SELECT hub_state FROM lh_sessions WHERE chat_id = ?").pluck().get(CHAT_ID)).toBe("closed");
    const rep = w.ctx.db.prepare("SELECT data_json, tex FROM reports WHERE kind = 'session' AND chat_id = ?").get(CHAT_ID) as { data_json: string; tex: string };
    expect(SessionReportDataSchema.parse(JSON.parse(rep.data_json)).text).toBeNull();
    expect(rep.tex).toContain("\\begin{document}");
  });

  it("called directly as a handler (no queue) it also closes the session", async () => {
    const { ctx } = t;
    ctx.db.prepare("UPDATE lh_sessions SET hub_state = 'closing' WHERE chat_id = ?").run(CHAT_ID);
    await ALL_HANDLERS["session-close"]!(ctx, fakeJob("session-close", { chatId: CHAT_ID }));
    await drain(ctx, ALL_HANDLERS);
    expect(ctx.db.prepare("SELECT hub_state FROM lh_sessions WHERE chat_id = ?").pluck().get(CHAT_ID)).toBe("closed");
  });
});

describe("session-close does not block the worker (ADR 103, point 3)", () => {
  it("with the chat's extraction alive the job does NOT wait: it finishes at once, the chat stays 'closing' and is re-enqueued at +10 s", async () => {
    const { ctx, runs, calls } = t;
    runs.current = [liveRun()];
    await sessionsTools.close_session!(ctx, { chatId: CHAT_ID });
    const t0 = Date.now();
    const r = await runOnce(ctx, ALL_HANDLERS);
    expect(Date.now() - t0).toBeLessThan(3_000); // no polling inside the job (the old interval was 10 real seconds)
    expect(r?.job.type).toBe("session-close");
    expect(r?.outcome).toBe("done");

    expect(calls.extract).toEqual([CHAT_ID]);
    expect(stateOf(ctx)).toBe("closing");
    expect(count(ctx.db, "SELECT count(*) FROM reports")).toBe(0);
    expect(queuedBackups(ctx)).toEqual([]);
    const q = queuedClose(ctx);
    expect(q).toHaveLength(1);
    expect(Math.abs(Date.parse(q[0]!.run_after) - (Date.parse(NOW) + 10_000))).toBeLessThanOrEqual(1_000);
    // until it is due, nothing is ready
    expect(await runOnce(ctx, ALL_HANDLERS)).toBeNull();
  });

  it("while it waits, the worker serves other ready jobs", async () => {
    const { ctx, runs } = t;
    runs.current = [liveRun()];
    const ran: string[] = [];
    const handlers = { ...ALL_HANDLERS, probe: async () => void ran.push("probe") };
    await sessionsTools.close_session!(ctx, { chatId: CHAT_ID });
    enqueueJob(ctx.db, "probe", {}, { now: ctx.now() });
    expect((await runOnce(ctx, handlers))?.job.type).toBe("session-close");
    expect((await runOnce(ctx, handlers))?.job.type).toBe("probe");
    expect(ran).toEqual(["probe"]);
    expect(stateOf(ctx)).toBe("closing");
  });

  it("keeps waiting (re-enqueuing) while the run is alive and completes the pipeline once LH no longer has it", async () => {
    const { ctx, runs, s } = t;
    runs.current = [liveRun(), liveRun("chat_other")];
    await sessionsTools.close_session!(ctx, { chatId: CHAT_ID });
    await runOnce(ctx, ALL_HANDLERS);

    setNow(ctx, at(11_000));
    const again = await runOnce(ctx, ALL_HANDLERS);
    expect(again?.job.type).toBe("session-close");
    expect(stateOf(ctx)).toBe("closing");
    const q = queuedClose(ctx);
    expect(q).toHaveLength(1);
    expect(Math.abs(Date.parse(q[0]!.run_after) - (Date.parse(NOW) + 21_000))).toBeLessThanOrEqual(1_000);
    expect(count(ctx.db, "SELECT count(*) FROM reports")).toBe(0);

    // this chat's extraction finishes; another one for a different chat is still alive and must NOT hold this close back
    runs.current = [liveRun("chat_other")];
    setNow(ctx, at(30_000));
    await drain(ctx, ALL_HANDLERS);
    expect(stateOf(ctx)).toBe("closed");
    expect(queuedClose(ctx)).toEqual([]);
    expect(ctx.db.prepare("SELECT status FROM jobs WHERE type = 'session-close' ORDER BY created_at, id").pluck().all().every((x) => x === "done")).toBe(true);
    expect(count(ctx.db, "SELECT count(*) FROM reports WHERE kind = 'session' AND chat_id = ?", CHAT_ID)).toBe(1);
    expect(count(ctx.db, "SELECT count(*) FROM reports WHERE kind = 'master' AND subject_id = ?", s)).toBe(1);
    expect(queuedBackups(ctx)).toHaveLength(1);
    expect(jobsOf(ctx, "session-reingest")).toEqual([]); // finished in time: no re-ingestion needed
  });

  it("if 15 min pass since the start with the run still alive, it continues anyway and enqueues session-reingest", async () => {
    const { ctx, runs } = t;
    runs.current = [liveRun()];
    await sessionsTools.close_session!(ctx, { chatId: CHAT_ID });
    await runOnce(ctx, ALL_HANDLERS);

    // at 14 min it is still waiting (the deadline counts from the START of the close, not from the last retry)
    setNow(ctx, at(14 * 60_000));
    await runOnce(ctx, ALL_HANDLERS);
    expect(stateOf(ctx)).toBe("closing");
    expect(queuedClose(ctx)).toHaveLength(1);

    setNow(ctx, at(16 * 60_000));
    await drain(ctx, ALL_HANDLERS);
    expect(runs.current).toHaveLength(1); // LH is still extracting
    expect(stateOf(ctx)).toBe("closed");
    expect(queuedClose(ctx)).toEqual([]);
    expect(count(ctx.db, "SELECT count(*) FROM reports WHERE kind = 'session' AND chat_id = ?", CHAT_ID)).toBe(1);
    expect(jobsOf(ctx, "session-reingest")).toEqual([{ chatId: CHAT_ID }]);
  });
});

const jobsOf = (ctx: Ctx, type: string): Record<string, unknown>[] =>
  (ctx.db.prepare("SELECT payload_json FROM jobs WHERE type = ? AND status = 'queued'").pluck().all(type) as string[]).map((x) => JSON.parse(x));

describe.skipIf(!pdflatexOk)("the generated .tex really compiles", () => {
  it("POST /reports/:id/render on the session report created by the close produces a PDF", async () => {
    await closeAndDrain(t.ctx);
    const id = t.ctx.db.prepare("SELECT id FROM reports WHERE kind = 'session' AND chat_id = ?").pluck().get(CHAT_ID) as string;
    const r = await call(t.app, "post", `/reports/${id}/render`);
    expect(r.status).toBe(200);
    const out = RenderReportResponseSchema.parse(r.json);
    expect(existsSync(out.path)).toBe(true);
    expect(readFileSync(out.path).subarray(0, 4).toString("latin1")).toBe("%PDF");
    const mid = t.ctx.db.prepare("SELECT id FROM reports WHERE kind = 'master'").pluck().get() as string;
    expect((await call(t.app, "post", `/reports/${mid}/render`)).status).toBe(200);
  }, 180_000);
});
