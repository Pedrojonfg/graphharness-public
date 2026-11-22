// session-ingest (ADR 102 points 3, 11) over the REAL golden LH sessions.
import { beforeEach, describe, expect, it } from "vitest";
import { makeTestContext, seedConcept, seedProposition, seedSubject } from "@graphharness/hub/testing";
import type { Db } from "@graphharness/db";
import { handlers, runSessionIngest } from "../../src/handlers/ingest.ts";
import {
  CALL, PRACTICE_CALL, PRACTICE_ID, PRACTICE_LAST_MSG, PRACTICE_TARGET, TEACH_ID, TEACH_LAST_MSG, count, haystack, judgeBy, lhWith, llmByKind, loadChat, loadChats, pickBy, teachSpans,
  type PickRule,
} from "./helpers.ts";

const A = "c_energy"; // energy balance of a gas: first law, expansion work, Carnot limit
const B = "c_state"; // state functions

const pickRules = (probeIsothermal: string | null = A): PickRule[] => [
  [/Which of these quantities is a state function/, B],
  [/fixed amount of ideal gas expands isothermally/, probeIsothermal],
  [/what does the first law say about the energy/, A],
  [/First law: ΔU = Q − W/, A],
  [/Work done by an expanding gas/, A],
  [/Carnot efficiency limit/, A],
];
const judgeRules = judgeBy([
  [/Q equals the change in U plus W/, "partial"],
  [/Do I subtract the work first/, "correct"],
  [/Because the Carnot cycle is reversible/, "partial"],
]);

function build(rules = pickRules()) {
  const llm = llmByKind({ pick: pickBy(rules), judge: judgeRules });
  const ctx = makeTestContext({
    llm,
    lh: lhWith({ chat: { [TEACH_ID]: loadChat(TEACH_ID), [PRACTICE_ID]: loadChat(PRACTICE_ID) } }),
  });
  const subject = seedSubject(ctx.db, { name: "Thermodynamics" });
  seedConcept(ctx.db, { id: A, subjectId: subject, name: "Energy balance", description: "Heat, work and internal energy of a gas, and the limits on turning heat into work." });
  seedConcept(ctx.db, { id: B, subjectId: subject, name: "State functions", description: "Quantities that depend only on the current state of a system." });
  for (const c of loadChats()) {
    ctx.db
      .prepare("INSERT INTO lh_sessions (chat_id, title, kind, subject_id) VALUES (?, ?, ?, ?)")
      .run(c.id, c.title, c.kind === "practice" ? "practice" : "teaching", subject);
  }
  return { ctx, llm, subject };
}

type Ev = { concept_id: string; at: string; source: string; correct: number; response_format: string; inferred: number; weight: number; confidence: number | null; ref_json: string };
const events = (db: Db): Ev[] => db.prepare("SELECT * FROM evidence_events ORDER BY at, id").all() as Ev[];
const byCall = (db: Db, callId: string): Ev => {
  const rows = events(db).filter((e) => (JSON.parse(e.ref_json) as { toolCallId: string }).toolCallId === callId);
  expect(rows).toHaveLength(1);
  return rows[0]!;
};

describe("session-ingest: golden teaching session (chat_k3p8w2ud_7e1b44a0)", () => {
  let t: ReturnType<typeof build>;
  beforeEach(() => {
    t = build();
  });

  it("generates exactly 7 events with the expected classification", async () => {
    const r = await runSessionIngest(t.ctx, TEACH_ID);
    expect(r).toEqual({ events: 7, unassigned: 0 });
    expect(count(t.ctx.db, "SELECT count(*) FROM evidence_events")).toBe(7);
    expect(count(t.ctx.db, "SELECT count(*) FROM evidence_events WHERE source = 'lh_probe'")).toBe(2);
    expect(count(t.ctx.db, "SELECT count(*) FROM evidence_events WHERE source = 'lh_quiz'")).toBe(2);
    expect(count(t.ctx.db, "SELECT count(*) FROM evidence_events WHERE source = 'lh_recall'")).toBe(3);
  });

  it("lh_probe: correct, confidence stored, mcq, concept by LLM, at = answeredAt", async () => {
    await runSessionIngest(t.ctx, TEACH_ID);
    const p1 = byCall(t.ctx.db, CALL.probe1);
    // ADR 106: confidence 100 → m = 0.75 + 0.5·100/100 = 1.25 → weight = 1 × 1.25.
    expect(p1).toMatchObject({ source: "lh_probe", correct: 1, confidence: 100, response_format: "mcq", inferred: 0, weight: 1.25, concept_id: A, at: "2026-09-21T14:04:15.000Z" });
    expect(JSON.parse(p1.ref_json)).toEqual({ chatId: TEACH_ID, toolCallId: CALL.probe1 });
    const p2 = byCall(t.ctx.db, CALL.probe2);
    expect(p2).toMatchObject({ source: "lh_probe", correct: 1, confidence: 70, concept_id: B, at: "2026-09-21T14:07:15.000Z" });
  });

  it("lh_recall (recall and explain): inferred=1, open, and the judge's verdict partial → incorrect", async () => {
    await runSessionIngest(t.ctx, TEACH_ID);
    const recall = byCall(t.ctx.db, CALL.recall);
    expect(recall).toMatchObject({ source: "lh_recall", correct: 0, inferred: 1, response_format: "open", weight: 1, concept_id: A, at: "2026-09-21T14:11:00.000Z" });
    const exFirstLaw = byCall(t.ctx.db, CALL.explainFirstLaw);
    expect(exFirstLaw).toMatchObject({ source: "lh_recall", correct: 1, inferred: 1, response_format: "open", at: "2026-09-21T14:32:00.000Z" });
    const exCarnot = byCall(t.ctx.db, CALL.explainCarnot);
    expect(exCarnot).toMatchObject({ source: "lh_recall", correct: 0, inferred: 1, at: "2026-09-21T14:35:00.000Z" });
    expect(t.llm.kinds.filter((k) => k === "judge")).toHaveLength(3);
  });

  it("the judge receives the question, the committed answer, the learner's answer and the teacher's next message", async () => {
    await runSessionIngest(t.ctx, TEACH_ID);
    const judgeCalls = t.llm.calls.filter((c) => /judge|grade/i.test(c.task));
    const recallCall = judgeCalls.find((c) => haystack(c).includes("Q equals the change in U plus W"))!;
    const h = haystack(recallCall);
    expect(h).toContain("what does the first law say about the energy of a closed system");
    expect(h).toContain("Setup."); // committed
    expect(h).toContain("Recall graded against the committed answer"); // the teacher's next message
    expect(recallCall.tier).toBe("cheap");
  });

  it("lh_quiz with nodeId: dontKnow → incorrect without confidence; a confidence of 0 is kept; no events for the dismissed one or for an invalid nodeId", async () => {
    await runSessionIngest(t.ctx, TEACH_ID);
    expect(byCall(t.ctx.db, CALL.quizFirstLaw)).toMatchObject({ source: "lh_quiz", correct: 0, response_format: "mcq", inferred: 0, confidence: null, concept_id: A });
    expect(byCall(t.ctx.db, CALL.quizPvWork)).toMatchObject({ source: "lh_quiz", correct: 0, confidence: 0, concept_id: A });
    const dismissed = events(t.ctx.db).filter((e) => e.ref_json.includes(CALL.quizDismissed));
    expect(dismissed).toEqual([]);
    expect(count(t.ctx.db, "SELECT count(*) FROM unassigned_questions")).toBe(0); // a dismissal is not "without concept"
  });

  it("recomputes concept_state: B with one correct mcq = 0.5 + 0.15 (quick)", async () => {
    await runSessionIngest(t.ctx, TEACH_ID);
    const s = t.ctx.db.prepare("SELECT probability, decay_class, source, updated_at FROM concept_state WHERE concept_id = ?").get(B) as Record<string, any>;
    // ADR 106: probe2 with confidence 70 → m = 0.75 + 0.5·70/100 = 1.1 → P = 0.5 + 0.15 × 1.1 = 0.665.
    expect(s.probability).toBeCloseTo(0.665, 10);
    expect(s.decay_class).toBe("quick");
    expect(s.source).toBe("grade");
    expect(s.updated_at).toBe("2026-09-21T14:07:15.000Z");
    expect(count(t.ctx.db, "SELECT count(*) FROM concept_state")).toBe(2);
  });

  it("is idempotent: repeating does not duplicate; advances the ingest_cursor to the last message", async () => {
    await runSessionIngest(t.ctx, TEACH_ID);
    const cursor = (t.ctx.db.prepare("SELECT ingest_cursor_json FROM lh_sessions WHERE chat_id = ?").pluck().get(TEACH_ID) as string);
    expect(cursor).toContain(TEACH_LAST_MSG);
    const again = await runSessionIngest(t.ctx, TEACH_ID);
    expect(again.events).toBe(0);
    expect(count(t.ctx.db, "SELECT count(*) FROM evidence_events")).toBe(7);
    // Even with the cursor lost, UNIQUE(source, ref_json) prevents duplicates.
    t.ctx.db.prepare("UPDATE lh_sessions SET ingest_cursor_json = '{}' WHERE chat_id = ?").run(TEACH_ID);
    await runSessionIngest(t.ctx, TEACH_ID);
    expect(count(t.ctx.db, "SELECT count(*) FROM evidence_events")).toBe(7);
  });

  it("the 'session-ingest' handler ingests the chat from the payload", async () => {
    await handlers["session-ingest"]!(t.ctx, { id: "j", type: "session-ingest", payload: { chatId: TEACH_ID }, status: "running", attempts: 1, runAfter: "", lastError: null });
    expect(count(t.ctx.db, "SELECT count(*) FROM evidence_events")).toBe(7);
  });
});

describe("session-ingest: question without a concept", () => {
  it("if the LLM returns null → unassigned_questions and NO evidence", async () => {
    const { ctx } = build(pickRules(null));
    const r = await runSessionIngest(ctx, TEACH_ID);
    expect(r).toEqual({ events: 6, unassigned: 1 });
    expect(count(ctx.db, "SELECT count(*) FROM evidence_events")).toBe(6);
    const u = ctx.db.prepare("SELECT chat_id, tool_call_id, source, payload_json FROM unassigned_questions").all() as Record<string, string>[];
    expect(u).toHaveLength(1);
    expect(u[0]).toMatchObject({ chat_id: TEACH_ID, tool_call_id: CALL.probe1, source: "lh_probe" });
    const payload = JSON.parse(u[0]!.payload_json) as Record<string, unknown>;
    expect(payload.correct).toBe(true);
    expect(JSON.stringify(payload)).toContain("2026-09-21T14:04:15.000Z");
    // Re-running does not duplicate the row.
    await runSessionIngest(ctx, TEACH_ID);
    expect(count(ctx.db, "SELECT count(*) FROM unassigned_questions")).toBe(1);
  });
});

describe("session-ingest: plan_node_map", () => {
  /** Seeds propositions whose provenance falls within the "first-law" node's span. */
  function seedSpan(db: Db, perConcept: Record<string, number>): void {
    const span = teachSpans()["first-law"]!;
    expect(span.messageIds.length).toBe(20);
    let k = 1;
    for (const [conceptId, n] of Object.entries(perConcept))
      for (let i = 0; i < n; i++) {
        seedProposition(db, { id: `n_span${conceptId.slice(2)}${i}`.padEnd(14, "0").slice(0, 14), conceptId, provenance: [{ chatId: TEACH_ID, messageId: span.messageIds[k++ % 20]! }] });
      }
  }
  const mapRow = (db: Db, node: string) =>
    db.prepare("SELECT concept_id, method FROM plan_node_map WHERE chat_id = ? AND plan_node_id = ?").get(TEACH_ID, node) as { concept_id: string | null; method: string } | undefined;

  it("≥ 60 % of the span's propositions in one concept → method 'propositions' (no LLM for that node)", async () => {
    const { ctx, llm } = build();
    seedSpan(ctx.db, { [A]: 3, [B]: 2 }); // 3/5 = 60 %
    await runSessionIngest(ctx, TEACH_ID);
    expect(mapRow(ctx.db, "first-law")).toEqual({ concept_id: A, method: "propositions" });
    expect(byCall(ctx.db, CALL.quizFirstLaw).concept_id).toBe(A);
    expect(byCall(ctx.db, CALL.explainFirstLaw).concept_id).toBe(A);
    // The other nodes go through the LLM.
    expect(mapRow(ctx.db, "pv-work")).toEqual({ concept_id: A, method: "llm" });
    expect(mapRow(ctx.db, "carnot")).toEqual({ concept_id: A, method: "llm" });
    expect(llm.calls.some((c) => haystack(c).includes("First law: ΔU = Q − W"))).toBe(false);
  });

  it("< 60 % (50 %) → method 'llm'", async () => {
    const { ctx } = build();
    seedSpan(ctx.db, { [A]: 2, [B]: 2 });
    await runSessionIngest(ctx, TEACH_ID);
    expect(mapRow(ctx.db, "first-law")).toEqual({ concept_id: A, method: "llm" });
  });

  it("if the LLM picks no concept for a node, its questions go to unassigned_questions", async () => {
    const { ctx } = build([[/Work done by an expanding gas/, null], ...pickRules()]);
    const r = await runSessionIngest(ctx, TEACH_ID);
    expect(r).toEqual({ events: 6, unassigned: 1 });
    expect(count(ctx.db, "SELECT count(*) FROM unassigned_questions WHERE tool_call_id = ?", CALL.quizPvWork)).toBe(1);
  });
});

describe("session-ingest: golden practice session (chat_k3p9c5zr_2d80f6b3)", () => {
  function practiceCtx() {
    const t = build();
    const target = seedConcept(t.ctx.db, { id: "c_target", subjectId: t.subject, name: "First law of thermodynamics" });
    seedProposition(t.ctx.db, { id: PRACTICE_TARGET.solved, conceptId: target });
    const other = seedConcept(t.ctx.db, { id: "c_other", subjectId: t.subject });
    seedProposition(t.ctx.db, { id: PRACTICE_TARGET.dismissed, conceptId: other }); // target of the dismissed problem
    return { ...t, target, other };
  }

  it("conclude 'solved' with rung null → one correct open lh_practice for the concept of the solved problem's target; dismissed is ignored", async () => {
    const { ctx, target, other } = practiceCtx();
    const r = await runSessionIngest(ctx, PRACTICE_ID);
    expect(r).toEqual({ events: 1, unassigned: 0 });
    const rows = events(ctx.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: "lh_practice", concept_id: target, correct: 1, response_format: "open", inferred: 0, weight: 1, at: "2026-09-22T16:15:15.000Z",
    });
    const ref = JSON.parse(rows[0]!.ref_json) as { chatId: string; toolCallId: string };
    expect(ref.chatId).toBe(PRACTICE_ID);
    expect([PRACTICE_CALL.solvedConclude, PRACTICE_CALL.solvedProblem]).toContain(ref.toolCallId);
    expect(count(ctx.db, "SELECT count(*) FROM evidence_events WHERE concept_id = ?", other)).toBe(0);
    expect(count(ctx.db, "SELECT count(*) FROM unassigned_questions")).toBe(0);
  });

  it("state: 0.5 + 0.15 = 0.65 with decay 'reasoned' (open); idempotent and cursor at the last message", async () => {
    const { ctx, target, llm } = practiceCtx();
    await runSessionIngest(ctx, PRACTICE_ID);
    const s = ctx.db.prepare("SELECT probability, decay_class FROM concept_state WHERE concept_id = ?").get(target) as { probability: number; decay_class: string };
    expect(s.probability).toBeCloseTo(0.65, 10);
    expect(s.decay_class).toBe("reasoned");
    expect(llm.kinds).toEqual([]); // practice does not use the LLM: the concept comes from problem.target
    expect(ctx.db.prepare("SELECT ingest_cursor_json FROM lh_sessions WHERE chat_id = ?").pluck().get(PRACTICE_ID)).toContain(PRACTICE_LAST_MSG);
    const again = await runSessionIngest(ctx, PRACTICE_ID);
    expect(again.events).toBe(0);
    expect(count(ctx.db, "SELECT count(*) FROM evidence_events")).toBe(1);
  });

  it("a practice whose target has no assigned concept stays in unassigned_questions", async () => {
    const t = build();
    const r = await runSessionIngest(t.ctx, PRACTICE_ID);
    expect(r).toEqual({ events: 0, unassigned: 1 });
    expect(count(t.ctx.db, "SELECT count(*) FROM unassigned_questions WHERE chat_id = ? AND source = 'lh_practice'", PRACTICE_ID)).toBe(1);
  });
});
