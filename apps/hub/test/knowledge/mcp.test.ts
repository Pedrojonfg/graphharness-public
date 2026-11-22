// L1 — MCP tools of the KNOWLEDGE lane, validated against the `output` of MCP_TOOLS.
import { MCP_TOOLS, type McpToolName } from "@graphharness/contracts";
import { describe, expect, it } from "vitest";
import { knowledgeTools } from "../../src/mcp/knowledge.ts";
import { seedEdge } from "../../src/testing.ts";
import { NOW, brokenLlm, call, conceptIn, count, daysFromNow, insertSuggestion, insertTemplate, insertTemplateError, mastery, subject, world, type Ctx } from "./helpers.ts";

/** Calls the tool and validates the output with the contract's schema. */
async function tool<T = any>(ctx: Ctx, name: McpToolName, input: object): Promise<T> {
  const def = MCP_TOOLS.find((t) => t.name === name)!;
  const handler = knowledgeTools[name];
  if (!handler) throw new Error(`MCP tool ${name} missing`);
  return def.output.parse(await handler(ctx, def.input.parse(input))) as T;
}

describe("knowledgeTools exposes all the lane's tools", () => {
  it("nombres", () => {
    for (const n of [
      "resolve_concepts", "get_concept", "search_knowledge", "get_subject_overview", "get_daily_brief", "declare_learning",
      "add_concept_note", "create_subject", "list_concept_suggestions", "accept_concept_suggestion", "dismiss_concept_suggestion",
    ])
      expect(Object.keys(knowledgeTools), n).toContain(n);
  });
});

describe("resolve_concepts", () => {
  function setup() {
    const w = world(); // fake LLM that answers any task (the rerank, if any, uses its own)
    const s = subject(w.ctx, "Linear Algebra");
    const s2 = subject(w.ctx, "Physics");
    const diag = conceptIn(w.ctx, s, "Diagonalization", ["A real symmetric matrix is orthogonally diagonalizable (spectral theorem)."], "Write A as PDP^-1.");
    const det = conceptIn(w.ctx, s, "Determinants", ["The determinant is multilinear and alternating."], "Computing determinants.");
    const cine = conceptIn(w.ctx, s2, "Kinematics", ["Velocity is the derivative of position."], "Motion without forces.");
    mastery(w.ctx, det, "weak");
    return { ...w, s, s2, diag, det, cine };
  }

  it("finds by proposition statement and by name; score in [0,1] and sorted from highest to lowest", async () => {
    const { ctx, diag, det } = setup();
    const out = await tool(ctx, "resolve_concepts", { text: "symmetric matrix orthogonally diagonalizable" });
    expect(out.candidates.length).toBeGreaterThanOrEqual(1);
    expect(out.candidates[0]).toMatchObject({ conceptId: diag, name: "Diagonalization", subject: "Linear Algebra", state: "unknown" });
    for (const c of out.candidates) expect(c.score).toBeGreaterThanOrEqual(0), expect(c.score).toBeLessThanOrEqual(1);
    const scores = out.candidates.map((c: { score: number }) => c.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);

    const byName = await tool(ctx, "resolve_concepts", { text: "determinants" });
    expect(byName.candidates[0]).toMatchObject({ conceptId: det, state: "weak" });
  });

  it("subjectId restricts; no matches returns an empty list; limit trims", async () => {
    const { ctx, s2, cine } = setup();
    const only = await tool(ctx, "resolve_concepts", { text: "matrix velocity determinant", subjectId: s2 });
    expect(only.candidates.map((c: { conceptId: string }) => c.conceptId)).toEqual([cine]);
    expect((await tool(ctx, "resolve_concepts", { text: "zzzzqqqq" })).candidates).toEqual([]);
    expect((await tool(ctx, "resolve_concepts", { text: "matrix velocity determinant derivative", limit: 1 })).candidates).toHaveLength(1);
  });

  it("if the rerank LLM fails, it degrades to the FTS order (it does not break)", async () => {
    const { ctx, diag } = setup();
    ctx.llm = brokenLlm();
    const out = await tool(ctx, "resolve_concepts", { text: "symmetric matrix orthogonally diagonalizable" });
    expect(out.candidates[0].conceptId).toBe(diag);
  });

  it("does not return merged or retired concepts", async () => {
    const { ctx, diag } = setup();
    ctx.db.prepare("UPDATE concepts SET status = 'retired' WHERE id = ?").run(diag);
    // the FTS index is refreshed on state change (refreshConceptFts deletes it); the resolver also filters by status
    const { refreshConceptFts } = await import("../../src/services/fts.ts");
    refreshConceptFts(ctx.db, diag);
    const out = await tool(ctx, "resolve_concepts", { text: "orthogonally diagonalizable" });
    expect(out.candidates.map((c: { conceptId: string }) => c.conceptId)).not.toContain(diag);
  });
});

describe("search_knowledge", () => {
  it("returns concepts and propositions with their statement and concept", async () => {
    const { ctx } = world({ llm: brokenLlm() });
    const s = subject(ctx);
    const c = conceptIn(ctx, s, "Spectral theorem", ["Every Hermitian matrix has real eigenvalues."]);
    const out = await tool(ctx, "search_knowledge", { query: "Hermitian eigenvalues" });
    expect(out.propositions).toHaveLength(1);
    expect(out.propositions[0]).toMatchObject({ statement: "Every Hermitian matrix has real eigenvalues.", conceptId: c, conceptName: "Spectral theorem" });
    expect(out.concepts.map((x: { conceptId: string }) => x.conceptId)).toContain(c);
    expect((await tool(ctx, "search_knowledge", { query: "zzzzqqqq" })).propositions).toEqual([]);
  });
});

describe("get_concept", () => {
  it("returns the same detail as REST and throws not_found", async () => {
    const { ctx, app } = world();
    const c = conceptIn(ctx, subject(ctx), "Rank", ["Rank = dim image."]);
    mastery(ctx, c, "review");
    const out = await tool(ctx, "get_concept", { conceptId: c });
    expect(out).toEqual((await call(app, "get", `/concepts/${c}`)).json);
    await expect(knowledgeTools.get_concept!(ctx, { conceptId: "nope" })).rejects.toMatchObject({ status: 404, body: { error: "not_found" } });
  });
});

describe("get_subject_overview", () => {
  it("groups by state, lists exams from today onwards and recurring errors", async () => {
    const { ctx } = world();
    const s = subject(ctx, "Linear Algebra");
    const [a, b, c, d] = [conceptIn(ctx, s, "A"), conceptIn(ctx, s, "B"), conceptIn(ctx, s, "C"), conceptIn(ctx, s, "D")] as [string, string, string, string];
    mastery(ctx, a, "solid"); mastery(ctx, b, "review"); mastery(ctx, c, "weak");
    const tpl = insertTemplate(ctx.db, c, { name: "Method C" });
    insertTemplateError(ctx.db, tpl, "sign", "Forgets the sign", 4);
    insertTemplateError(ctx.db, tpl, "rare", "Never seen", 0);
    const mkExam = (id: string, date: string) =>
      ctx.db.prepare("INSERT INTO exams (id, subject_id, title, date, created_at) VALUES (?, ?, ?, ?, ?)").run(id, s, id, date, NOW);
    mkExam("past", "2026-11-09");
    mkExam("today", "2026-11-10");
    mkExam("future", "2026-12-15");

    const out = await tool(ctx, "get_subject_overview", { subjectId: s });
    expect(out.subject.id).toBe(s);
    const ids = (g: { conceptId: string }[]) => g.map((x) => x.conceptId);
    expect(ids(out.conceptsByState.solid)).toEqual([a]);
    expect(ids(out.conceptsByState.review)).toEqual([b]);
    expect(ids(out.conceptsByState.weak)).toEqual([c]);
    expect(ids(out.conceptsByState.unknown)).toEqual([d]);
    expect(out.conceptsByState.weak[0].probability).toBeCloseTo(0.3, 6);
    expect(out.conceptsByState.unknown[0].probability).toBeNull();
    expect(out.exams.map((e: { title: string }) => e.title)).toEqual(["today", "future"]);
    expect(out.exams[0].daysLeft).toBe(0);
    expect(out.recurringErrors).toEqual([{ templateId: tpl, template: "Method C", errorKey: "sign", error: "Forgets the sign", timesSeen: 4 }]);
    await expect(knowledgeTools.get_subject_overview!(ctx, { subjectId: "nope" })).rejects.toMatchObject({ status: 404 });
  });
});

describe("declare_learning", () => {
  function setup() {
    const w = world();
    const s = subject(w.ctx);
    const t = conceptIn(w.ctx, s, "Diagonalization");
    const p = conceptIn(w.ctx, s, "Eigenvalues");
    mastery(w.ctx, p, "weak");
    seedEdge(w.ctx.db, p, t, "high");
    return { ...w, s, t, p };
  }
  const input = (t: string, extra: object = {}) => ({ conceptId: t, targetState: "solid", justification: "Class today", rawText: "I just learned how to diagonalize", ...extra });

  it("without ack: needs_ack with the prerequisites and nothing recorded", async () => {
    const { ctx, t, p } = setup();
    const out = await tool(ctx, "declare_learning", input(t));
    expect(out).toMatchObject({ status: "needs_ack", declarationId: null, conceptState: null, confirmationItems: [] });
    expect(out.weakPrerequisites).toEqual([{ conceptId: p, name: "Eigenvalues", state: "weak", path: [p, t] }]);
    expect(count(ctx.db, "SELECT count(*) FROM declarations")).toBe(0);
    expect(count(ctx.db, "SELECT count(*) FROM evidence_events WHERE concept_id = ?", t)).toBe(0);
  });

  it("with ack: recorded, pending declaration (origin agent, rawText), evidence and 1–2 items", async () => {
    const { ctx, t, p } = setup();
    const out = await tool(ctx, "declare_learning", input(t, { ackWeakPrerequisites: true }));
    expect(out.status).toBe("recorded");
    expect(out.weakPrerequisites.map((w: { conceptId: string }) => w.conceptId)).toEqual([p]);
    expect(out.conceptState).toMatchObject({ conceptId: t, manualConfirmation: "pending", state: "solid" });
    expect(out.conceptState.probability).toBeCloseTo(0.85, 6);
    expect(out.confirmationItems.length).toBeGreaterThanOrEqual(1);
    expect(out.confirmationItems.length).toBeLessThanOrEqual(2);
    expect(ctx.db.prepare("SELECT origin, status, raw_text AS raw, ack_weak_prereqs AS ack, justification FROM declarations WHERE id = ?").get(out.declarationId)).toEqual({
      origin: "agent", status: "pending", raw: "I just learned how to diagonalize", ack: 1, justification: "Class today",
    });
    expect(ctx.db.prepare("SELECT ref_json FROM evidence_events WHERE concept_id = ? AND source = 'declaration'").pluck().get(t)).toBe(JSON.stringify({ declarationId: out.declarationId }));
  });

  it("without weak prerequisites it records directly; non-existent concept → not_found", async () => {
    const { ctx, p } = setup();
    const out = await tool(ctx, "declare_learning", { conceptId: p, targetState: "review", justification: "Review" });
    expect(out.status).toBe("recorded");
    expect(out.weakPrerequisites).toEqual([]);
    await expect(knowledgeTools.declare_learning!(ctx, input("nope"))).rejects.toMatchObject({ status: 404 });
  });
});

describe("add_concept_note", () => {
  it("saves the note (origin agent) and shows up in the detail", async () => {
    const { ctx, app } = world();
    const c = conceptIn(ctx, null, "Rank");
    const n = await tool(ctx, "add_concept_note", { conceptId: c, text: "Sure to be on the midterm" });
    expect(n).toMatchObject({ conceptId: c, text: "Sure to be on the midterm", origin: "agent", createdAt: NOW });
    const d = (await call(app, "get", `/concepts/${c}`)).json;
    expect(d.notes.map((x: { id: string }) => x.id)).toEqual([n.id]);
    await expect(knowledgeTools.add_concept_note!(ctx, { conceptId: "nope", text: "x" })).rejects.toMatchObject({ status: 404 });
  });
});

describe("suggestions via MCP", () => {
  it("list / accept / dismiss with 409 not_open", async () => {
    const { ctx } = world();
    const s = subject(ctx);
    const t = conceptIn(ctx, s, "T"), src = conceptIn(ctx, s, "S"), src2 = conceptIn(ctx, s, "S2");
    const m1 = insertSuggestion(ctx.db, "merge", { sourceIds: [src], targetId: t });
    const m2 = insertSuggestion(ctx.db, "merge", { sourceIds: [src2], targetId: t });
    const list = await tool(ctx, "list_concept_suggestions", {});
    expect(list.suggestions.map((x: { id: string }) => x.id).sort()).toEqual([m1, m2].sort());
    expect(await tool(ctx, "accept_concept_suggestion", { suggestionId: m1 })).toEqual({ suggestionId: m1, kind: "merge", conceptIds: [t] });
    const dis = await tool(ctx, "dismiss_concept_suggestion", { suggestionId: m2 });
    expect(dis.suggestion).toMatchObject({ id: m2, status: "dismissed", kind: "merge" });
    await expect(knowledgeTools.accept_concept_suggestion!(ctx, { suggestionId: m1 })).rejects.toMatchObject({ status: 409, body: { error: "not_open" } });
    await expect(knowledgeTools.dismiss_concept_suggestion!(ctx, { suggestionId: m2 })).rejects.toMatchObject({ status: 409, body: { error: "not_open" } });
    expect((await tool(ctx, "list_concept_suggestions", {})).suggestions).toEqual([]);
    expect((await tool(ctx, "list_concept_suggestions", { status: "accepted" })).suggestions).toHaveLength(1);
  });
});

describe("get_daily_brief (MCP) = GET /brief", () => {
  it("returns the same as REST for the same date", async () => {
    const { ctx, app } = world();
    const s = subject(ctx);
    const c = conceptIn(ctx, s, "C");
    mastery(ctx, c, "weak");
    ctx.db.prepare("INSERT INTO exams (id, subject_id, title, date, created_at) VALUES ('e1', ?, 'Midterm', ?, ?)").run(s, daysFromNow(3).slice(0, 10), NOW);
    const viaMcp = await tool(ctx, "get_daily_brief", { date: "2026-11-10" });
    expect(viaMcp).toEqual((await call(app, "get", "/brief?date=2026-11-10")).json);
  });
});
