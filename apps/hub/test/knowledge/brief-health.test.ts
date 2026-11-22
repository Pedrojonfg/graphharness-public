// L1 — GET /brief (ADR 102 point 9), /health, /inbox, /llm-usage and the declarations-expire job.
import { DailyBriefSchema, HealthSchema, InboxSchema, LlmUsageSchema } from "@graphharness/contracts";
import { describe, expect, it } from "vitest";
import { ALL_HANDLERS } from "../../../worker/src/handlers/index.ts";
import { enqueueJob } from "../../src/services/jobs.ts";
import { fakeEval, fakeLh, seedEdge, seedProposition } from "../../src/testing.ts";
import {
  DAY, NOW, call, conceptIn, count, daysFromNow, fakeJob, insertCard, insertDeclaration, insertReport, insertSession, insertSuggestion,
  insertTemplate, insertTemplateError, iso, mastery, sessionReportData, subject, world,
} from "./helpers.ts";

const exam = (db: ReturnType<typeof world>["ctx"]["db"], id: string, subjectId: string, title: string, date: string, scope: string[] = []) =>
  db.prepare("INSERT INTO exams (id, subject_id, title, date, scope_concept_ids_json, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, subjectId, title, date, JSON.stringify(scope), NOW);

describe("GET /brief", () => {
  function setup() {
    const w = world();
    const s = subject(w.ctx, "Linear Algebra");
    // C1 weak with two dependents; C2 to review; C3 solid; C4 with no record
    const [c1, c2, c3, c4] = ["C1", "C2", "C3", "C4"].map((n) => conceptIn(w.ctx, s, n)) as [string, string, string, string];
    mastery(w.ctx, c1, "weak"); mastery(w.ctx, c2, "review"); mastery(w.ctx, c3, "solid");
    seedEdge(w.ctx.db, c1, c2, "high");
    seedEdge(w.ctx.db, c1, c3, "high");
    exam(w.ctx.db, "e_soon", s, "Midterm 1", "2026-11-12"); // 2 days left, scope = the whole subject
    exam(w.ctx.db, "e_past", s, "Old midterm", "2026-11-01");
    return { ...w, s, c1, c2, c3, c4 };
  }

  it("has exactly the daily-brief shape (strict schema) even with an empty database", async () => {
    const { app } = world();
    const r = await call(app, "get", "/brief?date=2026-11-10");
    expect(r.status).toBe(200);
    expect(DailyBriefSchema.parse(r.json)).toMatchObject({
      date: "2026-11-10", examsSoon: [], dueCards: { count: 0, confirmationPending: 0 }, weakest: [], yesterday: [], recurringErrors: [], suggestedToday: [],
    });
    expect((await call(app, "get", "/brief?date=10-11-2026")).status).toBe(400);
  });

  it("without ?date it uses today according to the Hub's clock", async () => {
    const { app } = world();
    expect(DailyBriefSchema.parse((await call(app, "get", "/brief")).json).date).toBe("2026-11-10");
  });

  it("examsSoon: daysLeft, P(prepared) = mean of P' with evidence (0.3+0.65+0.95)/3 and unknownCount; excludes past ones", async () => {
    const { app } = setup();
    const b = DailyBriefSchema.parse((await call(app, "get", "/brief?date=2026-11-10")).json);
    expect(b.examsSoon).toHaveLength(1);
    expect(b.examsSoon[0]).toMatchObject({ title: "Midterm 1", subject: "Linear Algebra", date: "2026-11-12", daysLeft: 2, unknownCount: 1 });
    expect(b.examsSoon[0]!.preparedProbability).toBeCloseTo((0.3 + 0.65 + 0.95) / 3, 6);
  });

  it("weakest: the weakest first, with state, P', stale and last evidence", async () => {
    const { app, c1, c2, c3 } = setup();
    const b = DailyBriefSchema.parse((await call(app, "get", "/brief?date=2026-11-10")).json);
    const ids = b.weakest.map((w) => w.conceptId);
    expect(ids[0]).toBe(c1);
    expect(ids.indexOf(c1)).toBeLessThan(ids.indexOf(c2));
    if (ids.includes(c3)) expect(ids.indexOf(c2)).toBeLessThan(ids.indexOf(c3));
    expect(b.weakest[0]).toMatchObject({ name: "C1", subject: "Linear Algebra", state: "weak", stale: true, lastEvidenceAt: NOW });
    expect(b.weakest[0]!.probability).toBeCloseTo(0.3, 6);
  });

  it("suggestedToday follows the priority of ADR 102 §9: proximity × (1−P') × (1+dependents)", async () => {
    const { app, c1, c2, c3, c4 } = setup();
    // proximity = 1/(1+2) = 1/3. C1: 1/3·0.70·(1+2) = 0.7000 · C4 (P'=0.5): 1/3·0.5·1 = 0.1667
    // C2: 1/3·0.35·1 = 0.1167 · C3: 1/3·0.05·1 = 0.0167
    const b = DailyBriefSchema.parse((await call(app, "get", "/brief?date=2026-11-10")).json);
    expect(b.suggestedToday.length).toBeGreaterThanOrEqual(1);
    const flat = b.suggestedToday.flatMap((x) => x.conceptIds);
    expect(flat[0]).toBe(c1);
    const order = [c1, c4, c2, c3].filter((id) => flat.includes(id));
    expect(flat.filter((id) => order.includes(id))).toEqual(order);
    for (const s of b.suggestedToday) expect(s.why.length).toBeGreaterThan(0);
  });

  it("dueCards counts the overdue ones and confirmationPending the unanswered confirmation cards", async () => {
    const { ctx, app, c1 } = setup();
    for (let i = 0; i < 3; i++) insertCard(ctx.db, { conceptId: c1, intervalDays: 1, tRefMs: Date.parse(NOW) - 3 * DAY }); // overdue
    insertCard(ctx.db, { conceptId: c1, intervalDays: 10, tRefMs: Date.parse(NOW) }); // not overdue
    const d1 = insertDeclaration(ctx.db, { conceptId: c1, createdAt: daysFromNow(-0.1) });
    for (let i = 0; i < 2; i++) {
      const id = insertCard(ctx.db, { conceptId: c1, purpose: "confirmation", createdAt: daysFromNow(-0.5) });
      ctx.db.prepare("UPDATE cards SET declaration_id = ? WHERE id = ?").run(d1, id);
    }
    insertCard(ctx.db, { conceptId: c1, purpose: "confirmation", retired: true, createdAt: daysFromNow(-0.5) }); // already answered
    const b = DailyBriefSchema.parse((await call(app, "get", "/brief?date=2026-11-10")).json);
    expect(b.dueCards.confirmationPending).toBe(2);
    // the overdue review ones (3) count; the not-overdue one does not; the confirmation ones may or may not add up (≤ 5)
    expect(b.dueCards.count).toBeGreaterThanOrEqual(3);
    expect(b.dueCards.count).toBeLessThanOrEqual(5);
  });

  it("yesterday: sessions closed yesterday with the report's highlights; those of other days do not", async () => {
    const { ctx, app, s } = setup();
    insertSession(ctx.db, { chatId: "c_yesterday", title: "Yesterday's session", subjectId: s, hubState: "closed", closedAt: "2026-11-09T15:00:00.000Z" });
    insertSession(ctx.db, { chatId: "c_old", title: "Days ago", subjectId: s, hubState: "closed", closedAt: "2026-11-07T15:00:00.000Z" });
    insertSession(ctx.db, { chatId: "c_noreport", title: "No report", subjectId: s, hubState: "closed", closedAt: "2026-11-09T10:00:00.000Z" });
    insertReport(ctx.db, { kind: "session", chatId: "c_yesterday", subjectId: s, data: sessionReportData("c_yesterday", s) });
    const b = DailyBriefSchema.parse((await call(app, "get", "/brief?date=2026-11-10")).json);
    expect(b.yesterday.map((y) => y.chatId).sort()).toEqual(["c_noreport", "c_yesterday"]);
    const withReport = b.yesterday.find((y) => y.chatId === "c_yesterday")!;
    expect(withReport.title).toBe("Yesterday's session");
    expect(typeof withReport.highlights).toBe("string");
    expect(b.yesterday.find((y) => y.chatId === "c_noreport")!.highlights).toBeNull();
  });

  it("recurringErrors: readable names and only those seen at least once", async () => {
    const { ctx, app, c1 } = setup();
    const t = insertTemplate(ctx.db, c1, { name: "Eigenvalues 2x2" });
    insertTemplateError(ctx.db, t, "sign", "Forgets the sign of the determinant", 3);
    insertTemplateError(ctx.db, t, "never", "Not seen", 0);
    const b = DailyBriefSchema.parse((await call(app, "get", "/brief?date=2026-11-10")).json);
    expect(b.recurringErrors).toEqual([{ template: "Eigenvalues 2x2", error: "Forgets the sign of the determinant", timesSeen: 3 }]);
  });
});

describe("GET /health", () => {
  it("contract shape and services that are down reflected with ok:false (always 200)", async () => {
    const { app } = world({ lh: fakeLh(), evalApi: fakeEval({ health: async () => false }) });
    const r = await call(app, "get", "/health");
    expect(r.status).toBe(200);
    const h = HealthSchema.parse(r.json);
    expect(h.ok).toBe(false);
    expect(h.lh.reachable).toBe(false);
    expect(h.lh.error).toEqual(expect.any(String));
    expect(h.eval.reachable).toBe(false);
    expect(h.worker.alive).toBe(false);
    expect(h.worker.lastHeartbeatAt).toBeNull();
    expect(h.backup).toEqual({ lastAt: null, lastOk: null, repoSizeBytes: null, sizeWarning: false });
    expect(h.metrics.questionsWithConceptPct).toBeNull();
    expect(h.jobs).toEqual({ queued: 0, running: 0, failed: 0, oldestQueuedAt: null });
  });

  it("reachable eval is reflected; job queue and LLM of the last 24 h", async () => {
    const { ctx, app } = world({ evalApi: fakeEval({ health: async () => true }) });
    const t1 = new Date(Date.parse(NOW) - 2 * 3600_000);
    const t2 = new Date(Date.parse(NOW) - 1 * 3600_000);
    enqueueJob(ctx.db, "lh-sync", {}, { now: t2, runAfter: t2 });
    enqueueJob(ctx.db, "concept-curate", {}, { now: t1, runAfter: t1 });
    enqueueJob(ctx.db, "edges-derive", {}, { now: t2, runAfter: t2 });
    ctx.db.prepare("UPDATE jobs SET status = 'failed' WHERE type = 'edges-derive'").run();
    enqueueJob(ctx.db, "backup", {}, { now: t2, runAfter: t2 });
    ctx.db.prepare("UPDATE jobs SET status = 'running' WHERE type = 'backup'").run();
    const usage = (id: string, ok: number, at: string) =>
      ctx.db.prepare("INSERT INTO llm_usage (id, task, provider, model, input_tokens, output_tokens, ok, at) VALUES (?, 'x', 'claude-cli', 'm', 1, 1, ?, ?)").run(id, ok, at);
    usage("u1", 1, daysFromNow(-0.1)); usage("u2", 1, daysFromNow(-0.5)); usage("u3", 0, daysFromNow(-0.9)); usage("u4", 1, daysFromNow(-3));

    const h = HealthSchema.parse((await call(app, "get", "/health")).json);
    expect(h.eval).toEqual({ reachable: true, error: null });
    expect(h.jobs).toEqual({ queued: 2, running: 1, failed: 1, oldestQueuedAt: t1.toISOString() });
    expect(h.llm.calls24h).toBe(3);
    expect(h.llm.failed24h).toBe(1);
  });

  it("R2: % of LH questions with a concept = lh_* events / (lh_* events + unassigned)", async () => {
    const { ctx, app } = world();
    const c = conceptIn(ctx, null, "C");
    mastery(ctx, c, "solid"); // 3 lh_quiz events
    ctx.db.prepare("INSERT INTO unassigned_questions (chat_id, tool_call_id, source, payload_json, created_at) VALUES ('c', 'x1', 'lh_probe', '{}', ?)").run(NOW);
    const h = HealthSchema.parse((await call(app, "get", "/health")).json);
    expect(h.metrics.questionsWithConceptPct).toBeCloseTo(75, 6);
  });
});

describe("GET /inbox", () => {
  it("concepts without a subject, without live propositions, open suggestions and failed templates", async () => {
    const { ctx, app } = world();
    const s = subject(ctx);
    const loose = conceptIn(ctx, null, "Loose", ["One", "Two"]);
    const orphan = conceptIn(ctx, s, "Orphan");
    const onlyDead = conceptIn(ctx, s, "Only deleted");
    const dead = seedProposition(ctx.db, { statement: "Deleted", conceptId: onlyDead });
    ctx.db.prepare("UPDATE lh_propositions SET deleted = 1 WHERE id = ?").run(dead);
    const fine = conceptIn(ctx, s, "Fine", ["Alive"]);
    const merged = conceptIn(ctx, s, "Merged");
    ctx.db.prepare("UPDATE concepts SET status = 'merged', merged_into = ? WHERE id = ?").run(fine, merged);
    const sug = insertSuggestion(ctx.db, "merge", { sourceIds: [orphan], targetId: fine });
    insertSuggestion(ctx.db, "merge", { sourceIds: [orphan], targetId: fine }, { status: "dismissed" });
    const bad = insertTemplate(ctx.db, fine, { status: "failed", name: "Broken method", validation: { ok: false, problems: ["answer missing"] } });
    insertTemplate(ctx.db, fine, { status: "active" });

    const r = await call(app, "get", "/inbox");
    expect(r.status).toBe(200);
    const inbox = InboxSchema.parse(r.json);
    expect(inbox.unassignedConcepts).toEqual([{ conceptId: loose, name: "Loose", description: "Description.", propositionCount: 2 }]);
    expect(inbox.orphanConcepts.map((o) => o.conceptId).sort()).toEqual([orphan, onlyDead].sort());
    expect(inbox.suggestions.map((x) => x.id)).toEqual([sug]);
    expect(inbox.failedTemplates).toHaveLength(1);
    expect(inbox.failedTemplates[0]).toMatchObject({ templateId: bad, conceptId: fine, conceptName: "Fine" });
    expect(inbox.unknownErrors).toEqual([]);
  });

  it("empty inbox", async () => {
    const { app } = world();
    expect(InboxSchema.parse((await call(app, "get", "/inbox")).json)).toEqual({
      unassignedConcepts: [], suggestions: [], failedTemplates: [], unknownErrors: [], orphanConcepts: [],
    });
  });
});

describe("GET /llm-usage", () => {
  it("groups by (task, provider, model), sorts by calls and treats NULL tokens as 0", async () => {
    const { ctx, app } = world();
    const ins = (id: string, task: string, model: string, inT: number | null, outT: number | null, ok: number, at: string) =>
      ctx.db.prepare("INSERT INTO llm_usage (id, task, provider, model, input_tokens, output_tokens, ok, at) VALUES (?, ?, 'claude-cli', ?, ?, ?, ?, ?)").run(id, task, model, inT, outT, ok, at);
    ins("1", "concept-curate@v1", "haiku", 100, 10, 1, daysFromNow(-1));
    ins("2", "concept-curate@v1", "haiku", 200, 20, 0, daysFromNow(-2));
    ins("3", "concept-curate@v1", "haiku", null, null, 1, daysFromNow(-3));
    ins("4", "report-text@v1", "sonnet", 500, 50, 1, daysFromNow(-1));
    ins("5", "concept-curate@v1", "haiku", 999, 99, 1, daysFromNow(-10)); // outside the window

    const r = await call(app, "get", "/llm-usage?days=7");
    expect(r.status).toBe(200);
    const u = LlmUsageSchema.parse(r.json);
    expect(u.days).toBe(7);
    expect(u.since).toBe(daysFromNow(-7));
    expect(u.rows).toEqual([
      { task: "concept-curate@v1", provider: "claude-cli", model: "haiku", calls: 3, ok: 2, inputTokens: 300, outputTokens: 30 },
      { task: "report-text@v1", provider: "claude-cli", model: "sonnet", calls: 1, ok: 1, inputTokens: 500, outputTokens: 50 },
    ]);
    // default 7 days; ?days=30 includes the old row
    expect(LlmUsageSchema.parse((await call(app, "get", "/llm-usage")).json).days).toBe(7);
    expect(LlmUsageSchema.parse((await call(app, "get", "/llm-usage?days=30")).json).rows[0]).toMatchObject({ calls: 4, inputTokens: 1299 });
    expect((await call(app, "get", "/llm-usage?days=0")).status).toBe(400);
  });
});

describe("job declarations-expire (expiry)", () => {
  it("expires pending declarations older than 14 days and leaves the 13-day ones; their evidence is not deleted", async () => {
    const { ctx } = world();
    const c = conceptIn(ctx, null, "C");
    mastery(ctx, c, "pending", iso(Date.parse(NOW) - 15 * DAY));
    const old = insertDeclaration(ctx.db, { conceptId: c, createdAt: iso(Date.parse(NOW) - 15 * DAY) });
    const recent = insertDeclaration(ctx.db, { conceptId: c, createdAt: iso(Date.parse(NOW) - 13 * DAY) });
    const confirmed = insertDeclaration(ctx.db, { conceptId: c, createdAt: iso(Date.parse(NOW) - 20 * DAY), status: "confirmed" });

    await ALL_HANDLERS["declarations-expire"]!(ctx, fakeJob("declarations-expire"));

    const row = (id: string) => ctx.db.prepare("SELECT status, resolved_at AS r FROM declarations WHERE id = ?").get(id);
    expect(row(old)).toEqual({ status: "expired", r: NOW });
    expect(row(recent)).toEqual({ status: "pending", r: null });
    expect(row(confirmed)).toEqual({ status: "confirmed", r: null });
    expect(count(ctx.db, "SELECT count(*) FROM evidence_events WHERE concept_id = ?", c)).toBe(1);

    // idempotent
    await ALL_HANDLERS["declarations-expire"]!(ctx, fakeJob("declarations-expire"));
    expect(row(old)).toEqual({ status: "expired", r: NOW });
  });
});
