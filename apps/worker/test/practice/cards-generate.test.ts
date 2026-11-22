// cards-generate job and generateCardsForSession (GL-057). Real eval; fake LLM (cheap).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { firstReviewDelayDays, isoNow, ulid } from "@graphharness/core";
import { makeTestContext, seedConcept, seedProposition, seedSubject, startEval } from "../../../hub/src/testing.ts";
import { callsOf, cardsCandidates, correctOptionId, llmFor, makeJob, row, rows, seedTemplate, type CardSpec } from "../../../hub/test/practice/helpers.ts";
import { generateCardsForSession, handlers } from "../../src/handlers/practice.ts";

let ev: Awaited<ReturnType<typeof startEval>>;
beforeAll(async () => {
  ev = await startEval();
});
afterAll(() => ev?.stop());

const LONG = "This answer is deliberately far too long for a quick review card";
const MIXED: CardSpec[] = [
  { kind: "mcq", front: "ZZ1 Question with two correct options", options: [{ text: "2x", correct: true }, { text: "x^2", correct: true }, { text: "3", correct: false }, { text: "0", correct: false }] },
  { kind: "text", front: "ZZ2 Question with a long answer", answer: LONG, accepted: [] },
  { kind: "cloze", front: "ZZ3 Derivative of $x^2 is ____", answer: "2x", accepted: [] },
  { kind: "cloze", front: "OK1 The derivative of $x^2$ is ____.", answer: "2x", accepted: ["2*x"] },
  { kind: "text", front: "OK2 What does the derivative measure at a point?", answer: "The slope of the tangent", accepted: ["slope of the tangent"] },
];

function setup(cards: CardSpec[] = MIXED) {
  const llm = llmFor({ cards: () => cardsCandidates(cards) });
  const ctx = makeTestContext({ evalApi: ev.client, llm });
  const subject = seedSubject(ctx.db, { name: "Calculus" });
  const concept = seedConcept(ctx.db, { subjectId: subject, name: "Derivative", computable: true });
  seedProposition(ctx.db, { conceptId: concept, statement: "The derivative of $x^n$ is $n x^{n-1}$.", provenance: [{ chatId: "chat-1", messageId: "m1" }] });
  const exam = (date: string) =>
    ctx.db.prepare("INSERT INTO exams (id, subject_id, title, date, scope_concept_ids_json, created_at) VALUES (?, ?, 'Parcial', ?, '[]', ?)").run(ulid(), subject, date, isoNow(ctx.now()));
  return { ctx, llm, subject, concept, exam };
}

const cardsOf = (db: Parameters<typeof rows>[0], conceptId: string) => rows(db, "SELECT * FROM cards WHERE concept_id = ? ORDER BY created_at, id", conceptId);

describe("cards-generate {conceptId} with an active template", () => {
  it("one template MCQ (correct + eval errors) plus the LLM cards that pass validation", async () => {
    const { ctx, llm, concept, exam } = setup();
    await seedTemplate(ctx, { conceptId: concept });
    exam("2026-12-10");
    await handlers["cards-generate"](ctx, makeJob("cards-generate", { conceptId: concept }));

    const cards = cardsOf(ctx.db, concept);
    const tpl = cards.filter((c) => c.instance_id);
    expect(tpl).toHaveLength(1);
    expect(tpl[0]).toMatchObject({ kind: "mcq", purpose: "review", declaration_id: null, retired: 0, reviewed: 0, repetitions: 0 });
    const options = JSON.parse(tpl[0].options_json) as { id: string; value: unknown }[];
    expect(options).toHaveLength(2); // correct result + power_not_lowered
    const payload = JSON.parse(row(ctx.db, "SELECT payload_json FROM instances WHERE id = ?", tpl[0].instance_id).payload_json);
    // the options come from eval, not from the LLM
    expect(options.map((o) => JSON.stringify(o.value)).sort()).toEqual([payload.mcq.correct, payload.errors.power_not_lowered].map((v) => JSON.stringify(v)).sort());
    expect(JSON.parse(tpl[0].answer_json)).toEqual({ optionId: correctOptionId(ctx.db, options) });
    expect(JSON.parse(row(ctx.db, "SELECT client_json FROM instances WHERE id = ?", tpl[0].instance_id).client_json).statement).toBe(payload.statement);

    // LLM cards: only the valid ones
    const llmCards = cards.filter((c) => !c.instance_id);
    expect(llmCards.map((c) => (c.front_text as string).split(" ")[0]).sort()).toEqual(["OK1", "OK2"]);
    for (const c of llmCards) {
      expect(c.purpose).toBe("review");
      const a = JSON.parse(c.answer_json) as { text: string; accepted: string[] };
      expect(a.text.length).toBeLessThanOrEqual(60);
      expect(a.text.length).toBeGreaterThan(0);
    }
    const ok1 = llmCards.find((c) => c.front_text.startsWith("OK1"))!;
    expect(ok1.kind).toBe("cloze");
    expect(JSON.parse(ok1.answer_json)).toEqual({ text: "2x", accepted: ["2*x"] });
    for (const c of cards) expect(((c.front_text as string | null) ?? "").split("$").length % 2).toBe(1); // even number of $

    // discarded: MCQ with 2 correct options, answer > 60, odd `$`
    expect(cards.some((c) => /ZZ[123]/.test(c.front_text ?? ""))).toBe(false);
    expect(callsOf(llm, "cards")).toHaveLength(1);
    expect(callsOf(llm, "cards")[0].tier).toBe("cheap");
  });

  it("first interval based on the nearest exam of the subject (GL-057): 30 d → floor(30/4) = 7", async () => {
    const { ctx, concept, exam } = setup();
    await seedTemplate(ctx, { conceptId: concept });
    exam("2026-12-10"); // today 2026-11-10 → 30 days
    exam("2027-03-01"); // farther away: does not take precedence
    await handlers["cards-generate"](ctx, makeJob("cards-generate", { conceptId: concept }));
    expect(firstReviewDelayDays(ctx.now(), "2026-12-10")).toBe(7);
    const cards = cardsOf(ctx.db, concept);
    expect(cards.length).toBeGreaterThanOrEqual(3);
    for (const c of cards) expect(c).toMatchObject({ interval_days: 7, ease: 2.5, t_ref: ctx.now().getTime() });
  });

  it("without an exam the first interval is 1 day", async () => {
    const { ctx, concept } = setup();
    await seedTemplate(ctx, { conceptId: concept });
    await handlers["cards-generate"](ctx, makeJob("cards-generate", { conceptId: concept }));
    for (const c of cardsOf(ctx.db, concept)) expect(c.interval_days).toBe(1);
  });

  it("valid LLM MCQ: exactly one correct option and distinct options after normalizeAnswer; a normalized duplicate is discarded", async () => {
    const { ctx, concept } = setup([
      { kind: "mcq", front: "OKM Pick the derivative of $x^2$", options: [{ text: "2x", correct: true }, { text: "x", correct: false }, { text: "2", correct: false }] },
      { kind: "mcq", front: "ZZD Repeated options", options: [{ text: "2x", correct: true }, { text: "2 x", correct: false }, { text: "3", correct: false }] },
    ]);
    await handlers["cards-generate"](ctx, makeJob("cards-generate", { conceptId: concept }));
    const fronts = cardsOf(ctx.db, concept).map((c) => c.front_text as string);
    expect(fronts.some((f) => f.includes("OKM"))).toBe(true);
    expect(fronts.some((f) => f.includes("ZZD"))).toBe(false);
    const ok = cardsOf(ctx.db, concept).find((c) => c.front_text.includes("OKM"))!;
    const opts = JSON.parse(ok.options_json) as { id: string; value: string }[];
    expect(opts).toHaveLength(3);
    expect(opts.find((o) => o.id === JSON.parse(ok.answer_json).optionId)?.value).toBe("2x");
  });
});

describe("cards-generate without a template and idempotency", () => {
  it("without a template there are only LLM cards (none with an instance)", async () => {
    const { ctx, concept } = setup();
    await handlers["cards-generate"](ctx, makeJob("cards-generate", { conceptId: concept }));
    const cards = cardsOf(ctx.db, concept);
    expect(cards.filter((c) => c.instance_id)).toHaveLength(0);
    expect(cards.map((c) => (c.front_text as string).split(" ")[0]).sort()).toEqual(["OK1", "OK2"]);
  });

  it("running the job twice does not duplicate cards", async () => {
    const { ctx, concept } = setup();
    await seedTemplate(ctx, { conceptId: concept });
    await handlers["cards-generate"](ctx, makeJob("cards-generate", { conceptId: concept }));
    const n = cardsOf(ctx.db, concept).length;
    await handlers["cards-generate"](ctx, makeJob("cards-generate", { conceptId: concept }));
    expect(cardsOf(ctx.db, concept)).toHaveLength(n);
  });
});

describe("generateCardsForSession / cards-generate {chatId}", () => {
  it("generates cards for the concepts of the session's propositions, with source_chat_id, and returns their ids", async () => {
    const { ctx, concept } = setup();
    await seedTemplate(ctx, { conceptId: concept });
    const ids = await generateCardsForSession(ctx, "chat-1");
    expect(ids.length).toBeGreaterThanOrEqual(3);
    const cards = cardsOf(ctx.db, concept);
    expect(new Set(ids)).toEqual(new Set(cards.map((c) => c.id)));
    for (const c of cards) expect(c.source_chat_id).toBe("chat-1");
    expect(rows(ctx.db, "SELECT proposition_ids_json FROM cards WHERE concept_id = ? AND instance_id IS NULL", concept).every((c) => JSON.parse(c.proposition_ids_json).length >= 1)).toBe(true);
  });

  it("session without propositions → [] and no LLM call", async () => {
    const { ctx, llm } = setup();
    expect(await generateCardsForSession(ctx, "chat-vacio")).toEqual([]);
    expect(llm.calls).toHaveLength(0);
  });

  it("the handler with a {chatId} payload does the same", async () => {
    const { ctx, concept } = setup();
    await handlers["cards-generate"](ctx, makeJob("cards-generate", { chatId: "chat-1" }));
    expect(cardsOf(ctx.db, concept).length).toBeGreaterThanOrEqual(2);
  });
});
