// ADR 108: parsons / predict / spot_bug — queue, local grading and validateDraft.
import { CardQueueSchema } from "@graphharness/contracts";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.ts";
import { newSchedule } from "@graphharness/core";
import { validateDraft } from "../../src/services/card-generation.ts";
import { gradeLocally, insertCard } from "../../src/services/cards.ts";
import { makeTestContext, seedConcept, seedSubject } from "../../src/testing.ts";
import { call, seedCard } from "./helpers.ts";

const PROPS = ["p1"] as const;

describe("validateDraft (ADR 108)", () => {
  it("valid parsons", () => {
    const v = validateDraft(
      {
        kind: "parsons",
        front: "Order the loop",
        lines: [
          { id: "l0", text: "for x in xs:", indent: 0 },
          { id: "l1", text: "  print(x)", indent: 0 },
          { id: "d0", text: "pass", indent: 0, distractor: true },
        ],
        order: ["l0", "l1"],
        propositionIds: [],
      },
      PROPS,
    );
    expect(v).toMatchObject({ kind: "parsons", answer: { order: ["l0", "l1"] } });
    expect(v!.parsonsLines).toHaveLength(3);
  });

  it("valid spot_bug", () => {
    const v = validateDraft(
      {
        kind: "spot_bug",
        front: "Which line fails?",
        lines: [
          { id: "l0", text: "a = 1", indent: 0 },
          { id: "l1", text: "b = a +", indent: 0 },
          { id: "l2", text: "print(b)", indent: 0 },
          { id: "l3", text: "return", indent: 0 },
        ],
        lineId: "l1",
        propositionIds: [],
      },
      PROPS,
    );
    expect(v?.answer).toEqual({ lineId: "l1" });
  });
});

describe("gradeLocally", () => {
  it("parsons / predict / spot_bug", () => {
    expect(gradeLocally({ order: ["a", "b"] }, ["a", "b"])).toBe(true);
    expect(gradeLocally({ order: ["a", "b"] }, ["b", "a"])).toBe(false);
    expect(gradeLocally({ text: "42", accepted: ["forty-two"] }, "42")).toBe(true);
    expect(gradeLocally({ lineId: "l2" }, "l2")).toBe(true);
    expect(gradeLocally({ lineId: "l2" }, "l1")).toBe(false);
  });
});

describe("kinds ADR 108 in the queue and review", () => {
  function setup() {
    const ctx = makeTestContext();
    const app = createApp(ctx, { pwaDist: "/nonexistent" });
    const concept = seedConcept(ctx.db, { subjectId: seedSubject(ctx.db) });
    return { ctx, app, concept };
  }

  it("GET queue exposes parsons with lines", async () => {
    const { ctx, app, concept } = setup();
    const id = seedCard(ctx, {
      conceptId: concept,
      kind: "parsons",
      front: "Order",
      lines: [
        { id: "l0", text: "a", indent: 0 },
        { id: "l1", text: "b", indent: 0 },
      ],
      answer: { order: ["l0", "l1"] },
    });
    const q = CardQueueSchema.parse((await call(app, "GET", "/cards/queue")).json);
    const card = q.cards.find((c) => c.id === id)!;
    expect(card.kind).toBe("parsons");
    expect(card.front.parsons?.lines).toHaveLength(2);
    expect(card.options).toBeNull();
  });

  it("POST review grades by given (without correct)", async () => {
    const { ctx, app, concept } = setup();
    const now = ctx.now();
    const id = insertCard(
      ctx.db,
      {
        conceptId: concept,
        kind: "predict",
        frontText: "Output?",
        answer: { text: "6", accepted: [] },
        schedule: newSchedule(now.getTime(), 1),
      },
      now,
    );
    const ok = await call(app, "POST", `/cards/${id}/review`, { given: "6", responseMs: 2000 });
    expect(ok.status).toBe(200);
    expect((ok.json as { correct: boolean }).correct).toBe(true);
    const bad = await call(app, "POST", `/cards/${id}/review`, { given: "7", responseMs: 2000 });
    expect((bad.json as { correct: boolean }).correct).toBe(false);
  });

  it("override allowed in predict, not in parsons", async () => {
    const { ctx, app, concept } = setup();
    const predictId = seedCard(ctx, {
      conceptId: concept,
      kind: "predict",
      front: "x",
      answer: { text: "1", accepted: [] },
    });
    await call(app, "POST", `/cards/${predictId}/review`, { correct: false, responseMs: 1000 });
    expect((await call(app, "POST", `/cards/${predictId}/review`, { override: true })).status).toBe(200);

    const parsonsId = seedCard(ctx, {
      conceptId: concept,
      kind: "parsons",
      front: "Order",
      lines: [
        { id: "l0", text: "a", indent: 0 },
        { id: "l1", text: "b", indent: 0 },
      ],
      answer: { order: ["l0", "l1"] },
    });
    await call(app, "POST", `/cards/${parsonsId}/review`, { correct: false, responseMs: 1000 });
    expect((await call(app, "POST", `/cards/${parsonsId}/review`, { override: true })).status).toBe(409);
  });
});
