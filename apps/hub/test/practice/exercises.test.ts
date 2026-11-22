// Deterministic exercises (ADR 102 points 5 and 14). REAL eval; fake LLM (hint and explanation).
import { ExerciseAttemptResponseSchema, ExerciseExplanationSchema, ExerciseHintResponseSchema, ExerciseSchema } from "@graphharness/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.ts";
import { makeTestContext, seedConcept, seedSubject, startEval } from "../../src/testing.ts";
import { call, callsOf, evidenceOf, explainCandidates, hintCandidates, instancePayload, llmFor, row, rows, seedTemplate, storedP } from "./helpers.ts";

let ev: Awaited<ReturnType<typeof startEval>>;
beforeAll(async () => {
  ev = await startEval();
});
afterAll(() => ev?.stop());

const HINT = "REPHRASED-HINT: remember to lower the exponent when differentiating.";
const WRONG = "12345"; // never matches the derivative nor the recipe's error (a, b ≠ 0)

async function setup() {
  const llm = llmFor({
    hint: () => hintCandidates(HINT),
    explain: () =>
      explainCandidates("Differentiate term by term.", [
        { text: "We differentiate $x^3$: $x+1=1+x$ always holds.", formulas: ["x+1=1+x"] },
        { text: "And we conclude that $x+1=x+2$.", formulas: ["x+1=x+2"] },
      ]),
  });
  const ctx = makeTestContext({ evalApi: ev.client, llm });
  const app = createApp(ctx, { pwaDist: "/nonexistent" });
  const concept = seedConcept(ctx.db, { subjectId: seedSubject(ctx.db), computable: true });
  const { templateId } = await seedTemplate(ctx, { conceptId: concept });
  const start = async () => {
    const r = await call(app, "POST", "/exercises", { templateId });
    expect(r.status).toBe(201);
    return ExerciseSchema.parse(r.json);
  };
  const attempt = (instanceId: string, result: unknown) => call(app, "POST", `/exercises/${instanceId}/attempt`, { userInput: { result }, responseMs: 7000 });
  return { ctx, app, llm, concept, templateId, start, attempt };
}

describe("POST /exercises", () => {
  it("returns the instance without solution (client_json) and stores the solution only in payload_json", async () => {
    const { ctx, templateId, concept, start } = await setup();
    const ex = await start();
    expect(ex).toMatchObject({ templateId, conceptId: concept, templateName: "Derivative of a polynomial" });
    expect(ex.methodSummary).toContain("Lower the exponent");
    expect(ex.instance).toMatchObject({ recipeVersion: 1, answerKind: "expression" });
    const inst = row(ctx.db, "SELECT * FROM instances WHERE id = ?", ex.instanceId);
    expect(JSON.parse(inst.client_json)).toEqual(ex.instance);
    const payload = JSON.parse(inst.payload_json);
    expect(payload.answer).toBeTruthy();
    expect(Object.keys(payload.errors)).toContain("power_not_lowered");
    expect(JSON.stringify(ex)).not.toContain(payload.answer);
  });

  it("non-existent template → 404; not active → 409 template_not_active; invalid body → 400", async () => {
    const { ctx, app, concept } = await setup();
    expect((await call(app, "POST", "/exercises", { templateId: "does-not-exist" })).status).toBe(404);
    const { templateId } = await seedTemplate(ctx, { conceptId: concept, status: "retired" });
    const r = await call(app, "POST", "/exercises", { templateId });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("template_not_active");
    expect((await call(app, "POST", "/exercises", {})).status).toBe(400);
  });
});

// Contract: exactly one of {templateId} or {conceptId}. With conceptId the first active template of the
// concept (activeTemplateOf) is used; the response and the evidence are the same as with templateId.
describe("POST /exercises {conceptId}", () => {
  it("picks the concept's active template (not the retired one), responds the same as with templateId and the attempt records hub_exercise", async () => {
    const { ctx, app } = await setup();
    const concept = seedConcept(ctx.db, { subjectId: seedSubject(ctx.db), computable: true });
    await seedTemplate(ctx, { conceptId: concept, status: "retired" });
    const { templateId } = await seedTemplate(ctx, { conceptId: concept });
    const r = await call(app, "POST", "/exercises", { conceptId: concept });
    expect(r.status).toBe(201);
    const ex = ExerciseSchema.parse(r.json);
    expect(ex).toMatchObject({ templateId, conceptId: concept, templateName: "Derivative of a polynomial" });
    expect(row(ctx.db, "SELECT template_id FROM instances WHERE id = ?", ex.instanceId).template_id).toBe(templateId);
    const payload = instancePayload(ctx.db, ex.instanceId);
    const a = await call(app, "POST", `/exercises/${ex.instanceId}/attempt`, { userInput: { result: payload.answer }, responseMs: 7000 });
    expect(a.status).toBe(200);
    expect(ExerciseAttemptResponseSchema.parse(a.json)).toMatchObject({ correct: true, finished: true });
    const evs = evidenceOf(ctx.db, concept, "hub_exercise");
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ correct: 1, response_format: "open", weight: 1 });
  });

  it("both fields or neither → 400 invalid_request, without creating an instance", async () => {
    const { ctx, app, concept, templateId } = await setup();
    const both = await call(app, "POST", "/exercises", { templateId, conceptId: concept });
    expect(both.status).toBe(400);
    expect(both.json.error).toBe("invalid_request");
    const none = await call(app, "POST", "/exercises", {});
    expect(none.status).toBe(400);
    expect(none.json.error).toBe("invalid_request");
    expect(rows(ctx.db, "SELECT 1 FROM instances")).toHaveLength(0);
  });

  it("non-existent concept → 404 not_found", async () => {
    const { app } = await setup();
    const r = await call(app, "POST", "/exercises", { conceptId: "does-not-exist" });
    expect(r.status).toBe(404);
    expect(r.json.error).toBe("not_found");
  });

  it("concept without an active template (none, or only a retired one) → 409 template_not_active", async () => {
    const { ctx, app } = await setup();
    const bare = seedConcept(ctx.db, { subjectId: seedSubject(ctx.db), computable: true });
    const r1 = await call(app, "POST", "/exercises", { conceptId: bare });
    expect(r1.status).toBe(409);
    expect(r1.json.error).toBe("template_not_active");
    const retiredOnly = seedConcept(ctx.db, { subjectId: seedSubject(ctx.db), computable: true });
    await seedTemplate(ctx, { conceptId: retiredOnly, status: "retired" });
    const r2 = await call(app, "POST", "/exercises", { conceptId: retiredOnly });
    expect(r2.status).toBe(409);
    expect(r2.json.error).toBe("template_not_active");
  });
});

describe("POST /exercises/:id/attempt", () => {
  it("hit: correct, finished with solution, hub_exercise open evidence weight 1 (0.5 + 0.15 = 0.65)", async () => {
    const { ctx, concept, start, attempt } = await setup();
    const ex = await start();
    const payload = instancePayload(ctx.db, ex.instanceId);
    const r = await attempt(ex.instanceId, payload.answer);
    expect(r.status).toBe(200);
    const body = ExerciseAttemptResponseSchema.parse(r.json);
    expect(body).toMatchObject({ attemptNumber: 1, correct: true, outcome: "correct", canRetry: false, finished: true });
    expect(body.solution).toEqual(payload.answer);
    expect(body.conceptState?.probability).toBeCloseTo(0.65, 6);
    const evs = evidenceOf(ctx.db, concept, "hub_exercise");
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ correct: 1, response_format: "open", weight: 1, inferred: 0 });
    expect(storedP(ctx.db, concept)).toBeCloseTo(0.65, 6);
    const a = row(ctx.db, "SELECT * FROM attempts WHERE instance_id = ?", ex.instanceId);
    expect(a).toMatchObject({ correct: 1, context: "exercise", unknown_pattern: 0, matched_error_id: null, hints_used: 0, response_ms: 7000 });
    // already finished: another attempt → 409
    const again = await attempt(ex.instanceId, payload.answer);
    expect(again.status).toBe(409);
    expect(again.json.error).toBe("exercise_finished");
  });

  it("known error of the instance: known_error, retry available, without solution, times_seen++ and incorrect evidence (0.30)", async () => {
    const { ctx, concept, templateId, start, attempt } = await setup();
    const ex = await start();
    const payload = instancePayload(ctx.db, ex.instanceId);
    const r = await attempt(ex.instanceId, payload.errors.power_not_lowered);
    const body = ExerciseAttemptResponseSchema.parse(r.json);
    expect(body).toMatchObject({ attemptNumber: 1, correct: false, outcome: "known_error", canRetry: true, finished: false, solution: null });
    expect(body.conceptState?.probability).toBeCloseTo(0.3, 6);
    const err = row(ctx.db, "SELECT * FROM template_errors WHERE template_id = ? AND key = 'power_not_lowered'", templateId);
    expect(err.times_seen).toBe(1);
    expect(err.last_seen_at).toBe("2026-11-10T09:00:00.000Z");
    const a = row(ctx.db, "SELECT * FROM attempts WHERE instance_id = ?", ex.instanceId);
    expect(a).toMatchObject({ correct: 0, matched_error_id: err.id, unknown_pattern: 0 });
    expect(evidenceOf(ctx.db, concept, "hub_exercise")[0]).toMatchObject({ correct: 0, weight: 1 });
    expect(rows(ctx.db, "SELECT 1 FROM unknown_errors")).toHaveLength(0);
    expect(rows(ctx.db, "SELECT 1 FROM jobs WHERE type = 'error-hypothesize'")).toHaveLength(0);
  });

  // ADR 106: the attempt time multiplies the weight of hub_exercise (≤ 5 s ×1.1, ≥ 30 s ×0.9).
  it.each([
    [true, 3000, 1.1],
    [false, 40000, 0.9],
  ])("weight by time: correct=%s in %s ms → weight %s, response_ms and weight_multiplier stored", async (ok, responseMs, mult) => {
    const { ctx, app, concept, start } = await setup();
    const ex = await start();
    const payload = instancePayload(ctx.db, ex.instanceId);
    const result = ok ? payload.answer : payload.errors.power_not_lowered;
    const r = await call(app, "POST", `/exercises/${ex.instanceId}/attempt`, { userInput: { result }, responseMs });
    expect(r.status).toBe(200);
    const evs = evidenceOf(ctx.db, concept, "hub_exercise");
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ correct: ok ? 1 : 0, response_ms: responseMs, miss_class: null });
    expect(evs[0].weight).toBeCloseTo(mult, 10);
    expect(evs[0].weight_multiplier).toBeCloseTo(mult, 10);
  });

  it("second attempt: after a known miss, getting it right or wrong ends the exercise with the solution (attemptNumber 2)", async () => {
    const { ctx, start, attempt } = await setup();
    const ex = await start();
    const payload = instancePayload(ctx.db, ex.instanceId);
    await attempt(ex.instanceId, payload.errors.power_not_lowered);
    const second = ExerciseAttemptResponseSchema.parse((await attempt(ex.instanceId, payload.errors.power_not_lowered)).json);
    expect(second).toMatchObject({ attemptNumber: 2, correct: false, canRetry: false, finished: true });
    expect(second.solution).toEqual(payload.answer);
  });

  it("unknown error: unknown_error, open unknown_errors and an error-hypothesize job enqueued with its id", async () => {
    const { ctx, templateId, start, attempt } = await setup();
    const ex = await start();
    const body = ExerciseAttemptResponseSchema.parse((await attempt(ex.instanceId, WRONG)).json);
    expect(body).toMatchObject({ correct: false, outcome: "unknown_error", canRetry: true, finished: false, solution: null });
    const a = row(ctx.db, "SELECT * FROM attempts WHERE instance_id = ?", ex.instanceId);
    expect(a).toMatchObject({ correct: 0, unknown_pattern: 1, matched_error_id: null });
    const ue = rows(ctx.db, "SELECT * FROM unknown_errors");
    expect(ue).toHaveLength(1);
    expect(ue[0]).toMatchObject({ attempt_id: a.id, template_id: templateId, status: "open" });
    const jobs = rows(ctx.db, "SELECT * FROM jobs WHERE type = 'error-hypothesize'");
    expect(jobs).toHaveLength(1);
    expect(JSON.parse(jobs[0].payload_json)).toEqual({ unknownErrorId: ue[0].id });
    expect(jobs[0].status).toBe("queued");
  });

  it("unreadable answer or non-existent instance: 404 for the instance; invalid body → 400", async () => {
    const { app, start } = await setup();
    expect((await call(app, "POST", "/exercises/does-not-exist/attempt", { userInput: { result: "1" } })).status).toBe(404);
    const ex = await start();
    const bad = await call(app, "POST", `/exercises/${ex.instanceId}/attempt`, { userInput: { answer: "1" } });
    expect(bad.status).toBe(400);
  });
});

describe("POST /exercises/:id/hint", () => {
  it("hint for a known error: the LLM (cheap) rephrases it, it is cached in template_errors.hint and counts as a used hint", async () => {
    const { ctx, app, llm, templateId, start, attempt } = await setup();
    const ex = await start();
    await attempt(ex.instanceId, instancePayload(ctx.db, ex.instanceId).errors.power_not_lowered);
    const r = await call(app, "POST", `/exercises/${ex.instanceId}/hint`);
    expect(r.status).toBe(200);
    const body = ExerciseHintResponseSchema.parse(r.json);
    expect(body).toMatchObject({ instanceId: ex.instanceId, kind: "known_error", hintsUsed: 1 });
    expect(body.hint).toContain("REPHRASED-HINT");
    expect(callsOf(llm, "hint")).toHaveLength(1);
    expect(callsOf(llm, "hint")[0].tier).toBe("cheap");
    expect(row(ctx.db, "SELECT hint FROM template_errors WHERE template_id = ? AND key = 'power_not_lowered'", templateId).hint).toContain("REPHRASED-HINT");
    expect(row(ctx.db, "SELECT hints_used FROM attempts WHERE instance_id = ?", ex.instanceId).hints_used).toBe(1);
  });

  it("the second hint of the same error (another instance) comes from the cache: the LLM is not called again", async () => {
    const { ctx, app, llm, start, attempt } = await setup();
    const first = await start();
    await attempt(first.instanceId, instancePayload(ctx.db, first.instanceId).errors.power_not_lowered);
    const h1 = ExerciseHintResponseSchema.parse((await call(app, "POST", `/exercises/${first.instanceId}/hint`)).json);
    expect(callsOf(llm, "hint")).toHaveLength(1);

    const second = await start();
    await attempt(second.instanceId, instancePayload(ctx.db, second.instanceId).errors.power_not_lowered);
    const h2 = ExerciseHintResponseSchema.parse((await call(app, "POST", `/exercises/${second.instanceId}/hint`)).json);
    expect(h2).toMatchObject({ kind: "known_error", hint: h1.hint, hintsUsed: 1 });
    expect(callsOf(llm, "hint")).toHaveLength(1);
  });

  it("a hit after using a hint counts as mcq (quick) in hub_exercise evidence", async () => {
    const { ctx, app, concept, start, attempt } = await setup();
    const ex = await start();
    const hint = await call(app, "POST", `/exercises/${ex.instanceId}/hint`);
    expect(hint.status).toBe(200);
    expect(ExerciseHintResponseSchema.parse(hint.json).hintsUsed).toBe(1);
    const r = ExerciseAttemptResponseSchema.parse((await attempt(ex.instanceId, instancePayload(ctx.db, ex.instanceId).answer)).json);
    expect(r).toMatchObject({ correct: true, finished: true });
    const evs = evidenceOf(ctx.db, concept, "hub_exercise");
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ correct: 1, response_format: "mcq", weight: 1 });
  });

  it("after an unknown miss the hint is a method hint (kind method), with no recognised pattern", async () => {
    const { app, start, attempt } = await setup();
    const ex = await start();
    await attempt(ex.instanceId, WRONG);
    const body = ExerciseHintResponseSchema.parse((await call(app, "POST", `/exercises/${ex.instanceId}/hint`)).json);
    expect(body).toMatchObject({ kind: "method", hintsUsed: 1 });
    expect(body.hint.length).toBeGreaterThan(0);
  });

  it("finished exercise → 409 exercise_finished; non-existent instance → 404", async () => {
    const { ctx, app, start, attempt } = await setup();
    const ex = await start();
    await attempt(ex.instanceId, instancePayload(ctx.db, ex.instanceId).answer);
    const r = await call(app, "POST", `/exercises/${ex.instanceId}/hint`);
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("exercise_finished");
    expect((await call(app, "POST", "/exercises/does-not-exist/hint")).status).toBe(404);
  });
});

describe("POST /exercises/:id/explain", () => {
  it("without attempts → 409 no_attempt", async () => {
    const { app, start } = await setup();
    const ex = await start();
    const r = await call(app, "POST", `/exercises/${ex.instanceId}/explain`, {});
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("no_attempt");
  });

  it("omits the formulas eval does not verify and warns; verified ones come out with verified:true", async () => {
    const { app, llm, start, attempt } = await setup();
    const ex = await start();
    await attempt(ex.instanceId, WRONG);
    const r = await call(app, "POST", `/exercises/${ex.instanceId}/explain`, { steps: ["3x^2"], learnerExplanation: "I think the exponent goes down" });
    expect(r.status).toBe(200);
    const body = ExerciseExplanationSchema.parse(r.json);
    expect(body.instanceId).toBe(ex.instanceId);
    expect(callsOf(llm, "explain")).toHaveLength(1);
    expect(callsOf(llm, "explain")[0].tier).toBe("strong");
    expect(body.omittedFormulas).toBe(1);
    const formulas = body.steps.flatMap((s) => s.formulas);
    expect(formulas.map((f) => f.latex.replace(/\s/g, ""))).toContain("x+1=1+x");
    expect(formulas.every((f) => f.verified === true)).toBe(true);
    // the false formula does not appear anywhere in the response
    expect(JSON.stringify(body).replace(/\s/g, "")).not.toContain("x+1=x+2");
  });

  it("non-existent instance → 404; body with more than 20 steps → 400", async () => {
    const { app, start, attempt } = await setup();
    expect((await call(app, "POST", "/exercises/does-not-exist/explain", {})).status).toBe(404);
    const ex = await start();
    await attempt(ex.instanceId, WRONG);
    expect((await call(app, "POST", `/exercises/${ex.instanceId}/explain`, { steps: Array(21).fill("x") })).status).toBe(400);
  });
});
