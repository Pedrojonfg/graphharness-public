// L4 — exams (REST + MCP upsert_exam/list_exams) and P(prepared) (V0).
import { ExamListSchema, ExamSchema, ListExamsOutputSchema, UpsertExamOutputSchema } from "@graphharness/contracts";
import { describe, expect, it } from "vitest";
import { sessionsTools } from "../../src/mcp/sessions.ts";
import { setNow } from "../../src/testing.ts";
import { NOW, call, conceptIn, count, daysFromNow, mastery, subject, world } from "../knowledge/helpers.ts";

function setup() {
  const w = world();
  const s = subject(w.ctx, "Linear Algebra");
  const [weak, review, solid, unknown] = ["Weak", "Review", "Solid", "New"].map((n) => conceptIn(w.ctx, s, n)) as [string, string, string, string];
  mastery(w.ctx, weak, "weak"); // 0.30
  mastery(w.ctx, review, "review"); // 0.65
  mastery(w.ctx, solid, "solid"); // 0.95
  return { ...w, s, weak, review, solid, unknown };
}

describe("POST /exams and P(prepared)", () => {
  it("empty scope = the whole subject: mean P' of the concepts with evidence and unknownCount separately", async () => {
    const { app, s } = setup();
    const r = await call(app, "post", "/exams", { subjectId: s, title: "Midterm 1", date: "2026-11-15" });
    expect(r.status).toBe(201);
    const e = ExamSchema.parse(r.json);
    expect(e).toMatchObject({ subjectId: s, subjectName: "Linear Algebra", title: "Midterm 1", date: "2026-11-15", scopeConceptIds: [], notes: null, daysLeft: 5, unknownCount: 1, createdAt: NOW });
    expect(e.preparedProbability).toBeCloseTo((0.3 + 0.65 + 0.95) / 3, 6);
  });

  it("with scope: only those concepts count", async () => {
    const { app, s, weak, review, unknown } = setup();
    const a = ExamSchema.parse((await call(app, "post", "/exams", { subjectId: s, title: "A", date: "2026-11-20", scopeConceptIds: [weak, review], notes: "Topics 1–2" })).json);
    expect(a.preparedProbability).toBeCloseTo(0.475, 6);
    expect(a.unknownCount).toBe(0);
    expect(a.notes).toBe("Topics 1–2");
    expect(a.scopeConceptIds).toEqual([weak, review]);
    const b = ExamSchema.parse((await call(app, "post", "/exams", { subjectId: s, title: "B", date: "2026-11-21", scopeConceptIds: [unknown] })).json);
    expect(b.preparedProbability).toBeNull();
    expect(b.unknownCount).toBe(1);
  });

  it("uses P' with decay: a hit (0.65, half-life 60 d) read 60 days later is worth 0.325", async () => {
    const { ctx, app } = world();
    const s = subject(ctx);
    const c = conceptIn(ctx, s, "C");
    mastery(ctx, c, "review");
    const id = ExamSchema.parse((await call(app, "post", "/exams", { subjectId: s, title: "X", date: "2027-01-31" })).json).id;
    setNow(ctx, daysFromNow(60));
    const list = ExamListSchema.parse((await call(app, "get", "/exams")).json);
    const e = list.find((x) => x.id === id)!;
    expect(e.preparedProbability).toBeCloseTo(0.325, 4);
    expect(e.daysLeft).toBe(Math.round((Date.parse("2027-01-31") - Date.parse(daysFromNow(60).slice(0, 10))) / 86_400_000));
  });

  it("non-existent subject → 404; invalid data → 400", async () => {
    const { app, s } = setup();
    expect((await call(app, "post", "/exams", { subjectId: "nope", title: "X", date: "2026-11-15" })).status).toBe(404);
    for (const bad of [{ subjectId: s, title: "", date: "2026-11-15" }, { subjectId: s, title: "X", date: "15/11/2026" }, { title: "X", date: "2026-11-15" }]) {
      const r = await call(app, "post", "/exams", bad);
      expect(r.status).toBe(400);
      expect(r.json.error).toBe("invalid_request");
    }
  });
});

describe("GET /exams", () => {
  it("sorts by ascending date and filters by subject and inclusive range", async () => {
    const { ctx, app, s } = setup();
    const s2 = subject(ctx, "Physics");
    for (const [sub, t, d] of [[s, "C", "2026-12-20"], [s, "A", "2026-11-12"], [s2, "F", "2026-11-30"], [s, "B", "2026-11-30"]] as const)
      await call(app, "post", "/exams", { subjectId: sub, title: t, date: d });
    const all = ExamListSchema.parse((await call(app, "get", "/exams")).json);
    expect(all.map((e) => e.date)).toEqual(["2026-11-12", "2026-11-30", "2026-11-30", "2026-12-20"]);
    expect(ExamListSchema.parse((await call(app, "get", `/exams?subjectId=${s2}`)).json).map((e) => e.title)).toEqual(["F"]);
    const range = ExamListSchema.parse((await call(app, "get", "/exams?from=2026-11-12&to=2026-11-30")).json);
    expect(range.map((e) => e.title).sort()).toEqual(["A", "B", "F"]);
    expect((await call(app, "get", "/exams?from=yesterday")).status).toBe(400);
  });
});

describe("PATCH and DELETE /exams/:id", () => {
  it("edits fields (notes:null clears) and recomputes; the subject does not change", async () => {
    const { app, s, weak } = setup();
    const e = ExamSchema.parse((await call(app, "post", "/exams", { subjectId: s, title: "Old", date: "2026-11-15", notes: "n" })).json);
    const r = await call(app, "patch", `/exams/${e.id}`, { title: "New", date: "2026-11-11", scopeConceptIds: [weak], notes: null });
    expect(r.status).toBe(200);
    const p = ExamSchema.parse(r.json);
    expect(p).toMatchObject({ id: e.id, subjectId: s, title: "New", date: "2026-11-11", daysLeft: 1, notes: null, unknownCount: 0, scopeConceptIds: [weak] });
    expect(p.preparedProbability).toBeCloseTo(0.3, 6);
    expect((await call(app, "patch", `/exams/${e.id}`, {})).status).toBe(400);
    expect((await call(app, "patch", "/exams/nope", { title: "x" })).status).toBe(404);
  });

  it("DELETE → 204 without a body and then 404", async () => {
    const { ctx, app, s } = setup();
    const e = ExamSchema.parse((await call(app, "post", "/exams", { subjectId: s, title: "X", date: "2026-11-15" })).json);
    const r = await call(app, "delete", `/exams/${e.id}`);
    expect(r.status).toBe(204);
    expect(await r.raw.text()).toBe("");
    expect(count(ctx.db, "SELECT count(*) FROM exams")).toBe(0);
    expect((await call(app, "delete", `/exams/${e.id}`)).status).toBe(404);
  });
});

describe("MCP upsert_exam / list_exams", () => {
  it("without id it creates; with id it overwrites all fields (what is omitted goes back to empty/null)", async () => {
    const { ctx, s, weak } = setup();
    const created = UpsertExamOutputSchema.parse(await sessionsTools.upsert_exam!(ctx, { subjectId: s, title: "Midterm", date: "2026-12-15", scopeConceptIds: [weak], notes: "Topics 1–4" }));
    expect(created).toMatchObject({ title: "Midterm", date: "2026-12-15", scopeConceptIds: [weak], notes: "Topics 1–4", daysLeft: 35 });
    const upd = UpsertExamOutputSchema.parse(await sessionsTools.upsert_exam!(ctx, { id: created.id, subjectId: s, title: "Midterm (moved)", date: "2026-12-18" }));
    expect(upd).toMatchObject({ id: created.id, title: "Midterm (moved)", date: "2026-12-18", scopeConceptIds: [], notes: null });
    expect(count(ctx.db, "SELECT count(*) FROM exams")).toBe(1);
    await expect(sessionsTools.upsert_exam!(ctx, { subjectId: "nope", title: "X", date: "2026-12-15" })).rejects.toMatchObject({ status: 404 });
    await expect(sessionsTools.upsert_exam!(ctx, { id: "nope", subjectId: s, title: "X", date: "2026-12-15" })).rejects.toMatchObject({ status: 404 });
  });

  it("list_exams returns {exams} by date with inclusive from/to", async () => {
    const { ctx, s } = setup();
    for (const [t, d] of [["Dec", "2026-12-15"], ["Nov", "2026-11-20"], ["Jan", "2027-01-20"]] as const)
      await sessionsTools.upsert_exam!(ctx, { subjectId: s, title: t, date: d });
    const all = ListExamsOutputSchema.parse(await sessionsTools.list_exams!(ctx, {}));
    expect(all.exams.map((e) => e.title)).toEqual(["Nov", "Dec", "Jan"]);
    const some = ListExamsOutputSchema.parse(await sessionsTools.list_exams!(ctx, { from: "2026-11-20", to: "2026-12-15" }));
    expect(some.exams.map((e) => e.title)).toEqual(["Nov", "Dec"]);
  });
});
