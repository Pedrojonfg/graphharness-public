// ADR 105 §6 (19) — prior-knowledge reports via REST (GET /prior-reports, /prior-reports/:id) and MCP (get_prior_knowledge).
import { MCP_TOOLS } from "@graphharness/contracts";
import { describe, expect, it } from "vitest";
import { MCP_HANDLERS } from "../../src/mcp/server.ts";
import { buildPriorReport } from "../../src/services/prior.ts";
import { setNow } from "../../src/testing.ts";
import { call, daysFromNow, subject, world, type Ctx } from "../knowledge/helpers.ts";

/** Calls the MCP tool with the input and output validated by the contract. */
async function tool(ctx: Ctx, name: string, input: object): Promise<any> {
  const def = MCP_TOOLS.find((t) => t.name === name);
  expect(def, `${name} missing in MCP_TOOLS`).toBeDefined();
  const handler = MCP_HANDLERS[name];
  expect(handler, `MCP handler ${name} missing`).toBeDefined();
  return def!.output.parse(await handler!(ctx, def!.input.parse(input)));
}

/** Reports without propositions (total 0, no LLM), one per day starting today. */
async function reports(ctx: Ctx, subjectIds: string[]) {
  const out = [];
  for (const [i, subjectId] of subjectIds.entries()) {
    setNow(ctx, daysFromNow(i));
    out.push(await buildPriorReport(ctx, { subjectId, propositionIds: [], excludeSourcePaths: [`folder/f${i}.pdf`] }));
  }
  return out;
}

const summary = (r: Awaited<ReturnType<typeof buildPriorReport>>) => ({
  id: r.id,
  subjectId: r.subjectId,
  createdAt: r.createdAt,
  paths: r.paths,
  total: r.total,
  counts: r.counts,
  percentages: r.percentages,
});

describe("GET /prior-reports", () => {
  it("lists summaries (without items), from newest to oldest", async () => {
    const { ctx, app } = world();
    const a = subject(ctx, "Algebra");
    const b = subject(ctx, "Physics");
    const [r0, r1, r2] = await reports(ctx, [a, b, a]);
    const res = await call(app, "get", "/prior-reports");
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ reports: [summary(r2!), summary(r1!), summary(r0!)] });
  });

  it("subjectId filters by subject", async () => {
    const { ctx, app } = world();
    const a = subject(ctx, "Algebra");
    const b = subject(ctx, "Physics");
    const [r0, , r2] = await reports(ctx, [a, b, a]);
    const res = await call(app, "get", `/prior-reports?subjectId=${a}`);
    expect(res.json.reports.map((r: { id: string }) => r.id)).toEqual([r2!.id, r0!.id]);
  });

  it("limit: 20 by default; it can be lowered; more than 100 → 400", async () => {
    const { ctx, app } = world();
    const a = subject(ctx);
    const all = await reports(ctx, Array.from({ length: 21 }, () => a));
    const def = await call(app, "get", "/prior-reports");
    expect(def.json.reports).toHaveLength(20);
    expect(def.json.reports[0].id).toBe(all.at(-1)!.id);
    expect((await call(app, "get", "/prior-reports?limit=2")).json.reports).toHaveLength(2);
    expect((await call(app, "get", "/prior-reports?limit=101")).status).toBe(400);
  });

  it("no reports → empty list", async () => {
    const { app } = world();
    const res = await call(app, "get", "/prior-reports");
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ reports: [] });
  });
});

describe("GET /prior-reports/:id", () => {
  it("returns the full report", async () => {
    const { ctx, app } = world();
    const [r] = await reports(ctx, [subject(ctx)]);
    const res = await call(app, "get", `/prior-reports/${r!.id}`);
    expect(res.status).toBe(200);
    expect(res.json).toEqual(r);
  });

  it("non-existent → 404 not_found", async () => {
    const { app } = world();
    const res = await call(app, "get", "/prior-reports/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.json).toMatchObject({ error: "not_found" });
  });
});

describe("MCP get_prior_knowledge", () => {
  it("with reportId → that full report", async () => {
    const { ctx } = world();
    const a = subject(ctx);
    const [r0] = await reports(ctx, [a, a]);
    expect(await tool(ctx, "get_prior_knowledge", { reportId: r0!.id })).toEqual({ report: r0 });
  });

  it("with subjectId → the latest of that subject", async () => {
    const { ctx } = world();
    const a = subject(ctx, "Algebra");
    const b = subject(ctx, "Physics");
    const [, r1] = await reports(ctx, [a, a, b]);
    expect(await tool(ctx, "get_prior_knowledge", { subjectId: a })).toEqual({ report: r1 });
  });

  it("with nothing → the latest overall", async () => {
    const { ctx } = world();
    const a = subject(ctx, "Algebra");
    const b = subject(ctx, "Physics");
    const [, , r2] = await reports(ctx, [a, a, b]);
    expect(await tool(ctx, "get_prior_knowledge", {})).toEqual({ report: r2 });
  });

  it("non-existent reportId → report null (no error)", async () => {
    const { ctx } = world();
    await reports(ctx, [subject(ctx)]);
    expect(await tool(ctx, "get_prior_knowledge", { reportId: "does-not-exist" })).toEqual({ report: null });
  });

  it("subject without reports (or none at all) → report null", async () => {
    const { ctx } = world();
    const a = subject(ctx, "Algebra");
    expect(await tool(ctx, "get_prior_knowledge", {})).toEqual({ report: null });
    const b = subject(ctx, "Physics");
    await reports(ctx, [a]);
    expect(await tool(ctx, "get_prior_knowledge", { subjectId: b })).toEqual({ report: null });
  });
});
