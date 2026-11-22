// L1 — 7-day plan between sessions (ADR 105 §7, point 23): `getWeekPlan` service, GET /plan and MCP `get_week_plan`.
// The placement logic is tested in packages/core/src/plan.test.ts; here, the Hub's data loading and the edge cases.
import { MCP_TOOLS, WeekPlanSchema } from "@graphharness/contracts";
import { describe, expect, it } from "vitest";
import { MCP_HANDLERS } from "../../src/mcp/server.ts";
import { configFromEnv, type HubConfig } from "../../src/services/config.ts";
import { seedConcept, seedEdge, setNow } from "../../src/testing.ts";
import { NOW, call, conceptIn, daysFromNow, insertCard, insertTemplate, mastery, subject, world, type AutoLlm, type Ctx } from "./helpers.ts";

const insertExam = (ctx: Ctx, id: string, subjectId: string, date: string, scope: string[] = []) =>
  ctx.db.prepare("INSERT INTO exams (id, subject_id, title, date, scope_concept_ids_json, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, subjectId, `Exam ${id}`, date, JSON.stringify(scope), NOW);

/** Concept with a fixed id (so the tie-break by id is predictable). */
const named = (ctx: Ctx, id: string, subjectId: string | null): string => seedConcept(ctx.db, { id, subjectId, name: `Concept ${id}` });

const plan = async (app: ReturnType<typeof world>["app"], qs = "") => {
  const r = await call(app, "get", `/plan${qs}`);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return WeekPlanSchema.parse(r.json);
};
const idsOf = (p: ReturnType<typeof WeekPlanSchema.parse>, day: number) => p.days[day]!.items.map((i) => i.conceptId);

describe("plan configuration", () => {
  it("PLAN_ITEMS_PER_DAY: 5 by default and configurable through the environment", () => {
    expect((configFromEnv({}) as HubConfig & { planItemsPerDay: number }).planItemsPerDay).toBe(5);
    expect((configFromEnv({ PLAN_ITEMS_PER_DAY: "3" }) as HubConfig & { planItemsPerDay: number }).planItemsPerDay).toBe(3);
  });
});

describe("GET /plan", () => {
  it("with an empty database: 7 consecutive days from today according to the Hub's clock, all empty", async () => {
    const { app } = world();
    const p = await plan(app);
    expect(p.from).toBe("2026-11-10");
    expect(p.days.map((d) => d.date)).toEqual(["2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15", "2026-11-16"]);
    expect(p.days.every((d) => d.items.length === 0)).toBe(true);
    expect(p.unscheduledCount).toBe(0);
  });

  it("?days and ?from set the horizon; without ?from it uses the Hub's clock even as it advances", async () => {
    const { ctx, app } = world();
    const p = await plan(app, "?days=3&from=2026-11-20");
    expect(p).toMatchObject({ from: "2026-11-20" });
    expect(p.days.map((d) => d.date)).toEqual(["2026-11-20", "2026-11-21", "2026-11-22"]);
    setNow(ctx, daysFromNow(2));
    expect((await plan(app, "?days=1")).from).toBe("2026-11-12");
  });

  it("days outside 1..14 or non-numeric, and malformed from → 400 invalid_request", async () => {
    const { app } = world();
    for (const qs of ["?days=0", "?days=15", "?days=-1", "?days=abc", "?from=10-11-2026", "?from=today"]) {
      const r = await call(app, "get", `/plan${qs}`);
      expect(r.status, qs).toBe(400);
      expect(r.json.error, qs).toBe("invalid_request");
    }
    expect((await call(app, "get", "/plan?days=14")).status).toBe(200);
    expect((await call(app, "get", "/plan?days=1")).status).toBe(200);
  });

  it("weak, unrecorded and stale solid concepts come in with name and subject; fresh solid ones do not; it does not use the LLM and is deterministic", async () => {
    const { ctx, app } = world();
    const s = subject(ctx);
    const fresh = conceptIn(ctx, s, "Fresh");
    const weak = conceptIn(ctx, s, "Weak");
    const unknown = conceptIn(ctx, s, "New");
    const old = conceptIn(ctx, s, "Old");
    mastery(ctx, fresh, "solid");
    mastery(ctx, weak, "weak");
    mastery(ctx, old, "solid", daysFromNow(-400)); // stale: P' decays below the threshold
    const p = await plan(app);
    const items = p.days.flatMap((d) => d.items);
    expect(items.map((i) => i.conceptId).sort()).toEqual([weak, unknown, old].sort());
    expect(items.find((i) => i.conceptId === weak)).toMatchObject({ conceptName: "Weak", subjectId: s });
    expect(items.every((i) => i.why.trim().length > 0)).toBe(true);
    expect(idsOf(p, 0).indexOf(weak)).toBeLessThan(idsOf(p, 0).indexOf(unknown)); // P' 0.30 before unrecorded (0.5)
    expect(await plan(app)).toEqual(p);
    expect((ctx.llm as AutoLlm).calls).toEqual([]);
  });

  it("excludes retired concepts and those of archived subjects", async () => {
    const { ctx, app } = world();
    const s = subject(ctx, "Active");
    const archived = subject(ctx, "Archived");
    const keep = conceptIn(ctx, s, "Stays");
    const retired = conceptIn(ctx, s, "Retired");
    conceptIn(ctx, archived, "From archived");
    ctx.db.prepare("UPDATE concepts SET status = 'retired' WHERE id = ?").run(retired);
    ctx.db.prepare("UPDATE subjects SET archived_at = ? WHERE id = ?").run(NOW, archived);
    const p = await plan(app);
    expect(p.days.flatMap((d) => d.items.map((i) => i.conceptId))).toEqual([keep]);
    expect(p.unscheduledCount).toBe(0);
  });

  it("dependents (requires edges) raise the priority", async () => {
    const { ctx, app } = world({ config: { planItemsPerDay: 1 } as Partial<HubConfig> });
    const s = subject(ctx);
    // "a-leaf" would win the tie-break by id; "z-base" has two dependents (factor 3).
    const leaf = named(ctx, "a-leaf", s);
    const base = named(ctx, "z-base", s);
    const d1 = named(ctx, "m-dep1", s);
    const d2 = named(ctx, "m-dep2", s);
    for (const c of [leaf, base]) mastery(ctx, c, "weak");
    for (const c of [d1, d2]) mastery(ctx, c, "solid"); // fresh: they do not compete for a slot
    seedEdge(ctx.db, base, d1, "high");
    seedEdge(ctx.db, base, d2, "high");
    const p = await plan(app);
    expect(idsOf(p, 0)).toEqual([base]);
    expect(idsOf(p, 1)).toEqual([leaf]);
  });

  it("itemsPerDay comes from the configuration: never more per day and the rest falls into unscheduledCount", async () => {
    const { ctx, app } = world({ config: { planItemsPerDay: 2 } as Partial<HubConfig> });
    const s = subject(ctx);
    for (let i = 0; i < 5; i++) conceptIn(ctx, s, `C${i}`);
    const p = await plan(app, "?days=2");
    expect(p.days.map((d) => d.items.length)).toEqual([2, 2]);
    expect(p.unscheduledCount).toBe(1);
  });

  it("exam without scope (JSON []) = the whole subject: deadline in 3 days → only days 0..2", async () => {
    const { ctx, app } = world({ config: { planItemsPerDay: 1 } as Partial<HubConfig> });
    const s = subject(ctx);
    for (let i = 0; i < 4; i++) mastery(ctx, conceptIn(ctx, s, `C${i}`), "weak");
    insertExam(ctx, "e1", s, "2026-11-13");
    const p = await plan(app);
    expect(p.days.map((d) => d.items.length)).toEqual([1, 1, 1, 0, 0, 0, 0]);
    expect(p.unscheduledCount).toBe(1);
  });

  it("exam with scope: only its concepts have a deadline; the rest goes afterwards", async () => {
    const { ctx, app } = world({ config: { planItemsPerDay: 1 } as Partial<HubConfig> });
    const s = subject(ctx);
    const [a, b, c] = ["a", "b", "c"].map((id) => named(ctx, id, s)) as [string, string, string];
    for (const id of [a, b, c]) mastery(ctx, id, "weak");
    insertExam(ctx, "e1", s, "2026-11-12", [a, b]); // in 2 days → days 0 and 1
    const p = await plan(app);
    expect([idsOf(p, 0), idsOf(p, 1), idsOf(p, 2)]).toEqual([[a], [b], [c]]);
    expect(p.unscheduledCount).toBe(0);
  });

  it("distances to the exam are measured from ?from, not from today", async () => {
    const { ctx, app } = world({ config: { planItemsPerDay: 1 } as Partial<HubConfig> });
    const s = subject(ctx);
    for (let i = 0; i < 4; i++) mastery(ctx, conceptIn(ctx, s, `C${i}`), "weak");
    insertExam(ctx, "e1", s, "2026-11-15");
    expect((await plan(app)).unscheduledCount).toBe(0); // from today 5 days remain: the 4 fit
    const p = await plan(app, "?from=2026-11-12"); // from the 12th 3 remain: days 12..14
    expect(p.days.map((d) => d.items.length).slice(0, 4)).toEqual([1, 1, 1, 0]);
    expect(p.unscheduledCount).toBe(1);
  });

  it("kind: active template → exercises; live review cards → cards; a failed template or retired card does not count → session", async () => {
    const { ctx, app } = world();
    const s = subject(ctx);
    const [tpl, cards, both, failed, retired, plain] = ["Template", "Cards", "Both", "Failed", "Retired", "Nothing"].map((n) => conceptIn(ctx, s, n)) as string[];
    insertTemplate(ctx.db, tpl!);
    insertCard(ctx.db, { conceptId: cards! });
    insertTemplate(ctx.db, both!);
    insertCard(ctx.db, { conceptId: both! });
    insertTemplate(ctx.db, failed!, { status: "failed" });
    insertCard(ctx.db, { conceptId: retired!, retired: true });
    const kind = Object.fromEntries((await plan(app)).days.flatMap((d) => d.items).map((i) => [i.conceptId, i.kind]));
    expect(kind).toEqual({ [tpl!]: "exercises", [cards!]: "cards", [both!]: "exercises", [failed!]: "session", [retired!]: "session", [plain!]: "session" });
  });
});

describe("MCP get_week_plan", () => {
  const def = MCP_TOOLS.find((t) => t.name === "get_week_plan");
  const run = async (ctx: Ctx, input: object) => {
    if (!def) throw new Error("get_week_plan missing in MCP_TOOLS");
    const handler = MCP_HANDLERS.get_week_plan;
    if (!handler) throw new Error("MCP handler get_week_plan missing");
    return def.output.parse(await handler(ctx, def.input.parse(input))) as ReturnType<typeof WeekPlanSchema.parse>;
  };

  it("days is optional (7 by default) and returns the same as GET /plan", async () => {
    const { ctx, app } = world();
    const s = subject(ctx);
    mastery(ctx, conceptIn(ctx, s, "Weak"), "weak");
    conceptIn(ctx, s, "New");
    const out = await run(ctx, {});
    expect(out.days).toHaveLength(7);
    expect(out).toEqual((await call(app, "get", "/plan")).json);
    const three = await run(ctx, { days: 3 });
    expect(three.days).toHaveLength(3);
    expect(three).toEqual((await call(app, "get", "/plan?days=3")).json);
  });

  it("rejects days outside 1..14 with the input schema", () => {
    if (!def) throw new Error("get_week_plan missing in MCP_TOOLS");
    expect(def.input.safeParse({ days: 15 }).success).toBe(false);
    expect(def.input.safeParse({ days: 0 }).success).toBe(false);
    expect(def.input.safeParse({ days: 14 }).success).toBe(true);
  });
});
