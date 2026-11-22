// Tests for the session extraction rules (ADR 105 / evidence ingestion) on the two synthetic session
// records in fixtures/synthetic/chats (see fixtures/README.md). Expected values were read by hand from
// those JSON files (message index in parentheses).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractSessionItems, type SessionExtraction } from "./extract.ts";
import { ChatRecordSchema, type ChatRecord } from "./types.ts";

function fixture(name: string): ChatRecord {
  const raw: unknown = JSON.parse(readFileSync(new URL(`../fixtures/synthetic/chats/${name}.json`, import.meta.url), "utf8"));
  return ChatRecordSchema.parse(raw);
}

const TEACH = "chat_k3p8w2ud_7e1b44a0";
const PRACTICE = "chat_k3p9c5zr_2d80f6b3";

describe("extractSessionItems — synthetic teaching session (probe + teach)", () => {
  const record = fixture(TEACH);
  let all: SessionExtraction | undefined;
  const run = (): SessionExtraction => (all ??= extractSessionItems(record));

  it("returns the 8 answered questions in transcript order and ignores ask_user_question and the quiz with isError", () => {
    const { questions } = run();
    expect(questions.map((q) => [q.tool, q.toolCallId])).toEqual([
      ["probe", "call_th_probe1"],
      ["probe", "call_th_probe2"],
      ["recall", "call_th_recall1"],
      ["quiz", "call_th_quiz_dk"],
      ["quiz", "call_th_quiz_wrong"],
      ["quiz", "call_th_quiz_dismissed"],
      ["explain", "call_th_explain_fl"],
      ["explain", "call_th_explain_carnot"],
    ]);
    // (16/17) quiz with the unknown nodeId "ghost-node" before plan_init → isError: it does not appear.
    expect(questions.some((q) => q.toolCallId === "call_th_quiz_bad")).toBe(false);
    // The two ask_user_question calls (6, 24) are not evidence either.
    expect(questions.some((q) => q.toolCallId === "call_th_ask1" || q.toolCallId === "call_th_ask2")).toBe(false);
    expect(run().anomalies).toEqual([]);
  });

  it("correct probe with confidence 100 (3)", () => {
    const q = run().questions[0]!;
    expect(q).toEqual({
      toolCallId: "call_th_probe1",
      tool: "probe",
      nodeId: null,
      questionText: "A fixed amount of ideal gas expands isothermally. What happens to its internal energy?",
      correct: true,
      dontKnow: false,
      confidence: 100,
      responseFormat: "mcq",
      committed: null,
      text: null,
      thinking: null,
      readingThinking: null,
      answeredAt: "2026-09-21T14:04:15.000Z",
      messageId: "msg_th_003",
      nextTeacherText: expect.stringMatching(/^Correct, and your confidence matches\.\n\n1\. \*\*Baseline set\*\*/),
      dismissed: false,
    });
  });

  it("probe with the student's thinking (7) and the next teacher text after the parallel question (9)", () => {
    const q = run().questions[1]!;
    expect(q.correct).toBe(true);
    expect(q.confidence).toBe(70);
    expect(q.thinking).toBe("U only depends on the state, so it has to be that one.");
    expect(q.messageId).toBe("msg_th_007");
    expect(q.nextTeacherText).toMatch(/^Both questions resolved in the same turn\./);
  });

  it("recall (12): free answer with committed and text, correct null, open, no nodeId; nextTeacherText from message 13", () => {
    const q = run().questions[2]!;
    expect(q.tool).toBe("recall");
    expect(q.nodeId).toBeNull();
    expect(q.correct).toBeNull();
    expect(q.confidence).toBeNull();
    expect(q.responseFormat).toBe("open");
    expect(q.dontKnow).toBe(false);
    expect(q.text).toBe("The heat that goes into the system is either stored as internal energy or leaves again as work, so Q equals the change in U plus W.");
    expect(q.committed).toMatch(/^\*\*Setup\.\*\* Take a closed system that exchanges heat Q and work W/);
    expect(q.committed).toContain("\\(\\Delta U = Q - W\\)");
    expect(q.questionText).toBe(
      "In your own words: what does the first law say about the energy of a closed system, and why must the sign convention for work be stated explicitly?",
    );
    expect(q.answeredAt).toBe("2026-09-21T14:11:00.000Z");
    expect(q.messageId).toBe("msg_th_012");
    expect(q.nextTeacherText).toMatch(/^Recall graded against the committed answer:\n\n\*\*Held:\*\* the skeleton/);
    // Only text parts: the model's thinking part in that message does not get in.
    expect(q.nextTeacherText).toContain("**Missing:** the sign convention for work and the closed-system condition.");
    expect(q.nextTeacherText).not.toContain("Compare the answer");
  });

  it("quiz with dontKnow (21): plan nodeId, correct false, no confidence, thinking", () => {
    const q = run().questions[3]!;
    expect(q).toMatchObject({
      tool: "quiz",
      nodeId: "first-law",
      dontKnow: true,
      correct: false,
      confidence: null,
      responseFormat: "mcq",
      thinking: "I'll try the \"I don't know\" option here.",
      answeredAt: "2026-09-21T14:17:45.000Z",
      messageId: "msg_th_021",
      dismissed: false,
    });
  });

  it("failed quiz with confidence 0 and readingThinking (28)", () => {
    const q = run().questions[4]!;
    expect(q).toMatchObject({
      nodeId: "pv-work",
      correct: false,
      dontKnow: false,
      confidence: 0,
      thinking: "I'm answering wrong on purpose to see the feedback.",
      readingThinking: "Reading the explanation: kPa times litres is already joules.",
    });
  });

  it("dismissed quiz (32): flagged dismissed, no correct; the next message is the student's → nextTeacherText null", () => {
    const q = run().questions[5]!;
    expect(q).toMatchObject({
      tool: "quiz",
      nodeId: "isothermal",
      dismissed: true,
      correct: null,
      confidence: null,
      dontKnow: false,
      answeredAt: "2026-09-21T14:26:00.000Z",
      messageId: "msg_th_032",
      nextTeacherText: null,
    });
    expect(q.questionText).toMatch(/^Which statement about an isothermal expansion/);
  });

  it("explain with plan nodeId (40, 44)", () => {
    const [a, b] = run().questions.slice(6);
    expect(a).toMatchObject({ tool: "explain", nodeId: "first-law", correct: null, responseFormat: "open", confidence: null });
    expect(a!.text).toMatch(/^Do I subtract the work first\?/);
    expect(a!.committed).toMatch(/^\*\*What you would do:\*\* subtract the work done by the gas/);
    expect(a!.nextTeacherText).toMatch(/^Verdict: \*\*correct\.\*\*/);
    expect(b).toMatchObject({
      tool: "explain",
      nodeId: "carnot",
      readingThinking: "While reading: the reversible cycle is the limiting case.",
      thinking: null,
      messageId: "msg_th_044",
    });
    expect(b!.nextTeacherText).toMatch(/^Graded strictly against the commitment: \*\*partial\*\*/);
  });

  it("plan: nodes of the LAST successful plan_init (35), 8 nodes", () => {
    const { plan } = run();
    expect(plan).not.toBeNull();
    expect(plan!.nodes).toHaveLength(8);
    expect(plan!.nodes.map((n) => n.id)).toEqual([
      "state-fn", "u-ideal", "pv-work", "first-law", "isothermal", "heat-engine", "carnot", "entropy",
    ]);
    expect(plan!.nodes[3]).toEqual({ id: "first-law", title: "First law: ΔU = Q − W" });
  });

  it("plan: spans per nodeId between the first and the last clean tagged call (the quiz with isError opens no span)", () => {
    const { spans } = run().plan!;
    expect(Object.keys(spans).sort()).toEqual(["carnot", "first-law", "isothermal", "pv-work"]);
    expect(spans["ghost-node"]).toBeUndefined();
    // first-law: quiz (20) … explain (39); the failed quiz at (16) is left out.
    expect(spans["first-law"]!.firstMessageId).toBe("msg_th_020");
    expect(spans["first-law"]!.lastMessageId).toBe("msg_th_039");
    expect(spans["first-law"]!.messageIds).toHaveLength(20);
    expect(spans["first-law"]!.messageIds[0]).toBe("msg_th_020");
    expect(spans["first-law"]!.messageIds.at(-1)).toBe("msg_th_039");
    expect(spans["first-law"]!.messageIds).toContain("msg_th_021");
    expect(spans["first-law"]!.messageIds).not.toContain("msg_th_016");
    // A single call → a one-message span (including the dismissed quiz of "isothermal").
    expect(spans["pv-work"]).toEqual({
      firstMessageId: "msg_th_027",
      lastMessageId: "msg_th_027",
      messageIds: ["msg_th_027"],
    });
    expect(spans.isothermal!.messageIds).toEqual(["msg_th_031"]);
    expect(spans.carnot!.messageIds).toEqual(["msg_th_043"]);
  });

  it("no practices; lastMessageId = last message; cursorFound true without a cursor", () => {
    expect(run().practices).toEqual([]);
    expect(run().lastMessageId).toBe("msg_th_045");
    expect(run().cursorFound).toBe(true);
  });

  it("afterMessageId trims: after the result of the first plan_init (19) 5 questions remain; the plan is still the one of the whole record", () => {
    const cut = extractSessionItems(record, { afterMessageId: "msg_th_019" });
    expect(cut.questions.map((q) => q.toolCallId)).toEqual([
      "call_th_quiz_dk",
      "call_th_quiz_wrong",
      "call_th_quiz_dismissed",
      "call_th_explain_fl",
      "call_th_explain_carnot",
    ]);
    expect(cut.cursorFound).toBe(true);
    expect(cut.lastMessageId).toBe("msg_th_045");
    expect(cut.plan!.nodes).toHaveLength(8);
    expect(Object.keys(cut.plan!.spans).sort()).toEqual(["carnot", "first-law", "isothermal", "pv-work"]);
  });

  it("afterMessageId = the answer's own message: that answer no longer counts", () => {
    const cut = extractSessionItems(record, { afterMessageId: "msg_th_012" });
    expect(cut.questions[0]!.toolCallId).toBe("call_th_quiz_dk");
    expect(cut.questions).toHaveLength(5);
  });

  it("afterMessageId = lastMessageId: nothing new and the cursor does not move", () => {
    const cut = extractSessionItems(record, { afterMessageId: "msg_th_045" });
    expect(cut.questions).toEqual([]);
    expect(cut.practices).toEqual([]);
    expect(cut.lastMessageId).toBe("msg_th_045");
    expect(cut.cursorFound).toBe(true);
  });

  it("unknown afterMessageId: cursorFound false and everything is extracted (writes are idempotent)", () => {
    const cut = extractSessionItems(record, { afterMessageId: "msg_does_not_exist" });
    expect(cut.cursorFound).toBe(false);
    expect(cut.questions).toHaveLength(8);
  });
});

describe("extractSessionItems — synthetic practice session (problem/conclude)", () => {
  const record = fixture(PRACTICE);

  it("problem + conclude 'solved' with target and rung null → open / correct", () => {
    const out = extractSessionItems(record);
    expect(out.questions).toEqual([]);
    expect(out.plan).toBeNull();
    expect(out.practices).toHaveLength(2);
    expect(out.practices[0]).toEqual({
      problemCallId: "call_pr_problem1",
      concludeCallId: "call_pr_conclude1",
      target: ["n_b16fd5621355"],
      mode: "recall",
      outcome: "solved",
      rung: null,
      missClass: null,
      verdict: expect.stringMatching(/^Correct on both counts: internal energy is unchanged/),
      at: "2026-09-22T16:15:15.000Z",
      messageId: "msg_pr_007",
      correct: true,
      responseFormat: "open",
      dismissed: false,
    });
  });

  it("the second, dismissed problem → synthetic 'dismissed' conclude: flagged and ignored (correct null)", () => {
    const p = extractSessionItems(record).practices[1]!;
    expect(p).toEqual({
      problemCallId: "call_pr_problem2",
      concludeCallId: "call_conc_call_pr_problem2",
      target: ["n_c95d76921e15"],
      mode: "recall",
      outcome: "dismissed",
      rung: null,
      missClass: null,
      verdict: null,
      at: "2026-09-22T16:20:30.000Z",
      messageId: "msg_pr_014",
      correct: null,
      responseFormat: "open",
      dismissed: true,
    });
  });

  it("lastMessageId and anomalies", () => {
    const out = extractSessionItems(record);
    expect(out.lastMessageId).toBe("msg_pr_015");
    expect(out.anomalies).toEqual([]);
  });

  it("cursor between the problem and its conclude: the practice counts (the problem is looked up in the whole record)", () => {
    const cut = extractSessionItems(record, { afterMessageId: "msg_pr_004" });
    expect(cut.practices.map((p) => p.concludeCallId)).toEqual([
      "call_pr_conclude1",
      "call_conc_call_pr_problem2",
    ]);
  });

  it("cursor after the first conclude: only the dismissal is left", () => {
    const cut = extractSessionItems(record, { afterMessageId: "msg_pr_007" });
    expect(cut.practices.map((p) => p.outcome)).toEqual(["dismissed"]);
  });
});

describe("extractSessionItems — evidence rules on minimal records", () => {
  // Record built with the exact shape of the LH wire format (same keys as the synthetic fixtures) to cover
  // branches the fixtures do not have: rung R2, movedOn, problem without target, malformed toolResult.
  const ts = Date.UTC(2026, 10, 1, 10, 0, 0);
  const assistantCall = (id: string, callId: string, name: string, args: Record<string, unknown>, t: number) => ({
    id, role: "assistant" as const, timestamp: t,
    content: [{ type: "toolCall" as const, id: callId, name, arguments: args }],
  });
  const ack = (id: string, callId: string, name: string, t: number, details: unknown = null, isError = false) => ({
    id, role: "toolResult" as const, toolCallId: callId, toolName: name, timestamp: t, isError, details,
    content: [{ type: "text" as const, text: "ok" }],
  });
  const record: ChatRecord = ChatRecordSchema.parse({
    id: "chat_x", title: "x", createdAt: "2026-11-01T10:00:00.000Z", updatedAt: "2026-11-01T11:00:00.000Z", kind: "practice",
    messages: [
      assistantCall("m1", "p1", "problem", { statement: "s", mode: "composition", target: ["n_a", "n_b"], modelSolution: "m" }, ts),
      ack("m2", "p1", "problem", ts + 1),
      assistantCall("m3", "c1", "conclude", { outcome: "solvedWithHints", verdict: "v", rung: "R2", missClass: "execution", retest: false }, ts + 2),
      ack("m4", "c1", "conclude", ts + 3),
      assistantCall("m5", "p2", "problem", { statement: "s", mode: "discrimination", modelSolution: "m" }, ts + 4),
      ack("m6", "p2", "problem", ts + 5),
      assistantCall("m7", "c2", "conclude", { outcome: "movedOn", verdict: "v", rung: "R1", missClass: "cue", retest: true }, ts + 6),
      ack("m8", "c2", "conclude", ts + 7),
      assistantCall("m9", "p3", "problem", { statement: "s", mode: "recall", modelSolution: "m", target: ["n_c"] }, ts + 8),
      ack("m10", "p3", "problem", ts + 9),
      assistantCall("m11", "c3", "conclude", { outcome: "surrendered", verdict: "v", rung: "R5", missClass: "structural", retest: true }, ts + 10),
      ack("m12", "c3", "conclude", ts + 11, null, true), // rejected conclude: it concludes nothing
      assistantCall("m13", "c4", "conclude", { outcome: "surrendered", verdict: "v2", rung: "R5", missClass: "structural", retest: true }, ts + 12),
      ack("m14", "c4", "conclude", ts + 13),
      assistantCall("m15", "q1", "probe", { question: "?" }, ts + 14),
      ack("m16", "q1", "probe", ts + 15, { kind: "quiz", nope: true }), // malformed details
    ],
  });

  it("solvedWithHints with R2 → correct and mcq; movedOn with R1 → incorrect and open; no target → []", () => {
    const [a, b] = extractSessionItems(record).practices;
    expect(a).toMatchObject({ problemCallId: "p1", concludeCallId: "c1", target: ["n_a", "n_b"], mode: "composition", rung: "R2", missClass: "execution", correct: true, responseFormat: "mcq", verdict: "v" });
    expect(b).toMatchObject({ problemCallId: "p2", concludeCallId: "c2", target: [], correct: false, responseFormat: "open", rung: "R1", missClass: "cue" });
  });

  it("a conclude with isError does not count; the next clean conclude pairs with the same problem", () => {
    const practices = extractSessionItems(record).practices;
    expect(practices).toHaveLength(3);
    expect(practices[2]).toMatchObject({ problemCallId: "p3", concludeCallId: "c4", outcome: "surrendered", correct: false, responseFormat: "mcq", verdict: "v2", messageId: "m14", at: new Date(ts + 13).toISOString() });
  });

  it("a question toolResult that does not match QuestionAnswerData is skipped and reported as an anomaly", () => {
    const out = extractSessionItems(record);
    expect(out.questions).toEqual([]);
    expect(out.anomalies).toHaveLength(1);
    expect(out.anomalies[0]).toMatchObject({ messageId: "m16", toolCallId: "q1" });
  });

  it("empty record: lastMessageId = the received cursor (or null)", () => {
    const empty = ChatRecordSchema.parse({ id: "c", title: "t", createdAt: "x", updatedAt: "x", messages: [] });
    expect(extractSessionItems(empty).lastMessageId).toBeNull();
    expect(extractSessionItems(empty, { afterMessageId: "m9" }).lastMessageId).toBe("m9");
  });

  // Invariant: the evidence of `hub_exercise` is already recorded by the Hub when it grades the attempt
  // (source hub_exercise); if ingestion also counted it as a question it would be duplicated. The `details`
  // deliberately imitate a valid QuestionAnswerData (kind quiz, correct) so that dispatching on
  // `details.kind`/`details.tool` instead of on toolName fails here.
  it("always ignores hub_exercise calls and toolResults: only the normal question comes out, no anomalies", () => {
    const qa = (tool: string, questionText: string, t: number) => ({
      kind: "quiz", tool, questionText, dontKnow: false, answers: [{ label: "A", index: 0 }], confidence: 80, correct: true, answeredAt: new Date(t).toISOString(),
    });
    const withExercise = ChatRecordSchema.parse({
      id: "chat_hx", title: "x", createdAt: "2026-11-01T10:00:00.000Z", updatedAt: "2026-11-01T11:00:00.000Z", kind: "practice",
      messages: [
        assistantCall("h1", "hx1", "hub_exercise", { conceptId: "c_1" }, ts),
        ack("h2", "hx1", "hub_exercise", ts + 1, qa("hub_exercise", "Differentiate x^3", ts + 1)),
        assistantCall("h3", "q1", "quiz", { question: "What is the first law?" }, ts + 2),
        ack("h4", "q1", "quiz", ts + 3, qa("quiz", "What is the first law?", ts + 3)),
        assistantCall("h5", "hx2", "hub_exercise", { instanceId: "i_1", userInput: { result: "3*x**2" } }, ts + 4),
        ack("h6", "hx2", "hub_exercise", ts + 5, { correct: true, outcome: "correct", finished: true }),
      ],
    });
    const out = extractSessionItems(withExercise);
    expect(out.questions.map((q) => [q.tool, q.toolCallId])).toEqual([["quiz", "q1"]]);
    expect(out.practices).toEqual([]);
    expect(out.anomalies).toEqual([]);
  });
});
