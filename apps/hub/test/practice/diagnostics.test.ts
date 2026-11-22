// Diagnostics from "Prepare exam" (ADR 102 point 2). REAL eval.
import { computeInferenceBump, isoNow, ulid } from "@graphharness/core";
import { DIAGNOSTIC_MAX_ITEMS, DiagnosticAnswerResponseSchema, DiagnosticStateSchema } from "@graphharness/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.ts";
import { recordEvidence } from "../../src/services/evidence.ts";
import { makeTestContext, seedConcept, seedEdge, seedSubject, startEval } from "../../src/testing.ts";
import { call, correctOptionId, evidenceOf, row, rows, seedTemplate } from "./helpers.ts";

let ev: Awaited<ReturnType<typeof startEval>>;
beforeAll(async () => {
  ev = await startEval();
});
afterAll(() => ev?.stop());

function setup() {
  const ctx = makeTestContext({ evalApi: ev.client });
  const app = createApp(ctx, { pwaDist: "/nonexistent" });
  const subject = seedSubject(ctx.db);
  const exam = (scope: string[]) => {
    const id = ulid();
    ctx.db
      .prepare("INSERT INTO exams (id, subject_id, title, date, scope_concept_ids_json, created_at) VALUES (?, ?, 'Midterm', '2026-12-10', ?, ?)")
      .run(id, subject, JSON.stringify(scope), isoNow(ctx.now()));
    return id;
  };
  const concept = async (name: string, withTemplate = true) => {
    const id = seedConcept(ctx.db, { subjectId: subject, name, computable: withTemplate });
    if (withTemplate) await seedTemplate(ctx, { conceptId: id });
    return id;
  };
  const evidence = (conceptId: string, at: string, correct: boolean) =>
    recordEvidence(ctx.db, { conceptId, at, source: "hub_exercise", correct, responseFormat: "open", weight: 1, ref: { seed: ulid() } }, ctx.now());
  const open = async (examId: string) => {
    const r = await call(app, "POST", "/diagnostics", { examId });
    expect(r.status).toBe(201);
    return DiagnosticStateSchema.parse(r.json);
  };
  const answer = async (id: string, itemId: string, a: unknown) => {
    const r = await call(app, "POST", `/diagnostics/${id}/answer`, { itemId, answer: a, responseMs: 5000 });
    return { status: r.status, json: r.json, parsed: r.status === 200 ? DiagnosticAnswerResponseSchema.parse(r.json) : null };
  };
  return { ctx, app, subject, exam, concept, evidence, open, answer };
}

describe("POST /diagnostics", () => {
  it("scope = stale ∪ unknown ∪ pending declaration (with a template); fresh ones and those without a template are not asked", async () => {
    const { ctx, exam, concept, evidence, open, answer } = setup();
    const unknown = await concept("Unknown");
    const stale = await concept("Ancient");
    const pending = await concept("Declared");
    const fresh = await concept("Recent");
    const noTemplate = await concept("No template", false);
    evidence(stale, "2025-09-01T09:00:00.000Z", true); // > 1 year: beyond any half-life
    evidence(fresh, "2026-11-10T09:00:00.000Z", true);
    evidence(fresh, "2026-11-10T09:00:01.000Z", true); // 0.8, recent → not stale
    const declarationId = ulid();
    ctx.db
      .prepare("INSERT INTO declarations (id, concept_id, target_state, justification, origin, status, created_at) VALUES (?, ?, 'solid', 'Class', 'agent', 'pending', ?)")
      .run(declarationId, pending, isoNow(ctx.now()));
    recordEvidence(ctx.db, { conceptId: pending, at: isoNow(ctx.now()), source: "declaration", correct: null, responseFormat: null, targetState: "solid", justification: "Class", ref: { declarationId } }, ctx.now());

    const examId = exam([unknown, stale, pending, fresh, noTemplate]);
    let state = await open(examId);
    expect(state).toMatchObject({ examId, status: "open", answered: 0, maxItems: DIAGNOSTIC_MAX_ITEMS, finished: null });

    const asked = new Set<string>();
    for (let i = 0; i < 20 && state.item; i++) {
      asked.add(state.item.conceptId);
      expect(state.item.format).toBe("mcq"); // first sweep: MCQ
      const r = await answer(state.id, state.item.itemId, { kind: "dont_know" });
      expect(r.status).toBe(200);
      state = r.parsed!.state;
    }
    expect(asked).toEqual(new Set([unknown, stale, pending]));
    expect(state.status).toBe("done");
    expect(state.item).toBeNull();
    expect(state.finished?.reason).toBe("complete");
    expect(state.finished?.unaskableConceptIds).toEqual([noTemplate]);
  });

  it("returns the open diagnostic of the same exam instead of creating another", async () => {
    const { ctx, exam, concept, open } = setup();
    const c = await concept("One");
    const examId = exam([c]);
    const a = await open(examId);
    const b = await open(examId);
    expect(b.id).toBe(a.id);
    expect(b.item?.itemId).toBe(a.item?.itemId);
    expect(rows(ctx.db, "SELECT 1 FROM diagnostics")).toHaveLength(1);
  });

  it("non-existent exam → 404; without examId → 400", async () => {
    const { app } = setup();
    expect((await call(app, "POST", "/diagnostics", { examId: "does-not-exist" })).status).toBe(404);
    expect((await call(app, "POST", "/diagnostics", {})).status).toBe(400);
  });

  it("the question is an MCQ with the correct answer + the typical errors over the same instance, without saying which is the right one", async () => {
    const { ctx, exam, concept, open } = setup();
    const c = await concept("Derivative");
    const state = await open(exam([c]));
    const item = state.item!;
    expect(item.format).toBe("mcq");
    expect(item.conceptName).toBe("Derivative");
    expect(item.options).toHaveLength(2); // correct + power_not_lowered
    expect(item.options!.map((o) => JSON.stringify(o.value))).toHaveLength(new Set(item.options!.map((o) => JSON.stringify(o.value))).size);
    expect(Object.keys(item.options![0]).sort()).toEqual(["id", "value"]);
    expect(item.options!.some((o) => o.id.toLowerCase() === "dont_know" || String(o.value).toLowerCase().includes("don't know"))).toBe(false);
    const inst = rows(ctx.db, "SELECT client_json FROM instances");
    expect(inst.map((r) => JSON.parse(r.client_json))).toContainEqual(item.instance);
  });

  it("answering right → outcome correct and hub_diagnostic evidence is recorded (mcq, weight 1); 0.5 + 0.15 = 0.65", async () => {
    const { ctx, exam, concept, open, answer } = setup();
    const c = await concept("Derivative");
    const state = await open(exam([c]));
    const item = state.item!;
    const r = await answer(state.id, item.itemId, { kind: "mcq", optionId: correctOptionId(ctx.db, item.options!) });
    expect(r.parsed?.outcome).toBe("correct");
    expect(r.parsed?.state.answered).toBe(1);
    const evs = evidenceOf(ctx.db, c, "hub_diagnostic");
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ correct: 1, response_format: "mcq", weight: 1, inferred: 0 });
    expect(row(ctx.db, "SELECT probability FROM concept_state WHERE concept_id = ?", c).probability).toBeCloseTo(0.65, 6);
    expect(row(ctx.db, "SELECT context FROM attempts").context).toBe("diagnostic");
  });

  it("missing an option: outcome incorrect; a don't-know answer: outcome dont_know; the next state advances", async () => {
    const { ctx, exam, concept, open, answer } = setup();
    const c = await concept("Derivative");
    const state = await open(exam([c]));
    const item = state.item!;
    const good = correctOptionId(ctx.db, item.options!);
    const bad = item.options!.find((o) => o.id !== good)!;
    const r = await answer(state.id, item.itemId, { kind: "mcq", optionId: bad.id });
    expect(r.parsed?.outcome).toBe("incorrect");
    expect(r.parsed?.state.answered).toBe(1);
    expect(evidenceOf(ctx.db, c, "hub_diagnostic")[0].correct).toBe(0);
    // miss → next open question for that concept
    const next = r.parsed!.state.item;
    expect(next).not.toBeNull();
    expect(next?.conceptId).toBe(c);
    expect(next?.format).toBe("open");
    expect(next?.options).toBeNull();
    const dk = await answer(state.id, next!.itemId, { kind: "dont_know" });
    expect(dk.parsed?.outcome).toBe("dont_know");
    expect(dk.parsed?.state.answered).toBe(2);
  });

  it("answering the same question twice → 409 already_answered; wrong format → 409 wrong_format; after finishing → diagnostic_finished", async () => {
    const { ctx, exam, concept, open, answer } = setup();
    const c = await concept("Derivative");
    const state = await open(exam([c]));
    const item = state.item!;
    const wrong = await answer(state.id, item.itemId, { kind: "open", userInput: { result: "1" } });
    expect(wrong.status).toBe(409);
    expect(wrong.json.error).toBe("wrong_format");
    const ok = await answer(state.id, item.itemId, { kind: "mcq", optionId: correctOptionId(ctx.db, item.options!) });
    expect(ok.status).toBe(200);
    const dup = await answer(state.id, item.itemId, { kind: "dont_know" });
    expect(dup.status).toBe(409);
    expect(dup.json.error).toBe("already_answered");
    let st = ok.parsed!.state;
    while (st.item) st = (await answer(st.id, st.item.itemId, { kind: "dont_know" })).parsed!.state;
    expect(st.status).toBe("done");
    const late = await answer(st.id, item.itemId, { kind: "dont_know" });
    expect(late.status).toBe(409);
    expect(["diagnostic_finished", "already_answered"]).toContain(late.json.error);
    expect((await call(setup().app, "POST", "/diagnostics/does-not-exist/answer", { itemId: "x", answer: { kind: "dont_know" } })).status).toBe(404);
  });

  it("cap of 20 questions: finishes with reason max_items even if concepts remain", async () => {
    const { exam, concept, open, answer } = setup();
    const ids: string[] = [];
    for (let i = 0; i < 22; i++) ids.push(await concept(`Concept ${i}`));
    let state = await open(exam(ids));
    let n = 0;
    while (state.item && n < 30) {
      state = (await answer(state.id, state.item.itemId, { kind: "dont_know" })).parsed!.state;
      n++;
    }
    expect(n).toBe(20);
    expect(state.answered).toBe(20);
    expect(state.status).toBe("done");
    expect(state.finished?.reason).toBe("max_items");
  });

  it("nothing to ask: scope without stale/unknown/pending concepts with a template → nothing_to_ask", async () => {
    const { exam, concept, evidence, open } = setup();
    const fresh = await concept("Recent");
    evidence(fresh, "2026-11-10T09:00:00.000Z", true);
    evidence(fresh, "2026-11-10T09:00:01.000Z", true);
    const state = await open(exam([fresh]));
    expect(state.status).toBe("done");
    expect(state.item).toBeNull();
    expect(state.finished?.reason).toBe("nothing_to_ask");
  });

  it("upward inference: getting the dependent right raises the prerequisite with hub_diagnostic evidence of weight bump/0.15", async () => {
    const { ctx, exam, concept, open, answer } = setup();
    const prereq = await concept("Prerequisite");
    const dependent = await concept("Dependent");
    seedEdge(ctx.db, prereq, dependent, "high"); // dependent requires prereq
    const state = await open(exam([dependent]));
    expect(state.item?.conceptId).toBe(dependent);
    const r = await answer(state.id, state.item!.itemId, { kind: "mcq", optionId: correctOptionId(ctx.db, state.item!.options!) });
    expect(r.parsed?.outcome).toBe("correct");

    // path of 1 hop, high edge: bump = 0.45 · 1 / 1 → weight 0.45 / 0.15 = 3
    const bump = computeInferenceBump({ edges: [{ from: prereq, to: dependent, confidence: "high" }] }, prereq, dependent, 0.45)!;
    expect(bump).toBeCloseTo(0.45, 9);
    const evs = evidenceOf(ctx.db, prereq, "hub_diagnostic");
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ correct: 1, inferred: 0 });
    expect(evs[0].weight).toBeCloseTo(bump / 0.15, 6);
    expect(evs[0].weight).toBeCloseTo(3, 6);
    // the dependent itself carries its normal evidence of weight 1
    expect(evidenceOf(ctx.db, dependent, "hub_diagnostic")[0].weight).toBe(1);
    // 0.5 + 0.15·3 = 0.95
    expect(row(ctx.db, "SELECT probability FROM concept_state WHERE concept_id = ?", prereq).probability).toBeCloseTo(0.95, 6);
  });

  it("a low edge does not propagate: the prerequisite receives no evidence", async () => {
    const { ctx, exam, concept, open, answer } = setup();
    const prereq = await concept("Prerequisite");
    const dependent = await concept("Dependent");
    seedEdge(ctx.db, prereq, dependent, "low");
    const state = await open(exam([dependent]));
    await answer(state.id, state.item!.itemId, { kind: "mcq", optionId: correctOptionId(ctx.db, state.item!.options!) });
    expect(evidenceOf(ctx.db, prereq)).toHaveLength(0);
  });
});
