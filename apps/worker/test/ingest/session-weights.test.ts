// ADR 106 in session-ingest: weight = weight_base × m (missClass for failed practices, confidence for questions);
// miss_class and weight_multiplier are stored; ref_json is still only the identity (UNIQUE(source, ref_json)).
// Minimal record with LH's exact shape (as in packages/lh-client/src/extract.test.ts).
import { describe, expect, it } from "vitest";
import { makeTestContext, seedConcept, seedProposition, seedSubject } from "@graphharness/hub/testing";
import type { Db } from "@graphharness/db";
import { ChatRecordSchema, type ChatDetail } from "@graphharness/lh-client";
import { runSessionIngest } from "../../src/handlers/ingest.ts";
import { count, lhWith, llmByKind, pickBy } from "./helpers.ts";

const CHAT = "chat_weights";
const A = "c_weights";
const PROP = "n_aaaaaaaaaaaa";
const ts = Date.UTC(2026, 10, 1, 10, 0, 0);

const call = (id: string, callId: string, name: string, args: Record<string, unknown>, t: number) => ({
  id, role: "assistant" as const, timestamp: t,
  content: [{ type: "toolCall" as const, id: callId, name, arguments: args }],
});
const result = (id: string, callId: string, name: string, t: number, details: unknown = null) => ({
  id, role: "toolResult" as const, toolCallId: callId, toolName: name, timestamp: t, isError: false, details,
  content: [{ type: "text" as const, text: "ok" }],
});
const answer = (questionText: string, correct: boolean, confidence: number, t: number) => ({
  kind: "quiz", tool: "quiz", questionText, dontKnow: false, answers: [{ label: "a", index: 1 }], correct, confidence, answeredAt: new Date(t).toISOString(),
});
/** problem + conclude: one concluded practice. */
const practice = (n: number, conclude: Record<string, unknown>, t: number) => [
  call(`mp${n}a`, `p${n}`, "problem", { statement: "s", mode: "composition", target: [PROP], modelSolution: "m" }, t),
  result(`mp${n}b`, `p${n}`, "problem", t + 1),
  call(`mp${n}c`, `c${n}`, "conclude", { verdict: "v", retest: false, ...conclude }, t + 2),
  result(`mp${n}d`, `c${n}`, "conclude", t + 3),
];

function chat(): ChatDetail {
  const record = ChatRecordSchema.parse({
    id: CHAT, title: "Weights", createdAt: "2026-11-01T10:00:00.000Z", updatedAt: "2026-11-01T11:00:00.000Z", kind: "teach",
    messages: [
      call("m1", "plan", "plan_init", {}, ts),
      result("m2", "plan", "plan_init", ts + 1, { ok: true, tree: { nodes: [{ id: "n1", title: "Weights node" }] } }),
      call("m3", "q100", "quiz", { nodeId: "n1", question: "Q1" }, ts + 2),
      result("m4", "q100", "quiz", ts + 3, answer("Safe question", true, 100, ts + 3)),
      call("m5", "q0", "quiz", { nodeId: "n1", question: "Q2" }, ts + 4),
      result("m6", "q0", "quiz", ts + 5, answer("Unsafe question", false, 0, ts + 5)),
      ...practice(1, { outcome: "surrendered", rung: "R5", missClass: "careless" }, ts + 10),
      ...practice(2, { outcome: "movedOn", rung: "R1" }, ts + 20),
      ...practice(3, { outcome: "solved", rung: "R0", missClass: "careless" }, ts + 30),
      ...practice(4, { outcome: "surrendered", rung: "R5", missClass: "structural" }, ts + 40),
    ],
  });
  return { ...record, turnInFlight: false, coverage: null } as ChatDetail;
}

function build() {
  const llm = llmByKind({ pick: pickBy([[/Weights node/, A]]) });
  const ctx = makeTestContext({ llm, lh: lhWith({ chat: { [CHAT]: chat() } }) });
  const subject = seedSubject(ctx.db, { name: "Weights" });
  seedConcept(ctx.db, { id: A, subjectId: subject, name: "Weights", description: "Test concept." });
  seedProposition(ctx.db, { id: PROP, conceptId: A });
  ctx.db.prepare("INSERT INTO lh_sessions (chat_id, title, kind, subject_id) VALUES (?, ?, 'teaching', ?)").run(CHAT, "Weights", subject);
  return ctx;
}

type Ev = { source: string; correct: number; weight: number; confidence: number | null; miss_class: string | null; response_ms: number | null; weight_multiplier: number | null; ref_json: string };
const byCall = (db: Db, toolCallId: string): Ev => {
  const rows = (db.prepare("SELECT * FROM evidence_events").all() as Ev[]).filter((e) => (JSON.parse(e.ref_json) as { toolCallId: string }).toolCallId === toolCallId);
  expect(rows).toHaveLength(1);
  return rows[0]!;
};

describe("session-ingest: weight multipliers (ADR 106)", () => {
  it("failed practice with missClass careless → weight 0.4, miss_class 'careless', weight_multiplier 0.4", async () => {
    const ctx = build();
    await runSessionIngest(ctx, CHAT);
    const e = byCall(ctx.db, "c1");
    expect(e).toMatchObject({ source: "lh_practice", correct: 0, miss_class: "careless", response_ms: null });
    expect(e.weight).toBeCloseTo(0.4, 10);
    expect(e.weight_multiplier).toBeCloseTo(0.4, 10);
  });

  it("failed practice structural → weight 1.2", async () => {
    const ctx = build();
    await runSessionIngest(ctx, CHAT);
    const e = byCall(ctx.db, "c4");
    expect(e).toMatchObject({ source: "lh_practice", correct: 0, miss_class: "structural" });
    expect(e.weight).toBeCloseTo(1.2, 10);
    expect(e.weight_multiplier).toBeCloseTo(1.2, 10);
  });

  it("failed practice without missClass → weight 1 and miss_class null", async () => {
    const ctx = build();
    await runSessionIngest(ctx, CHAT);
    const e = byCall(ctx.db, "c2");
    expect(e).toMatchObject({ source: "lh_practice", correct: 0, miss_class: null });
    expect(e.weight).toBeCloseTo(1, 10);
    expect(e.weight_multiplier).toBeCloseTo(1, 10);
  });

  it("correct practice with missClass present → ignores it: weight 1", async () => {
    const ctx = build();
    await runSessionIngest(ctx, CHAT);
    const e = byCall(ctx.db, "c3");
    expect(e).toMatchObject({ source: "lh_practice", correct: 1 });
    expect(e.weight).toBeCloseTo(1, 10);
    expect(e.weight_multiplier).toBeCloseTo(1, 10);
  });

  it("correct quiz with confidence 100 → weight 1.25 (and the confidence is still stored)", async () => {
    const ctx = build();
    await runSessionIngest(ctx, CHAT);
    const e = byCall(ctx.db, "q100");
    expect(e).toMatchObject({ source: "lh_quiz", correct: 1, confidence: 100, miss_class: null, response_ms: null });
    expect(e.weight).toBeCloseTo(1.25, 10);
    expect(e.weight_multiplier).toBeCloseTo(1.25, 10);
  });

  it("failed quiz with confidence 0 → weight 0.75", async () => {
    const ctx = build();
    await runSessionIngest(ctx, CHAT);
    const e = byCall(ctx.db, "q0");
    expect(e).toMatchObject({ source: "lh_quiz", correct: 0, confidence: 0 });
    expect(e.weight).toBeCloseTo(0.75, 10);
    expect(e.weight_multiplier).toBeCloseTo(0.75, 10);
  });

  it("ref_json is still only the identity {chatId, toolCallId}: missClass is not included", async () => {
    const ctx = build();
    await runSessionIngest(ctx, CHAT);
    expect(JSON.parse(byCall(ctx.db, "c1").ref_json)).toEqual({ chatId: CHAT, toolCallId: "c1" });
  });

  it("idempotent re-ingest: does not duplicate rows or change the weights (also with the cursor lost)", async () => {
    const ctx = build();
    const first = await runSessionIngest(ctx, CHAT);
    expect(first).toEqual({ events: 6, unassigned: 0 });
    const again = await runSessionIngest(ctx, CHAT);
    expect(again.events).toBe(0);
    ctx.db.prepare("UPDATE lh_sessions SET ingest_cursor_json = '{}' WHERE chat_id = ?").run(CHAT);
    await runSessionIngest(ctx, CHAT);
    expect(count(ctx.db, "SELECT count(*) FROM evidence_events")).toBe(6);
    expect(byCall(ctx.db, "c1").weight).toBeCloseTo(0.4, 10);
  });
});
