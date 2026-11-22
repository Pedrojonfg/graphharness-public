// GET /cards/queue (D14/D15, ADR 102 points 10 and 13). Without eval: cards seeded via SQL.
import { CardQueueSchema } from "@graphharness/contracts";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.ts";
import { makeTestContext, seedConcept, seedSubject, setNow } from "../../src/testing.ts";
import { call, DAY_MS, seedCard, seedDeclaration } from "./helpers.ts";

const NOW_MS = Date.parse("2026-11-10T09:00:00.000Z");

function setup() {
  const ctx = makeTestContext();
  const app = createApp(ctx, { pwaDist: "/nonexistent" });
  const concept = seedConcept(ctx.db, { subjectId: seedSubject(ctx.db), name: "Derivatives" });
  return { ctx, app, concept };
}

describe("GET /cards/queue", () => {
  it("sorts by priority (now − tRef)/interval, excludes retired ones and computes dueCount/total", async () => {
    const { ctx, app, concept } = setup();
    // priority 3.0 · 1.5 · 0.1 (not overdue) · retired (does not appear)
    const c1 = seedCard(ctx, { conceptId: concept, reviewed: true, intervalDays: 1, tRefMs: NOW_MS - 3 * DAY_MS });
    const c2 = seedCard(ctx, { conceptId: concept, reviewed: true, intervalDays: 2, tRefMs: NOW_MS - 3 * DAY_MS });
    const c3 = seedCard(ctx, { conceptId: concept, reviewed: true, intervalDays: 10, tRefMs: NOW_MS - DAY_MS });
    seedCard(ctx, { conceptId: concept, reviewed: true, intervalDays: 1, tRefMs: NOW_MS - 30 * DAY_MS, retired: true });

    const r = await call(app, "GET", "/cards/queue");
    expect(r.status).toBe(200);
    const q = CardQueueSchema.parse(r.json);
    expect(q.cards.map((c) => c.id)).toEqual([c1, c2, c3]);
    expect(q.total).toBe(3);
    expect(q.dueCount).toBe(2);
    expect(q.confirmationPending).toBe(0);
    expect(q.nextOffset).toBeNull();
    expect(q.cards[0].schedule.priority).toBeCloseTo(3, 6);
    expect(q.cards[1].schedule.priority).toBeCloseTo(1.5, 6);
    expect(q.cards[2].schedule.priority).toBeCloseTo(0.1, 6);
    expect(q.cards.map((c) => c.schedule.due)).toEqual([true, true, false]);
    expect(q.cards[0].schedule.intervalDays).toBe(1);
    expect(q.cards[0].conceptName).toBe("Derivatives");
    expect(q.cards[0].purpose).toBe("review");
  });

  it("paginates with offset/limit and nextOffset", async () => {
    const { ctx, app, concept } = setup();
    const ids = [3, 2, 1].map((d) => seedCard(ctx, { conceptId: concept, reviewed: true, intervalDays: 1, tRefMs: NOW_MS - d * DAY_MS }));
    const p1 = CardQueueSchema.parse((await call(app, "GET", "/cards/queue?offset=0&limit=2")).json);
    expect(p1.cards.map((c) => c.id)).toEqual(ids.slice(0, 2));
    expect(p1.total).toBe(3);
    expect(p1.nextOffset).toBe(2);
    const p2 = CardQueueSchema.parse((await call(app, "GET", "/cards/queue?offset=2&limit=2")).json);
    expect(p2.cards.map((c) => c.id)).toEqual([ids[2]]);
    expect(p2.nextOffset).toBeNull();
    expect((await call(app, "GET", "/cards/queue?limit=0")).status).toBe(400);
  });

  it("carries the answer of the cards graded locally (MCQ and text)", async () => {
    const { ctx, app, concept } = setup();
    const mcq = seedCard(ctx, { conceptId: concept, kind: "mcq", reviewed: true, tRefMs: NOW_MS - 3 * DAY_MS, intervalDays: 1 });
    const txt = seedCard(ctx, {
      conceptId: concept,
      kind: "text",
      reviewed: true,
      tRefMs: NOW_MS - 2 * DAY_MS,
      intervalDays: 1,
      answer: { text: "the slope", accepted: ["slope"] },
    });
    const q = CardQueueSchema.parse((await call(app, "GET", "/cards/queue")).json);
    const byId = new Map(q.cards.map((c) => [c.id, c]));
    expect(byId.get(mcq)?.answer).toEqual({ optionId: "o1" });
    expect(byId.get(mcq)?.options).toEqual([{ id: "o1", value: "4" }, { id: "o2", value: "5" }]);
    expect(byId.get(txt)?.answer).toEqual({ text: "the slope", accepted: ["slope"] });
    expect(byId.get(txt)?.options).toBeNull();
    expect(byId.get(txt)?.front.text).toBe("Question $x$");
  });

  it("confirmation cards do not appear until DECLARATION_CONFIRM_DEFER_MIN (10 min) and then go first", async () => {
    const { ctx, app, concept } = setup();
    const normal = seedCard(ctx, { conceptId: concept, reviewed: true, intervalDays: 1, tRefMs: NOW_MS - 30 * DAY_MS }); // priority 30
    const declarationId = seedDeclaration(ctx, concept);
    const conf = seedCard(ctx, { conceptId: concept, purpose: "confirmation", declarationId, intervalDays: 1 }); // created now

    const ids = async () => CardQueueSchema.parse((await call(app, "GET", "/cards/queue")).json);

    let q = await ids();
    expect(q.cards.map((c) => c.id)).toEqual([normal]);
    expect(q.confirmationPending).toBe(0);

    setNow(ctx, "2026-11-10T09:09:59.000Z");
    q = await ids();
    expect(q.cards.map((c) => c.id)).toEqual([normal]);
    expect(q.total).toBe(1);

    setNow(ctx, "2026-11-10T09:10:01.000Z");
    q = await ids();
    expect(q.cards.map((c) => c.id)).toEqual([conf, normal]);
    expect(q.confirmationPending).toBe(1);
    expect(q.cards[0].purpose).toBe("confirmation");
    expect(q.cards[0].declarationId).toBe(declarationId);
  });

  it("several visible confirmation ones all go before the normal ones", async () => {
    const { ctx, app, concept } = setup();
    const declarationId = seedDeclaration(ctx, concept);
    const normal = seedCard(ctx, { conceptId: concept, reviewed: true, intervalDays: 1, tRefMs: NOW_MS + 9 * 60_000 - 90 * DAY_MS });
    const c1 = seedCard(ctx, { conceptId: concept, purpose: "confirmation", declarationId });
    const c2 = seedCard(ctx, { conceptId: concept, purpose: "confirmation", declarationId });
    setNow(ctx, "2026-11-10T09:11:00.000Z");
    const q = CardQueueSchema.parse((await call(app, "GET", "/cards/queue")).json);
    expect(q.cards.at(-1)?.id).toBe(normal);
    expect(new Set(q.cards.slice(0, 2).map((c) => c.id))).toEqual(new Set([c1, c2]));
    expect(q.confirmationPending).toBe(2);
  });

  it("a retired confirmation (already answered) does not return to the queue", async () => {
    const { ctx, app, concept } = setup();
    const declarationId = seedDeclaration(ctx, concept);
    seedCard(ctx, { conceptId: concept, purpose: "confirmation", declarationId, retired: true });
    setNow(ctx, "2026-11-10T10:00:00.000Z");
    const q = CardQueueSchema.parse((await call(app, "GET", "/cards/queue")).json);
    expect(q.total).toBe(0);
    expect(q.confirmationPending).toBe(0);
  });
});
