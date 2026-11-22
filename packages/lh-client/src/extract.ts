// PURE extraction (no LLM, no I/O) of what a LearnHarness session contributes as evidence (ADR 105;
// weights in ADR 106).
//
// Where each thing lives in LearnHarness's native chat record (as modelled by the types in types.ts):
// - The QUESTION is in the `arguments` of the call (a `toolCall` inside an `assistant` message):
//   quiz/explain carry `nodeId` (a plan node id); probe/recall do not.
// - The student's ANSWER is the `details` of the `toolResult` message with the same `toolCallId`
//   (`QuestionAnswerData`, written by LearnHarness when the student answers). The `content` of that
//   toolResult is only the compact version for the model: it is not read.
//   `details.tool` is missing in old records and in dismissals: the tool comes from `toolResult.toolName`.
// - A rejected call (e.g. a quiz with an invalid `nodeId`) has `toolResult.isError = true`: it is ignored.
// - Practice: `outcome`/`rung`/`missClass`/`verdict` are in the ARGUMENTS of `conclude`; its
//   toolResult carries `details: null` (except the synthetic conclude of a dismissal, which carries
//   `{outcome:"dismissed", problemCallId}`). `conclude` does not name its problem: it is paired with the
//   last clean (non-isError) `problem` before it that is still unconcluded, like LearnHarness's own
//   active-problem lookup.
// - Plan: `details.tree.nodes[{id,title}]` of the `plan_init` toolResult with `details.ok === true`.
import {
  ConcludeArgsSchema,
  PlanInitDetailsSchema,
  ProblemArgsSchema,
  QuestionAnswerDataSchema,
  QuestionCallArgsSchema,
} from "./types.ts";
import type { ChatRecord, ConcludeOutcome, LhMessage, MissClass, PlanNode, ProblemMode, Rung } from "./types.ts";

/** Question tools that yield evidence (ADR 105). `ask_user_question` does not count. */
export type QuestionTool = "quiz" | "probe" | "explain" | "recall";

/** A question answered (or dismissed) by the student. */
export interface AnsweredQuestion {
  toolCallId: string;
  tool: QuestionTool;
  /** `nodeId` from the arguments (quiz/explain); null for probe/recall. */
  nodeId: string | null;
  /** `details.questionText`. */
  questionText: string;
  /** quiz/probe: `details.correct` (dontKnow → false). explain/recall: null (decided by the judge, ADR 105). Dismissed: null. */
  correct: boolean | null;
  dontKnow: boolean;
  /** 0–100; null if there is none (dontKnow, explain/recall, dismissal). */
  confidence: number | null;
  /** "mcq" for quiz/probe, "open" for explain/recall (ADR 105). */
  responseFormat: "mcq" | "open";
  /** explain/recall: the answer the model committed to before asking. */
  committed: string | null;
  /** explain/recall: the student's written answer. */
  text: string | null;
  /** The student's reasoning about the question (`thinking ?? note`). */
  thinking: string | null;
  /** What the student thought while reading the explanation (`readingThinking`); a separate channel in LearnHarness. */
  readingThinking: string | null;
  /** ISO, `details.answeredAt`. */
  answeredAt: string;
  /** id of the toolResult message with the answer. */
  messageId: string;
  /**
   * Text (`text` parts, joined with "\n\n") of the first assistant message with text after the
   * answer, provided no `user` message comes first; otherwise null. It is the teacher's assessment
   * that the judge receives (ADR 105).
   */
  nextTeacherText: string | null;
  /** The student dismissed it (`details.dismissed`): returned flagged but it yields NO evidence. */
  dismissed: boolean;
}

/** A concluded practice problem (`problem` + `conclude`). */
export interface ConcludedPractice {
  problemCallId: string;
  concludeCallId: string;
  /** proposition ids from `problem.target` ([] if the problem was unlabelled). */
  target: string[];
  mode: ProblemMode;
  outcome: ConcludeOutcome;
  rung: Rung | null;
  missClass: MissClass | null;
  verdict: string | null;
  /** ISO of the conclude toolResult's `timestamp`. */
  at: string;
  /** id of the conclude toolResult. */
  messageId: string;
  /** solved/solvedWithHints → true; movedOn/surrendered → false; dismissed → null (ADR 105). */
  correct: boolean | null;
  /** "open" if rung ∈ {null, R0, R1}; otherwise "mcq" (ADR 105). */
  responseFormat: "open" | "mcq";
  /** outcome === "dismissed": returned flagged but ignored. */
  dismissed: boolean;
}

/** Span of a plan node (ADR 105, `propositions` mapping method). */
export interface PlanNodeSpan {
  /** Assistant message with the first clean call (quiz/explain) tagged with the node. */
  firstMessageId: string;
  /** Assistant message with the last clean call tagged with the node. */
  lastMessageId: string;
  /** All message ids in the span, in order, endpoints included. */
  messageIds: string[];
}

export interface PlanExtraction {
  /** Nodes of the LAST successful plan_init. */
  nodes: PlanNode[];
  /** nodeId → span, for every nodeId used by some clean call (whether or not it is in the current plan). */
  spans: Record<string, PlanNodeSpan>;
}

/** Something that should have matched a LearnHarness contract and did not: skipped and reported, without blocking the session. */
export interface ExtractionAnomaly {
  messageId: string;
  toolCallId: string | null;
  reason: string;
}

export interface SessionExtraction {
  /** Questions whose toolResult comes after the cursor, in transcript order. */
  questions: AnsweredQuestion[];
  /** Practices whose conclude toolResult comes after the cursor (the `problem` may be earlier). */
  practices: ConcludedPractice[];
  /** Plan of the WHOLE record (not trimmed by the cursor); null if there was no successful plan_init. */
  plan: PlanExtraction | null;
  /** id of the record's last message (the new cursor); `afterMessageId ?? null` if there are no messages. */
  lastMessageId: string | null;
  /** false if `afterMessageId` is not in the record: then everything is extracted (writes are idempotent, ADR 105). */
  cursorFound: boolean;
  anomalies: ExtractionAnomaly[];
}

export interface ExtractOptions {
  /** `ingest_cursor`: only answers/conclusions in messages AFTER this id count. */
  afterMessageId?: string;
}

const QUESTION_TOOLS: readonly string[] = ["quiz", "probe", "explain", "recall"];
const isQuestionTool = (name: string): name is QuestionTool => QUESTION_TOOLS.includes(name);

interface Call {
  name: string;
  args: Record<string, unknown>;
  /** Index of the assistant message that contains it. */
  at: number;
}

/** Text of an assistant message: non-empty `text` parts joined with "\n\n" (null if there are none). */
function assistantText(m: LhMessage): string | null {
  if (m.role !== "assistant") return null;
  const parts: string[] = [];
  for (const part of m.content) {
    if (part.type === "text" && "text" in part && typeof part.text === "string" && part.text.trim() !== "") parts.push(part.text);
  }
  return parts.length > 0 ? parts.join("\n\n") : null;
}

export function extractSessionItems(record: ChatRecord, opts?: ExtractOptions): SessionExtraction {
  const messages = record.messages;
  const after = opts?.afterMessageId;
  const cursorIdx = after === undefined ? -1 : messages.findIndex((m) => m.id === after);
  const cursorFound = after === undefined || cursorIdx >= 0;
  const start = cursorIdx + 1; // unknown cursor → -1 + 1 = 0: everything is extracted
  const anomalies: ExtractionAnomaly[] = [];

  // Calls by id and the set of "clean" calls (with a non-error toolResult).
  const calls = new Map<string, Call>();
  const clean = new Set<string>();
  messages.forEach((m, at) => {
    if (m.role === "assistant") {
      for (const part of m.content) {
        if (part.type === "toolCall" && "id" in part && "name" in part) {
          const args = "arguments" in part && typeof part.arguments === "object" && part.arguments !== null ? (part.arguments as Record<string, unknown>) : {};
          calls.set(String(part.id), { name: String(part.name), args, at });
        }
      }
    } else if (m.role === "toolResult" && !m.isError) {
      clean.add(m.toolCallId);
    }
  });

  const questions: AnsweredQuestion[] = [];
  const practices: ConcludedPractice[] = [];
  const pending: string[] = []; // clean problems not yet concluded
  let planNodes: PlanNode[] | null = null;

  messages.forEach((m, i) => {
    if (m.role !== "toolResult" || m.isError) return;
    const counted = i >= start;

    if (m.toolName === "plan_init") {
      const d = PlanInitDetailsSchema.safeParse(m.details);
      if (d.success) planNodes = d.data.tree.nodes;
      return;
    }

    if (m.toolName === "problem") {
      pending.push(m.toolCallId);
      return;
    }

    if (m.toolName === "conclude") {
      const details = m.details as { problemCallId?: unknown } | null;
      const wanted = typeof details?.problemCallId === "string" ? details.problemCallId : undefined;
      const k = wanted !== undefined && pending.includes(wanted) ? pending.indexOf(wanted) : pending.length - 1;
      const problemCallId = k >= 0 ? pending.splice(k, 1)[0]! : null;
      if (!counted) return;
      const anomaly = (reason: string) => anomalies.push({ messageId: m.id, toolCallId: m.toolCallId, reason });
      if (problemCallId === null) return anomaly("conclude without a pending problem");
      const problem = ProblemArgsSchema.safeParse(calls.get(problemCallId)?.args);
      if (!problem.success) return anomaly(`invalid arguments for problem ${problemCallId}`);
      const conclude = ConcludeArgsSchema.safeParse(calls.get(m.toolCallId)?.args);
      if (!conclude.success) return anomaly("invalid conclude arguments");
      const { outcome } = conclude.data;
      const rung = conclude.data.rung ?? null;
      practices.push({
        problemCallId,
        concludeCallId: m.toolCallId,
        target: problem.data.target ?? [],
        mode: problem.data.mode,
        outcome,
        rung,
        missClass: conclude.data.missClass ?? null,
        verdict: conclude.data.verdict ?? null,
        at: new Date(m.timestamp).toISOString(),
        messageId: m.id,
        correct: outcome === "dismissed" ? null : outcome === "solved" || outcome === "solvedWithHints",
        responseFormat: rung === null || rung === "R0" || rung === "R1" ? "open" : "mcq",
        dismissed: outcome === "dismissed",
      });
      return;
    }

    if (!counted || !isQuestionTool(m.toolName)) return;
    const tool = m.toolName;
    const d = QuestionAnswerDataSchema.safeParse(m.details);
    if (!d.success) {
      anomalies.push({ messageId: m.id, toolCallId: m.toolCallId, reason: `details do not match QuestionAnswerData: ${d.error.issues[0]?.message ?? "?"}` });
      return;
    }
    const a = d.data;
    const open = tool === "explain" || tool === "recall";
    const dismissed = a.dismissed === true;
    const callArgs = QuestionCallArgsSchema.safeParse(calls.get(m.toolCallId)?.args);
    let nextTeacherText: string | null = null;
    for (let j = i + 1; j < messages.length; j++) {
      const next = messages[j]!;
      if (next.role === "user") break;
      const text = assistantText(next);
      if (text !== null) {
        nextTeacherText = text;
        break;
      }
    }
    questions.push({
      toolCallId: m.toolCallId,
      tool,
      nodeId: (callArgs.success && callArgs.data.nodeId) || null,
      questionText: a.questionText,
      correct: open || dismissed ? null : a.dontKnow ? false : (a.correct ?? null),
      dontKnow: a.dontKnow,
      confidence: open || dismissed || a.dontKnow ? null : (a.confidence ?? null),
      responseFormat: open ? "open" : "mcq",
      committed: a.committed ?? null,
      text: open ? (a.text ?? null) : null,
      thinking: a.thinking ?? a.note ?? null,
      readingThinking: a.readingThinking ?? null,
      answeredAt: a.answeredAt,
      messageId: m.id,
      nextTeacherText,
      dismissed,
    });
  });

  // Plan spans: first and last clean call (quiz/explain) tagged with each nodeId.
  const bounds = new Map<string, { first: number; last: number }>();
  for (const [id, call] of calls) {
    if (!clean.has(id) || (call.name !== "quiz" && call.name !== "explain")) continue;
    const nodeId = call.args.nodeId;
    if (typeof nodeId !== "string" || nodeId === "") continue;
    const b = bounds.get(nodeId);
    if (!b) bounds.set(nodeId, { first: call.at, last: call.at });
    else {
      b.first = Math.min(b.first, call.at);
      b.last = Math.max(b.last, call.at);
    }
  }
  const spans: Record<string, PlanNodeSpan> = {};
  for (const [nodeId, { first, last }] of bounds) {
    const slice = messages.slice(first, last + 1);
    spans[nodeId] = { firstMessageId: messages[first]!.id, lastMessageId: messages[last]!.id, messageIds: slice.map((x) => x.id) };
  }

  return {
    questions,
    practices,
    plan: planNodes === null ? null : { nodes: planNodes, spans },
    lastMessageId: messages.at(-1)?.id ?? after ?? null,
    cursorFound,
    anomalies,
  };
}
