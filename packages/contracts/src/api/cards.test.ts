import { describe, expect, it } from "vitest";
import { CardQueueSchema, CardSchema } from "./cards.ts";

const instanceCard = {
  id: "01JC0000000000000000000001",
  conceptId: "01JC0000000000000000000002",
  conceptName: "Eigenvalues 2x2",
  kind: "mcq",
  purpose: "review",
  declarationId: null,
  front: {
    text: null,
    instance: { recipeVersion: 1, statement: "Compute $\\det(A)$", answerKind: "number", shape: null, variables: [], choices: null },
  },
  options: [
    { id: "o1", value: "-2" },
    { id: "o2", value: "2" },
  ],
  answer: { optionId: "o1" },
  schedule: { priority: 1.2, due: true, intervalDays: 1, repetitions: 0 },
  sourceChatId: null,
  createdAt: "2026-11-09T08:00:00.000Z",
};

const queue = (card: unknown) => ({ cards: [card], total: 1, dueCount: 1, confirmationPending: 0, nextOffset: null });

describe("card queue: never an instance's solution", () => {
  it("accepts a template card with what is needed to grade locally", () => {
    expect(CardQueueSchema.safeParse(queue(instanceCard)).success).toBe(true);
  });

  it("accepts a card that the Hub grades (answer null)", () => {
    const card = { ...instanceCard, kind: "text", purpose: "confirmation", declarationId: "d1", options: null, answer: null };
    expect(CardSchema.safeParse(card).success).toBe(true);
  });

  // Fields of `instances.payload_json` (eval /v1/generate) that must not leave the Hub.
  for (const [field, value] of [
    ["answer", "-2"],
    ["errors", { sign_error: "2" }],
    ["mcq", { correct: "-2", distractors: { sign_error: "2" } }],
    ["params", { A: [["1", "2"], ["3", "4"]] }],
  ] as const) {
    it(`rejects front.instance.${field}`, () => {
      const card = { ...instanceCard, front: { ...instanceCard.front, instance: { ...instanceCard.front.instance, [field]: value } } };
      expect(CardQueueSchema.safeParse(queue(card)).success).toBe(false);
    });
  }

  for (const field of ["payload", "payloadJson", "solution"]) {
    it(`rejects ${field} on the card`, () => {
      const card = { ...instanceCard, [field]: { answer: "-2", errors: {} } };
      expect(CardQueueSchema.safeParse(queue(card)).success).toBe(false);
    });
  }
});
