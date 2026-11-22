// POST /cards/:id/review and POST /cards/import (D14, D15, D26). Without eval: locally graded cards.
import { CardQueueSchema, CardReviewResponseSchema } from "@graphharness/contracts";
import { review as coreReview } from "@graphharness/core";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.ts";
import { makeTestContext, seedConcept, seedSubject, setNow } from "../../src/testing.ts";
import { call, DAY_MS, evidenceOf, row, rows, seedCard, storedP } from "./helpers.ts";

const NOW_MS = Date.parse("2026-11-10T09:00:00.000Z");

function setup() {
  const ctx = makeTestContext();
  const app = createApp(ctx, { pwaDist: "/nonexistent" });
  const concept = seedConcept(ctx.db, { subjectId: seedSubject(ctx.db) });
  return { ctx, app, concept };
}

const parse = (j: unknown) => CardReviewResponseSchema.parse(j);

describe("POST /cards/:id/review", () => {
  it("first correct review: core's SM-2 + flashcard evidence (weight 0.55, mcq): 0.5 + 0.15·0.55 = 0.5825", async () => {
    const { ctx, app, concept } = setup();
    const id = seedCard(ctx, { conceptId: concept, kind: "mcq", intervalDays: 1, tRefMs: NOW_MS - 2 * DAY_MS });
    const r = await call(app, "POST", `/cards/${id}/review`, { correct: true, responseMs: 5000, given: "o1" });
    expect(r.status).toBe(200);
    const body = parse(r.json);
    expect(body).toMatchObject({ cardId: id, correct: true, early: false, evidenceRecorded: true, retired: false, expectedAnswer: null });
    // fast (≤ 8 s) → q = 5; first review: repetitions 1, interval max(1, 1) = 1
    expect(body.schedule.repetitions).toBe(1);
    expect(body.schedule.intervalDays).toBe(1);
    // ADR 106: responseMs 5000 is the inclusive edge of "fast" (≤ 5000) → ×1.1: weight = 0.5 × 1.1 = 0.55; P = 0.5 + 0.15 × 0.55 = 0.5825.
    expect(body.conceptState?.probability).toBeCloseTo(0.5825, 6);

    const ev = evidenceOf(ctx.db, concept);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ source: "flashcard", correct: 1, response_format: "mcq", inferred: 0 });
    expect(ev[0].weight).toBeCloseTo(0.55, 10);
    expect(storedP(ctx.db, concept)).toBeCloseTo(0.5825, 6);

    const c = row(ctx.db, "SELECT * FROM cards WHERE id = ?", id);
    const expected = coreReview({ ease: 2.5, intervalDays: 1, repetitions: 0, tRef: NOW_MS - 2 * DAY_MS, reviewed: false }, { correct: true, responseMs: 5000, now: NOW_MS });
    expect(c).toMatchObject({ reviewed: 1, repetitions: 1, ease: expected.schedule.ease, interval_days: expected.schedule.intervalDays, t_ref: NOW_MS });
    expect(c.ease).toBeCloseTo(2.6, 6);
    const rev = row(ctx.db, "SELECT * FROM card_reviews WHERE card_id = ?", id);
    expect(rev).toMatchObject({ correct: 1, early: 0, override: 0, response_ms: 5000 });
    expect(JSON.parse(rev.given_json)).toBe("o1");
  });

  it("cloze/text count as an open answer (response_format open)", async () => {
    const { ctx, app, concept } = setup();
    const id = seedCard(ctx, { conceptId: concept, kind: "cloze", tRefMs: NOW_MS - 2 * DAY_MS });
    expect((await call(app, "POST", `/cards/${id}/review`, { correct: true, responseMs: 12000 })).status).toBe(200);
    expect(evidenceOf(ctx.db, concept)[0]).toMatchObject({ source: "flashcard", response_format: "open", weight: 0.5 });
  });

  it("slow on-time review: SM-2 interval = round(interval·ease·10)/10 from the second repetition", async () => {
    const { ctx, app, concept } = setup();
    // previous repetition 1, interval 4 d, overdue (t_ref 5 d ago). Slow answer (≥ 25 s) → q = 3
    const id = seedCard(ctx, { conceptId: concept, reviewed: true, repetitions: 1, intervalDays: 4, ease: 2.5, tRefMs: NOW_MS - 5 * DAY_MS });
    const body = parse((await call(app, "POST", `/cards/${id}/review`, { correct: true, responseMs: 30000 })).json);
    // q=3: ease = 2.5 + (0.1 − 2·(0.08 + 2·0.02)) = 2.36 ; interval = round(4·2.36·10)/10 = 9.4
    expect(body.early).toBe(false);
    expect(body.schedule.repetitions).toBe(2);
    expect(body.schedule.intervalDays).toBeCloseTo(9.4, 6);
    expect(row(ctx.db, "SELECT ease FROM cards WHERE id = ?", id).ease).toBeCloseTo(2.36, 6);
  });

  it("early hit: no new evidence and the interval does not grow; only the clock restarts", async () => {
    const { ctx, app, concept } = setup();
    // reviewed, interval 10 d, 1 d ago → priority 0.1 < 1
    const id = seedCard(ctx, { conceptId: concept, reviewed: true, repetitions: 2, intervalDays: 10, tRefMs: NOW_MS - DAY_MS });
    const body = parse((await call(app, "POST", `/cards/${id}/review`, { correct: true, responseMs: 4000 })).json);
    expect(body).toMatchObject({ correct: true, early: true, evidenceRecorded: false, retired: false });
    expect(body.schedule.intervalDays).toBe(10);
    expect(body.schedule.repetitions).toBe(2);
    expect(evidenceOf(ctx.db, concept)).toHaveLength(0);
    expect(storedP(ctx.db, concept)).toBeUndefined();
    const c = row(ctx.db, "SELECT * FROM cards WHERE id = ?", id);
    expect(c).toMatchObject({ interval_days: 10, repetitions: 2, ease: 2.5, t_ref: NOW_MS });
    expect(row(ctx.db, "SELECT early FROM card_reviews WHERE card_id = ?", id).early).toBe(1);
  });

  it("miss: correct=0 evidence with weight 0.5 (0.5 − 0.20·0.5 = 0.40) and scheduling reset", async () => {
    const { ctx, app, concept } = setup();
    const id = seedCard(ctx, { conceptId: concept, reviewed: true, repetitions: 2, intervalDays: 6, ease: 2.5, tRefMs: NOW_MS - 7 * DAY_MS });
    const body = parse((await call(app, "POST", `/cards/${id}/review`, { correct: false, responseMs: 9000 })).json);
    expect(body).toMatchObject({ correct: false, early: false, evidenceRecorded: true, retired: false });
    expect(body.schedule.intervalDays).toBe(1);
    expect(body.schedule.repetitions).toBe(0);
    expect(body.conceptState?.probability).toBeCloseTo(0.4, 6);
    const ev = evidenceOf(ctx.db, concept, "flashcard");
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ correct: 0, weight: 0.5 });
    expect(row(ctx.db, "SELECT ease FROM cards WHERE id = ?", id).ease).toBeCloseTo(2.3, 6);
  });

  it("override within 60 s turns the miss into a hit and the evidence stays consistent (one hit, no miss)", async () => {
    const { ctx, app, concept } = setup();
    const id = seedCard(ctx, { conceptId: concept, kind: "cloze", reviewed: true, repetitions: 2, intervalDays: 6, ease: 2.5, tRefMs: NOW_MS - 7 * DAY_MS });
    const failed = parse((await call(app, "POST", `/cards/${id}/review`, { correct: false })).json);
    expect(failed.correct).toBe(false);
    expect(storedP(ctx.db, concept)).toBeCloseTo(0.4, 6);

    setNow(ctx, "2026-11-10T09:00:30.000Z");
    const r = await call(app, "POST", `/cards/${id}/review`, { override: true });
    expect(r.status).toBe(200);
    const body = parse(r.json);
    // as a hit from the previous state (q=4 without time): ease 2.5, repetitions 3, interval round(6·2.5·10)/10 = 15
    expect(body.correct).toBe(true);
    expect(body.schedule.repetitions).toBe(3);
    expect(body.schedule.intervalDays).toBeCloseTo(15, 6);
    const ev = evidenceOf(ctx.db, concept, "flashcard");
    expect(ev.map((e) => e.correct)).toEqual([1]);
    expect(storedP(ctx.db, concept)).toBeCloseTo(0.575, 6);
    expect(body.conceptState?.probability).toBeCloseTo(0.575, 6);
    const c = row(ctx.db, "SELECT * FROM cards WHERE id = ?", id);
    expect(c).toMatchObject({ repetitions: 3, interval_days: 15 });
  });

  it("override after 60 s → 409 override_window_passed and the miss remains", async () => {
    const { ctx, app, concept } = setup();
    const id = seedCard(ctx, { conceptId: concept, kind: "text", reviewed: true, repetitions: 2, intervalDays: 6, tRefMs: NOW_MS - 7 * DAY_MS });
    await call(app, "POST", `/cards/${id}/review`, { correct: false });
    setNow(ctx, "2026-11-10T09:01:01.000Z");
    const r = await call(app, "POST", `/cards/${id}/review`, { override: true });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("override_window_passed");
    expect(evidenceOf(ctx.db, concept, "flashcard").map((e) => e.correct)).toEqual([0]);
    expect(storedP(ctx.db, concept)).toBeCloseTo(0.4, 6);
  });

  it("override without a previous miss → 409 nothing_to_override", async () => {
    const { ctx, app, concept } = setup();
    const id = seedCard(ctx, { conceptId: concept, kind: "text", reviewed: true, tRefMs: NOW_MS - 7 * DAY_MS });
    const r = await call(app, "POST", `/cards/${id}/review`, { override: true });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("nothing_to_override");
    expect(evidenceOf(ctx.db, concept)).toHaveLength(0);
  });

  it("non-existent card → 404; body without correct/given/override → 400 invalid_request", async () => {
    const { ctx, app, concept } = setup();
    expect((await call(app, "POST", "/cards/does-not-exist/review", { correct: true })).status).toBe(404);
    const id = seedCard(ctx, { conceptId: concept });
    const bad = await call(app, "POST", `/cards/${id}/review`, {});
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe("invalid_request");
  });

  it("card without a concept (imported): reviewed without generating evidence", async () => {
    const { ctx, app } = setup();
    const id = seedCard(ctx, { conceptId: null, tRefMs: NOW_MS - 3 * DAY_MS });
    const r = await call(app, "POST", `/cards/${id}/review`, { correct: true });
    expect(r.status).toBe(200);
    expect(parse(r.json)).toMatchObject({ evidenceRecorded: false, conceptState: null });
    expect(rows(ctx.db, "SELECT 1 FROM evidence_events")).toHaveLength(0);
  });

  // ADR 106: the response time multiplies the card's weight (≤ 5 s ×1.1, ≥ 30 s ×0.9, in between ×1).
  it.each([
    [3000, 1.1],
    [10000, 1],
    [40000, 0.9],
  ])("weight by time: hit in %s ms → weight = 0.5 × %s, with response_ms and weight_multiplier stored", async (responseMs, mult) => {
    const { ctx, app, concept } = setup();
    const id = seedCard(ctx, { conceptId: concept, kind: "cloze", tRefMs: NOW_MS - 2 * DAY_MS });
    const body = parse((await call(app, "POST", `/cards/${id}/review`, { correct: true, responseMs })).json);
    expect(body.evidenceRecorded).toBe(true);
    const ev = evidenceOf(ctx.db, concept, "flashcard");
    expect(ev).toHaveLength(1);
    expect(ev[0].weight).toBeCloseTo(0.5 * mult, 10);
    expect(ev[0].response_ms).toBe(responseMs);
    expect(ev[0].weight_multiplier).toBeCloseTo(mult, 10);
    expect(ev[0].miss_class).toBeNull();
    // P is computed with the multiplied weight: 0.5 + 0.15 × weight
    expect(storedP(ctx.db, concept)).toBeCloseTo(0.5 + 0.15 * 0.5 * mult, 6);
  });

  it("weight by time also on a miss: 3000 ms → weight 0.55", async () => {
    const { ctx, app, concept } = setup();
    const id = seedCard(ctx, { conceptId: concept, reviewed: true, repetitions: 2, intervalDays: 6, tRefMs: NOW_MS - 7 * DAY_MS });
    await call(app, "POST", `/cards/${id}/review`, { correct: false, responseMs: 3000 });
    const ev = evidenceOf(ctx.db, concept, "flashcard");
    expect(ev[0]).toMatchObject({ correct: 0, response_ms: 3000 });
    expect(ev[0].weight).toBeCloseTo(0.55, 10);
  });

  it("without responseMs: weight 0.5 (×1) and response_ms null", async () => {
    const { ctx, app, concept } = setup();
    const id = seedCard(ctx, { conceptId: concept, kind: "cloze", tRefMs: NOW_MS - 2 * DAY_MS });
    await call(app, "POST", `/cards/${id}/review`, { correct: true });
    const ev = evidenceOf(ctx.db, concept, "flashcard");
    expect(ev[0].weight).toBeCloseTo(0.5, 10);
    expect(ev[0].response_ms).toBeNull();
    expect(ev[0].weight_multiplier).toBeCloseTo(1, 10);
  });
});

describe("POST /cards/import (append-only)", () => {
  it("creates cloze/text cards without a concept with answer = back, first interval 1 d without an exam", async () => {
    const { ctx, app } = setup();
    const r = await call(app, "POST", "/cards/import", {
      cards: [
        { kind: "cloze", front: "The derivative of $x^2$ is ____", back: "2x", topic: "Derivatives" },
        { front: "What is an eigenvalue?", back: "A scalar $\\lambda$ with $Av=\\lambda v$" },
      ],
    });
    expect(r.status).toBe(201);
    expect(r.json).toEqual({ created: 2 });
    const cards = rows(ctx.db, "SELECT * FROM cards ORDER BY front_text");
    expect(cards).toHaveLength(2);
    const byFront = new Map(cards.map((c) => [c.front_text, c]));
    const cloze = byFront.get("The derivative of $x^2$ is ____");
    expect(cloze).toMatchObject({ kind: "cloze", purpose: "review", concept_id: null, interval_days: 1, repetitions: 0, reviewed: 0, retired: 0 });
    expect(JSON.parse(cloze.answer_json).text).toBe("2x");
    const text = byFront.get("What is an eigenvalue?");
    expect(text.kind).toBe("text"); // default kind
    expect(JSON.parse(text.answer_json).text).toBe("A scalar $\\lambda$ with $Av=\\lambda v$");

    const q = CardQueueSchema.parse((await call(app, "GET", "/cards/queue")).json);
    expect(q.total).toBe(2);
    expect(q.cards.every((c) => c.schedule.due === false)).toBe(true);
  });

  it("is append-only: a second import adds and does not touch the previous one", async () => {
    const { ctx, app } = setup();
    await call(app, "POST", "/cards/import", { cards: [{ front: "One", back: "1" }] });
    const before = rows(ctx.db, "SELECT * FROM cards");
    const r = await call(app, "POST", "/cards/import", { cards: [{ front: "Dos", back: "2" }, { front: "Tres", back: "3" }] });
    expect(r.json).toEqual({ created: 2 });
    const after = rows(ctx.db, "SELECT * FROM cards");
    expect(after).toHaveLength(3);
    expect(after.filter((c) => c.id === before[0].id)).toEqual(before);
  });

  it("validates with FlashcardImportBodySchema: empty, without back or back > 500 → 400", async () => {
    const { ctx, app } = setup();
    for (const body of [{ cards: [] }, { cards: [{ front: "x" }] }, { cards: [{ front: "x", back: "y".repeat(501) }] }, {}]) {
      const r = await call(app, "POST", "/cards/import", body);
      expect(r.status).toBe(400);
      expect(r.json.error).toBe("invalid_request");
    }
    expect(rows(ctx.db, "SELECT 1 FROM cards")).toHaveLength(0);
  });
});
