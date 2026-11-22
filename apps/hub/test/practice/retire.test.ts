// POST /cards/:id/retire — takes the card out of the queue (retired=1). Idempotent, no evidence or schedule change.
import { CardQueueSchema, CardRetireResponseSchema } from "@graphharness/contracts";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.ts";
import { makeTestContext, seedConcept, seedSubject, setNow } from "../../src/testing.ts";
import { call, DAY_MS, row, rows, seedCard, seedDeclaration } from "./helpers.ts";

const NOW_MS = Date.parse("2026-11-10T09:00:00.000Z");

function setup() {
  const ctx = makeTestContext();
  const app = createApp(ctx, { pwaDist: "/nonexistent" });
  const concept = seedConcept(ctx.db, { subjectId: seedSubject(ctx.db) });
  return { ctx, app, concept };
}

const queueIds = async (app: ReturnType<typeof setup>["app"]) => CardQueueSchema.parse((await call(app, "GET", "/cards/queue")).json).cards.map((c) => c.id);
const SCHEDULE_COLS = "ease, interval_days, repetitions, t_ref, reviewed";

describe("POST /cards/:id/retire", () => {
  it("review card → 200 {cardId, retired:true}, retired=1, schedule intact, no card_reviews or evidence, and out of the queue", async () => {
    const { ctx, app, concept } = setup();
    // non-default values to detect any scheduling change
    const id = seedCard(ctx, { conceptId: concept, reviewed: true, repetitions: 3, intervalDays: 8, ease: 2.2, tRefMs: NOW_MS - 20 * DAY_MS });
    const other = seedCard(ctx, { conceptId: concept, reviewed: true, repetitions: 1, intervalDays: 2, tRefMs: NOW_MS - 10 * DAY_MS });
    expect(await queueIds(app)).toContain(id);
    const before = row(ctx.db, `SELECT ${SCHEDULE_COLS} FROM cards WHERE id = ?`, id);
    const otherBefore = row(ctx.db, "SELECT * FROM cards WHERE id = ?", other);

    const r = await call(app, "POST", `/cards/${id}/retire`);
    expect(r.status).toBe(200);
    expect(CardRetireResponseSchema.parse(r.json)).toEqual({ cardId: id, retired: true });

    expect(row(ctx.db, "SELECT retired FROM cards WHERE id = ?", id).retired).toBe(1);
    expect(row(ctx.db, `SELECT ${SCHEDULE_COLS} FROM cards WHERE id = ?`, id)).toEqual(before);
    expect(rows(ctx.db, "SELECT 1 FROM card_reviews")).toHaveLength(0);
    expect(rows(ctx.db, "SELECT 1 FROM evidence_events")).toHaveLength(0);
    expect(row(ctx.db, "SELECT * FROM cards WHERE id = ?", other)).toEqual(otherBefore); // the others are untouched

    const ids = await queueIds(app);
    expect(ids).not.toContain(id);
    expect(ids).toContain(other);
  });

  it("already retired → 200 idempotent with retired:true and nothing changes", async () => {
    const { ctx, app, concept } = setup();
    const id = seedCard(ctx, { conceptId: concept, reviewed: true, repetitions: 2, intervalDays: 6, retired: true, tRefMs: NOW_MS - 7 * DAY_MS });
    const before = row(ctx.db, "SELECT * FROM cards WHERE id = ?", id);

    const r = await call(app, "POST", `/cards/${id}/retire`);
    expect(r.status).toBe(200);
    expect(CardRetireResponseSchema.parse(r.json)).toEqual({ cardId: id, retired: true });
    expect(row(ctx.db, "SELECT * FROM cards WHERE id = ?", id)).toEqual(before);

    // and a second call after retiring through the API itself
    const id2 = seedCard(ctx, { conceptId: concept });
    expect((await call(app, "POST", `/cards/${id2}/retire`)).status).toBe(200);
    const again = await call(app, "POST", `/cards/${id2}/retire`);
    expect(again.status).toBe(200);
    expect(CardRetireResponseSchema.parse(again.json)).toEqual({ cardId: id2, retired: true });
    expect(row(ctx.db, "SELECT retired FROM cards WHERE id = ?", id2).retired).toBe(1);
    expect(rows(ctx.db, "SELECT 1 FROM card_reviews")).toHaveLength(0);
    expect(rows(ctx.db, "SELECT 1 FROM evidence_events")).toHaveLength(0);
  });

  it("unknown id → 404 and nothing is created", async () => {
    const { ctx, app, concept } = setup();
    // The 404 of "non-existent route" (app.notFound) is identical to that of "non-existent card": it is first required that the route exists
    // (a real card is retired with 200) so that this test does not pass vacuously.
    const real = seedCard(ctx, { conceptId: concept });
    expect((await call(app, "POST", `/cards/${real}/retire`)).status).toBe(200);

    const r = await call(app, "POST", "/cards/does-not-exist/retire");
    expect(r.status).toBe(404);
    expect(r.json).toEqual({ error: "not_found" });
    expect(rows(ctx.db, "SELECT 1 FROM cards WHERE retired = 1")).toHaveLength(1); // only the real one
    expect(rows(ctx.db, "SELECT 1 FROM card_reviews")).toHaveLength(0);
  });

  it("confirmation card → 200, retired=1 and out of the queue, no evidence", async () => {
    const { ctx, app, concept } = setup();
    const declarationId = seedDeclaration(ctx, concept);
    const id = seedCard(ctx, { conceptId: concept, purpose: "confirmation", declarationId, intervalDays: 1 });
    setNow(ctx, "2026-11-10T09:11:00.000Z"); // DECLARATION_CONFIRM_DEFER_MIN wait elapsed: now visible
    expect(await queueIds(app)).toContain(id);
    const before = row(ctx.db, `SELECT ${SCHEDULE_COLS} FROM cards WHERE id = ?`, id);

    const r = await call(app, "POST", `/cards/${id}/retire`);
    expect(r.status).toBe(200);
    expect(CardRetireResponseSchema.parse(r.json)).toEqual({ cardId: id, retired: true });

    expect(row(ctx.db, "SELECT retired FROM cards WHERE id = ?", id).retired).toBe(1);
    expect(row(ctx.db, `SELECT ${SCHEDULE_COLS} FROM cards WHERE id = ?`, id)).toEqual(before);
    expect(rows(ctx.db, "SELECT 1 FROM card_reviews")).toHaveLength(0);
    expect(rows(ctx.db, "SELECT 1 FROM evidence_events")).toHaveLength(0);
    expect(await queueIds(app)).not.toContain(id);
    expect(CardQueueSchema.parse((await call(app, "GET", "/cards/queue")).json).confirmationPending).toBe(0);
  });
});
