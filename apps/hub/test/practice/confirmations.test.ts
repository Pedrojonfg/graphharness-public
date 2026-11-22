// Confirmation items (ADR 102 points 10 and 13): createConfirmationItems, REST review and MCP answer_confirmation.
// REAL eval: the instances and their grading come from uvicorn.
import { AnswerConfirmationInputSchema, AnswerConfirmationOutputSchema, CardQueueSchema, CardReviewResponseSchema, ConfirmationItemSchema } from "@graphharness/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.ts";
import { recordEvidence } from "../../src/services/evidence.ts";
import { createConfirmationItems } from "../../src/services/confirmations.ts";
import { practiceTools } from "../../src/mcp/practice.ts";
import { makeTestContext, seedConcept, seedSubject, setNow, startEval } from "../../src/testing.ts";
import { call, evidenceOf, instancePayload, row, seedDeclaration, seedTemplate, storedP } from "./helpers.ts";

let ev: Awaited<ReturnType<typeof startEval>>;
beforeAll(async () => {
  ev = await startEval();
});
afterAll(() => ev?.stop());

async function declared() {
  const ctx = makeTestContext({ evalApi: ev.client });
  const app = createApp(ctx, { pwaDist: "/nonexistent" });
  const subject = seedSubject(ctx.db);
  const concept = seedConcept(ctx.db, { subjectId: subject, computable: true });
  await seedTemplate(ctx, { conceptId: concept });
  const declarationId = seedDeclaration(ctx, concept, "review");
  recordEvidence(
    ctx.db,
    { conceptId: concept, at: ctx.now().toISOString(), source: "declaration", correct: null, responseFormat: null, weight: 1, targetState: "review", justification: "Class today", ref: { declarationId } },
    ctx.now(),
  );
  return { ctx, app, concept, declarationId };
}

const itemsOf = async (ctx: Awaited<ReturnType<typeof declared>>["ctx"], declarationId: string, conceptId: string) =>
  (await createConfirmationItems(ctx, { declarationId, conceptId })).map((i) => ConfirmationItemSchema.parse(i));

describe("createConfirmationItems with an active template", () => {
  it("creates 1–2 purpose=confirmation cards with an eval instance and no solution in the item", async () => {
    const { ctx, concept, declarationId } = await declared();
    const items = await itemsOf(ctx, declarationId, concept);
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items.length).toBeLessThanOrEqual(2);
    for (const it of items) {
      expect(it.conceptId).toBe(concept);
      expect(it.front.instance).not.toBeNull();
      const card = row(ctx.db, "SELECT * FROM cards WHERE id = ?", it.itemId);
      expect(card).toMatchObject({ purpose: "confirmation", declaration_id: declarationId, concept_id: concept, retired: 0 });
      expect(card.instance_id).toBeTruthy();
      const inst = row(ctx.db, "SELECT * FROM instances WHERE id = ?", card.instance_id);
      expect(it.front.instance).toEqual(JSON.parse(inst.client_json));
      // the solution only lives in payload_json
      expect(Object.keys(JSON.parse(inst.client_json))).not.toContain("answer");
      expect(JSON.stringify(it)).not.toContain(String(instancePayload(ctx.db, card.instance_id).answer));
    }
  });

  it("the queue hides them for 10 min, then they go first and without solution (strict parse); kind≠mcq carries answer null", async () => {
    const { ctx, app, concept, declarationId } = await declared();
    const items = await itemsOf(ctx, declarationId, concept);
    let q = CardQueueSchema.parse((await call(app, "GET", "/cards/queue")).json);
    expect(q.cards).toHaveLength(0);
    setNow(ctx, "2026-11-10T09:10:30.000Z");
    q = CardQueueSchema.parse((await call(app, "GET", "/cards/queue")).json);
    expect(q.confirmationPending).toBe(items.length);
    expect(q.cards.map((c) => c.id).sort()).toEqual(items.map((i) => i.itemId).sort());
    for (const c of q.cards) {
      expect(c.purpose).toBe("confirmation");
      expect(c.declarationId).toBe(declarationId);
      expect(c.front.instance).not.toBeNull();
      if (c.kind !== "mcq") expect(c.answer).toBeNull(); // the Hub grades it with eval from `given`
    }
  });
});

describe("POST /cards/:id/review of a confirmation card (REST)", () => {
  it("hit: eval grades given → confirmation evidence weight 1 (0.55 + 0.15 = 0.70), declaration confirmed, card retired", async () => {
    const { ctx, app, concept, declarationId } = await declared();
    const [item] = await itemsOf(ctx, declarationId, concept);
    const card = row(ctx.db, "SELECT instance_id FROM cards WHERE id = ?", item.itemId);
    const payload = instancePayload(ctx.db, card.instance_id);
    const given = item.kind === "mcq" ? payload.mcq.correct : payload.answer;

    const r = await call(app, "POST", `/cards/${item.itemId}/review`, { given, responseMs: 4000 });
    expect(r.status).toBe(200);
    const body = CardReviewResponseSchema.parse(r.json);
    expect(body).toMatchObject({ cardId: item.itemId, correct: true, early: false, evidenceRecorded: true, retired: true });
    expect(body.expectedAnswer).toEqual(payload.answer);
    expect(body.conceptState?.probability).toBeCloseTo(0.7, 2);
    expect(body.conceptState?.manualConfirmation).toBe("confirmed");

    const evs = evidenceOf(ctx.db, concept, "confirmation");
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ correct: 1, weight: 1, inferred: 0 });
    expect(evidenceOf(ctx.db, concept, "flashcard")).toHaveLength(0);
    expect(storedP(ctx.db, concept)).toBeCloseTo(0.7, 2);
    expect(row(ctx.db, "SELECT status, resolved_at FROM declarations WHERE id = ?", declarationId)).toMatchObject({ status: "confirmed" });
    expect(row(ctx.db, "SELECT retired FROM cards WHERE id = ?", item.itemId).retired).toBe(1);

    // retired: no longer in the queue; answering it again → 409 without a second piece of evidence
    setNow(ctx, "2026-11-10T10:00:00.000Z");
    const again = await call(app, "POST", `/cards/${item.itemId}/review`, { given, responseMs: 4000 });
    expect(again.status).toBe(409);
    expect(again.json.error).toBe("already_answered");
    expect(evidenceOf(ctx.db, concept, "confirmation")).toHaveLength(1);
    const q = CardQueueSchema.parse((await call(app, "GET", "/cards/queue")).json);
    expect(q.cards.map((c) => c.id)).not.toContain(item.itemId);
  });

  it("miss: confirmation evidence correct=0 (0.55 − 0.20 = 0.35), declaration refuted and the card is retired all the same", async () => {
    const { ctx, app, concept, declarationId } = await declared();
    const [item] = await itemsOf(ctx, declarationId, concept);
    const r = await call(app, "POST", `/cards/${item.itemId}/review`, { given: item.kind === "mcq" ? "not-an-option" : "12345", responseMs: 4000 });
    expect(r.status).toBe(200);
    const body = CardReviewResponseSchema.parse(r.json);
    expect(body).toMatchObject({ correct: false, evidenceRecorded: true, retired: true });
    expect(body.expectedAnswer).not.toBeNull();
    expect(body.conceptState?.probability).toBeCloseTo(0.35, 2);
    expect(evidenceOf(ctx.db, concept, "confirmation")[0]).toMatchObject({ correct: 0, weight: 1 });
    expect(row(ctx.db, "SELECT status FROM declarations WHERE id = ?", declarationId).status).toBe("refuted");
    expect(row(ctx.db, "SELECT retired FROM cards WHERE id = ?", item.itemId).retired).toBe(1);
  });

  it("if `correct` arrives on a card the Hub grades, it is ignored (eval decides)", async () => {
    const { ctx, app, concept, declarationId } = await declared();
    const [item] = await itemsOf(ctx, declarationId, concept);
    const r = await call(app, "POST", `/cards/${item.itemId}/review`, { correct: true, given: item.kind === "mcq" ? "not-an-option" : "12345" });
    expect(r.status).toBe(200);
    expect(CardReviewResponseSchema.parse(r.json).correct).toBe(false);
    expect(evidenceOf(ctx.db, concept, "confirmation")[0].correct).toBe(0);
  });

  it("without `given` on a card the Hub grades → 409 given_required", async () => {
    const { ctx, app, concept, declarationId } = await declared();
    const [item] = await itemsOf(ctx, declarationId, concept);
    const r = await call(app, "POST", `/cards/${item.itemId}/review`, { correct: true });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("given_required");
    expect(evidenceOf(ctx.db, concept, "confirmation")).toHaveLength(0);
  });
});

describe("MCP answer_confirmation", () => {
  it("hit: output matches the contract, confirmation evidence weight 1, declaration confirmed", async () => {
    const { ctx, concept, declarationId } = await declared();
    const [item] = await itemsOf(ctx, declarationId, concept);
    const card = row(ctx.db, "SELECT instance_id FROM cards WHERE id = ?", item.itemId);
    const payload = instancePayload(ctx.db, card.instance_id);
    const answer = item.kind === "mcq" ? payload.mcq.correct : payload.answer;

    const input = AnswerConfirmationInputSchema.parse({ itemId: item.itemId, answer });
    const out = AnswerConfirmationOutputSchema.parse(await practiceTools.answer_confirmation(ctx, input));
    expect(out.correct).toBe(true);
    expect(out.expectedAnswer).toEqual(payload.answer);
    expect(out.conceptState.conceptId).toBe(concept);
    expect(out.conceptState.probability).toBeCloseTo(0.7, 2);
    expect(out.conceptState.manualConfirmation).toBe("confirmed");

    expect(evidenceOf(ctx.db, concept, "confirmation")).toHaveLength(1);
    expect(evidenceOf(ctx.db, concept, "confirmation")[0]).toMatchObject({ correct: 1, weight: 1 });
    expect(row(ctx.db, "SELECT status FROM declarations WHERE id = ?", declarationId).status).toBe("confirmed");
    expect(row(ctx.db, "SELECT retired FROM cards WHERE id = ?", item.itemId).retired).toBe(1);
  });

  it("miss: correct=false, declaration refuted, P drops to 0.35", async () => {
    const { ctx, concept, declarationId } = await declared();
    const [item] = await itemsOf(ctx, declarationId, concept);
    const out = AnswerConfirmationOutputSchema.parse(await practiceTools.answer_confirmation(ctx, { itemId: item.itemId, answer: item.kind === "mcq" ? "x" : "12345" }));
    expect(out.correct).toBe(false);
    expect(out.conceptState.probability).toBeCloseTo(0.35, 2);
    expect(row(ctx.db, "SELECT status FROM declarations WHERE id = ?", declarationId).status).toBe("refuted");
  });

  it("non-existent item → 404 not_found", async () => {
    const { ctx } = await declared();
    await expect(practiceTools.answer_confirmation(ctx, { itemId: "does-not-exist", answer: "1" })).rejects.toMatchObject({ status: 404, body: { error: "not_found" } });
  });
});
