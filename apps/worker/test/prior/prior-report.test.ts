// ADR 105 §6 (19, 20) — `prior-report` job: waits for LH to finish extracting (like session-close, ADR 103 §3),
// syncs and curates, and builds the report from the propositions of the imported paths.
// Test decisions: `paths` are relative LH paths (the ones in fileSources); the idempotency key is
// (subjectId, paths, startedAt): re-running the same payload with `startedAt` does not create a second report.
import type { GraphNode, GraphStatusRun } from "@graphharness/lh-client";
import type { LlmRequest } from "@graphharness/llm";
import { describe, expect, it } from "vitest";
import { call, conceptIn, count, fakeJob, mastery, world, NOW, type Ctx } from "../../../hub/test/knowledge/helpers.ts";
import { enqueueJob } from "../../../hub/src/services/jobs.ts";
import { fakeLh, fakeLlm, seedProposition, seedSubject, setNow } from "../../../hub/src/testing.ts";
import { ALL_HANDLERS } from "../../src/handlers/index.ts";
import { drain, runOnce } from "../../src/runner.ts";

const haystack = (req: LlmRequest): string => JSON.stringify([req.system, req.messages]);
const at = (offsetMs: number): string => new Date(Date.parse(NOW) + offsetMs).toISOString();
const node = (id: string, text: string, src: string): GraphNode => ({ id, name: text, statement: text, aliases: [], provenance: [{ chatId: src, messageId: "" }], createdAt: NOW });

const E_OLD = "n_000000000old";
const N_KNOWN = "n_00000000new1";
const N_NEW = "n_00000000new2";
const TOPIC3 = "algebra/topic3.md";

function setup() {
  const runs: { current: GraphStatusRun[] } = { current: [] };
  const lhCalls = { graph: 0, status: 0 };
  const graph = {
    propositions: [node(E_OLD, "eigenvalues spectrum", "src_t1"), node(N_KNOWN, "real eigenvalues", "src_t3"), node(N_NEW, "Hooke elastic spring", "src_t3")],
    chains: [],
    fileSources: { src_t1: "algebra/topic1.md", src_t3: TOPIC3 },
  };
  const lh = fakeLh({
    async getGraph() {
      lhCalls.graph++;
      return graph;
    },
    async listChats() {
      return [];
    },
    async graphStatus() {
      lhCalls.status++;
      return runs.current;
    },
  });
  let conceptId = "";
  const llm = fakeLlm({
    // the curator assigns every new proposition to the existing concept
    "concept-curate": (req) => ({
      assignments: [N_KNOWN, N_NEW].filter((id) => haystack(req).includes(id)).map((propositionId) => ({ propositionId, conceptId, newConcept: null })),
      newEdges: [],
    }),
    "prior-match": (req) => ({
      matches: haystack(req).includes(N_KNOWN) ? [{ propositionId: N_KNOWN, matchedPropositionId: E_OLD, relation: "same" }] : [],
    }),
  });
  const w = world({ lh, llm });
  const s = seedSubject(w.ctx.db, { name: "Algebra", lhSourceFolder: "algebra" });
  conceptId = conceptIn(w.ctx, s, "Eigenvalues");
  seedProposition(w.ctx.db, { id: E_OLD, name: "eigenvalues spectrum", statement: "eigenvalues spectrum", conceptId, provenance: [{ chatId: "src_t1", messageId: "" }] });
  mastery(w.ctx, conceptId, "solid");
  return { ...w, llm, runs, lhCalls, s, conceptId };
}

const listReports = async (app: ReturnType<typeof setup>["app"]) => {
  const r = await call(app, "get", "/prior-reports");
  expect(r.status).toBe(200);
  return r.json.reports as any[];
};
const queuedPrior = (ctx: Ctx) =>
  ctx.db.prepare("SELECT run_after, payload_json FROM jobs WHERE type = 'prior-report' AND status = 'queued'").all() as { run_after: string; payload_json: string }[];
const liveRun = (): GraphStatusRun => ({ id: "src_t3", chatId: "src_t3", title: "topic3.md", phase: "extracting", startedAt: 0 });
const handler = () => {
  const h = ALL_HANDLERS["prior-report"];
  expect(h, "prior-report is not registered in ALL_HANDLERS").toBeDefined();
  return h!;
};

describe("prior-report: report after the import", () => {
  it("syncs, curates and builds the report with the propositions of the given paths", async () => {
    const { ctx, app, s, conceptId } = setup();
    enqueueJob(ctx.db, "prior-report", { subjectId: s, paths: [TOPIC3] }, { now: ctx.now() });
    const r = await runOnce(ctx, ALL_HANDLERS);
    expect(r).toMatchObject({ job: { type: "prior-report" }, outcome: "done" });

    // curated inside the job itself: the new propositions already have a concept
    expect(count(ctx.db, "SELECT count(*) FROM concept_propositions WHERE proposition_id IN (?, ?)", N_KNOWN, N_NEW)).toBe(2);

    const list = await listReports(app);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ subjectId: s, paths: [TOPIC3], total: 2, counts: { known: 1, stale: 0, weak: 0, new: 1 }, percentages: { known: 50, stale: 0, weak: 0, new: 50 } });
    const full = (await call(app, "get", `/prior-reports/${list[0].id}`)).json;
    const byId = Object.fromEntries((full.items as any[]).map((i) => [i.propositionId, i]));
    // the proposition from another file (topic1) is not part of the report, but it is a candidate
    expect(Object.keys(byId).sort()).toEqual([N_KNOWN, N_NEW].sort());
    expect(byId[N_KNOWN]).toMatchObject({ bucket: "known", relation: "same", matchedConceptId: conceptId });
    expect(byId[N_NEW]).toMatchObject({ bucket: "new", relation: "new", matchedConceptId: null });
  });

  it("paths without propositions → report with total 0 and the job finishes fine", async () => {
    const { ctx, app, s, llm } = setup();
    enqueueJob(ctx.db, "prior-report", { subjectId: s, paths: ["algebra/empty.md"] }, { now: ctx.now() });
    await drain(ctx, ALL_HANDLERS);
    expect(ctx.db.prepare("SELECT status FROM jobs WHERE type = 'prior-report'").pluck().all()).toEqual(["done"]);
    const list = await listReports(app);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ subjectId: s, paths: ["algebra/empty.md"], total: 0, percentages: { known: 0, stale: 0, weak: 0, new: 0 } });
    expect(llm.calls.filter((c) => c.task === "prior-match")).toEqual([]);
  });

  it("idempotent: re-running the same payload (subjectId, paths, startedAt) does not duplicate the report", async () => {
    const { ctx, app, s } = setup();
    const payload = { subjectId: s, paths: [TOPIC3], startedAt: NOW };
    await handler()(ctx, fakeJob("prior-report", payload));
    await handler()(ctx, fakeJob("prior-report", payload));
    expect(await listReports(app)).toHaveLength(1);
  });

  it("a payload without subjectId or without paths makes the job fail", async () => {
    const { ctx } = setup();
    await expect(handler()(ctx, fakeJob("prior-report", { paths: [TOPIC3] }))).rejects.toThrow();
    await expect(handler()(ctx, fakeJob("prior-report", { subjectId: "x" }))).rejects.toThrow();
  });
});

describe("prior-report waits for LH extraction without blocking the worker (ADR 103 §3)", () => {
  it("with an extraction in progress it is re-enqueued at +10 s, without syncing or creating a report", async () => {
    const { ctx, app, s, runs, lhCalls } = setup();
    runs.current = [liveRun()];
    enqueueJob(ctx.db, "prior-report", { subjectId: s, paths: [TOPIC3] }, { now: ctx.now() });
    const r = await runOnce(ctx, ALL_HANDLERS);
    expect(r).toMatchObject({ job: { type: "prior-report" }, outcome: "done" });
    expect(lhCalls.status).toBeGreaterThanOrEqual(1);
    expect(lhCalls.graph).toBe(0);
    const q = queuedPrior(ctx);
    expect(q).toHaveLength(1);
    expect(Math.abs(Date.parse(q[0]!.run_after) - (Date.parse(NOW) + 10_000))).toBeLessThanOrEqual(1_000);
    expect(JSON.parse(q[0]!.payload_json)).toMatchObject({ subjectId: s, paths: [TOPIC3] });
    expect(await runOnce(ctx, ALL_HANDLERS)).toBeNull(); // until it is due, nothing is ready
    expect(await listReports(app)).toEqual([]);
  });

  it("also waits for an extraction unrelated to the imported paths (any extraction in progress)", async () => {
    const { ctx, app, s, runs, lhCalls } = setup();
    runs.current = [{ id: "chat_other", chatId: "chat_other", title: "another session", phase: "extracting", startedAt: 0 }];
    enqueueJob(ctx.db, "prior-report", { subjectId: s, paths: [TOPIC3] }, { now: ctx.now() });
    await runOnce(ctx, ALL_HANDLERS);
    expect(lhCalls.graph).toBe(0);
    expect(queuedPrior(ctx)).toHaveLength(1);
    expect(await listReports(app)).toEqual([]);
  });

  it("when LH finishes, the next attempt builds the report", async () => {
    const { ctx, app, s, runs } = setup();
    runs.current = [liveRun()];
    enqueueJob(ctx.db, "prior-report", { subjectId: s, paths: [TOPIC3] }, { now: ctx.now() });
    await runOnce(ctx, ALL_HANDLERS);
    runs.current = [];
    setNow(ctx, at(11_000));
    await drain(ctx, ALL_HANDLERS);
    expect(queuedPrior(ctx)).toEqual([]);
    const list = await listReports(app);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ total: 2 });
  });

  it("the 15 min deadline counts from the start: at 14 min it keeps waiting; at 16 min it goes ahead even if LH is still extracting", async () => {
    const { ctx, app, s, runs } = setup();
    runs.current = [liveRun()];
    enqueueJob(ctx.db, "prior-report", { subjectId: s, paths: [TOPIC3] }, { now: ctx.now() });
    await runOnce(ctx, ALL_HANDLERS);

    setNow(ctx, at(14 * 60_000));
    await runOnce(ctx, ALL_HANDLERS);
    expect(queuedPrior(ctx)).toHaveLength(1);
    expect(await listReports(app)).toEqual([]);

    setNow(ctx, at(16 * 60_000));
    await drain(ctx, ALL_HANDLERS);
    expect(runs.current).toHaveLength(1); // LH is still extracting
    expect(queuedPrior(ctx)).toEqual([]);
    expect(await listReports(app)).toHaveLength(1);
  });
});
