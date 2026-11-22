// The PRACTICE lane owns this file. Boundary with the KNOWLEDGE lane (declarations, ADR 102 point 10).
import { isoNow, newSchedule, ulid } from "@graphharness/core";
import type { AnswerValue, CardFront, ConceptStateView, ConfirmationItem } from "@graphharness/contracts";
import { LlmError } from "@graphharness/llm";
import { conflict, notFound } from "../errors.ts";
import { draftCards } from "./card-generation.ts";
import { cardAnswer, getCard, gradeLocally, insertCard, scheduleOf, type CardRow } from "./cards.ts";
import type { HubContext } from "./context.ts";
import { touchMatchedError } from "./errors.ts";
import { recordEvidence } from "./evidence.ts";
import { conceptStateView, withEval } from "./practice-common.ts";
import { activeTemplateOf, createInstance, getInstance } from "./templates.ts";

/** 1–2 items per declaration. */
export const MAX_CONFIRMATION_ITEMS = 2;

/**
 * Creates 1–2 confirmation items for an already inserted declaration: with an active template → eval instance
 * (cards.instance_id); without a template → MCQ or cloze card generated from the concept (cheap LLM, validated in code).
 * They are stored as `cards` with purpose='confirmation' and declaration_id. Returns the contracts shape.
 *
 * If eval or the LLM do not respond, the declaration stays recorded without items (a log warning is emitted): nothing is lost.
 */
export async function createConfirmationItems(ctx: HubContext, input: { declarationId: string; conceptId: string }): Promise<ConfirmationItem[]> {
  const { db } = ctx;
  const concept = db.prepare("SELECT id, name, description, subject_id FROM concepts WHERE id = ?").get(input.conceptId) as
    | { id: string; name: string; description: string; subject_id: string | null }
    | undefined;
  if (!concept) throw notFound();
  const now = ctx.now();
  // scheduling does not matter (it is retired once answered); it becomes visible after DECLARATION_CONFIRM_DEFER_MIN.
  const schedule = newSchedule(now.getTime(), 1);
  const base = { conceptId: concept.id, purpose: "confirmation" as const, declarationId: input.declarationId, schedule };

  const template = activeTemplateOf(db, concept.id);
  if (template) {
    try {
      // Open answer (number, expression, matrix or choice) graded by eval: `answer` null (ADR 102 point 13).
      const inst = await createInstance(ctx, template.id);
      const id = insertCard(db, { ...base, kind: "text", frontText: null, instanceId: inst.id, answer: null }, now);
      return [{ itemId: id, conceptId: concept.id, kind: "text", front: { text: null, instance: inst.client }, options: null }];
    } catch (err) {
      console.warn("[confirmations] eval did not generate the instance; using an LLM card:", err instanceof Error ? err.message : err);
    }
  }

  const propositions = db
    .prepare(
      `SELECT p.id, p.statement FROM lh_propositions p JOIN concept_propositions cp ON cp.proposition_id = p.id
       WHERE cp.concept_id = ? AND p.deleted = 0 ORDER BY p.id LIMIT 30`,
    )
    .all(concept.id) as { id: string; statement: string }[];
  let drafted;
  try {
    drafted = await draftCards(ctx, "confirmation-card", concept, propositions, MAX_CONFIRMATION_ITEMS);
  } catch (err) {
    if (!(err instanceof LlmError)) throw err;
    console.warn("[confirmations] the LLM generated no items; the declaration is left without immediate confirmation:", err.message);
    return [];
  }
  // MCQ or cloze (not `text`).
  const valid = drafted.filter((c) => c.kind !== "text");
  return db.transaction(() =>
    valid.map((c) => {
      const id = insertCard(db, { ...base, kind: c.kind, frontText: c.frontText, options: c.options, answer: c.answer, propositionIds: c.propositionIds }, now);
      const front: CardFront = { text: c.frontText, instance: null };
      return { itemId: id, conceptId: concept.id, kind: c.kind, front, options: c.options };
    }),
  )();
}

export interface ConfirmationResult {
  correct: boolean;
  expectedAnswer: AnswerValue;
  conceptState: ConceptStateView;
  /** false if the item was already answered (the stored result is returned). */
  evidenceRecorded: boolean;
}

function expectedOf(ctx: HubContext, card: CardRow): AnswerValue {
  const answer = cardAnswer(card);
  if (answer === null) return (getInstance(ctx.db, card.instance_id!)!.payload as import("./eval-client.ts").RecipeInstancePayload).answer as AnswerValue;
  if ("optionId" in answer) return answer.optionId;
  if ("text" in answer) return answer.text;
  // confirmation does not use parsons/spot_bug; if it arrives, it serialises.
  return JSON.stringify(answer);
}

/**
 * Grading + effects of an item. `correct` only for cards graded locally (POST /cards/:id/review
 * with the client's `correct`, D15); otherwise `answer` is graded here (eval or normalizeAnswer).
 */
export async function answerConfirmation(
  ctx: HubContext,
  input: { itemId: string; answer: unknown; correct?: boolean; responseMs?: number | null },
): Promise<ConfirmationResult> {
  const { db } = ctx;
  const card = getCard(db, input.itemId);
  if (!card || card.purpose !== "confirmation") throw notFound();
  const expectedAnswer = expectedOf(ctx, card);
  const conceptId = card.concept_id!;

  if (card.retired === 1) {
    // Idempotent per card: the result that was already stored.
    const prev = db.prepare("SELECT correct FROM card_reviews WHERE card_id = ? ORDER BY reviewed_at, rowid LIMIT 1").pluck().get(card.id) as number | undefined;
    return { correct: prev === 1, expectedAnswer, conceptState: conceptStateView(ctx, conceptId), evidenceRecorded: false };
  }

  const now = ctx.now();
  const at = isoNow(now);
  const answer = cardAnswer(card);
  let correct: boolean;
  let instanceGrade: { instanceId: string; templateId: string; detectorKey: string | null } | null = null;
  if (answer === null) {
    const instance = getInstance(db, card.instance_id!)!;
    const g = await withEval(() => ctx.evalApi.grade(instance.payload as import("./eval-client.ts").RecipeInstancePayload, input.answer));
    correct = g.correct;
    instanceGrade = { instanceId: instance.id, templateId: instance.template_id, detectorKey: g.correct ? null : (g.detectorKey ?? null) };
  } else correct = input.correct ?? gradeLocally(answer, input.answer);

  const evidenceRecorded = db.transaction(() => {
    // Two simultaneous answers: only the first retires the card and counts.
    if (db.prepare("UPDATE cards SET retired = 1, reviewed = 1 WHERE id = ? AND retired = 0").run(card.id).changes === 0) throw conflict("already_answered");
    if (instanceGrade) {
      const matched = touchMatchedError(db, instanceGrade.templateId, instanceGrade.detectorKey, at);
      db.prepare(
        `INSERT INTO attempts (id, instance_id, context, user_input_json, correct, matched_error_id, unknown_pattern, hints_used, response_ms, created_at)
         VALUES (?, ?, 'confirmation', ?, ?, ?, ?, 0, ?, ?)`,
      ).run(
        ulid(now.getTime()),
        instanceGrade.instanceId,
        JSON.stringify({ result: input.answer }),
        correct ? 1 : 0,
        matched,
        !correct && !instanceGrade.detectorKey ? 1 : 0,
        input.responseMs ?? null,
        at,
      );
    }
    const before = scheduleOf(card);
    db.prepare(
      `INSERT INTO card_reviews (id, card_id, correct, response_ms, early, override, given_json, schedule_before_json, reviewed_at)
       VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?)`,
    ).run(ulid(now.getTime()), card.id, correct ? 1 : 0, input.responseMs ?? null, input.answer === undefined ? null : JSON.stringify(input.answer), JSON.stringify(before), at);
    if (card.declaration_id)
      db.prepare("UPDATE declarations SET status = ?, resolved_at = ? WHERE id = ? AND status = 'pending'").run(
        correct ? "confirmed" : "refuted",
        at,
        card.declaration_id,
      );
    return recordEvidence(
      db,
      {
        conceptId,
        at,
        source: "confirmation",
        correct,
        responseFormat: card.kind === "mcq" ? "mcq" : "open",
        weight: 1,
        ref: { cardId: card.id },
      },
      now,
    ).inserted;
  })();
  return { correct, expectedAnswer, conceptState: conceptStateView(ctx, conceptId), evidenceRecorded };
}

/**
 * Answers an item (MCP answer_confirmation and POST /cards/:id/review of a confirmation card): deterministic
 * grading (eval if there is an instance; local with normalizeAnswer otherwise) → `confirmation` evidence (weight 1) →
 * declarations.status confirmed|refuted → retires the card. Idempotent per card.
 */
export async function answerConfirmationItem(
  ctx: HubContext,
  input: { itemId: string; answer: unknown; responseMs?: number | null },
): Promise<{ correct: boolean; expectedAnswer: unknown; conceptState: unknown }> {
  const r = await answerConfirmation(ctx, input);
  return { correct: r.correct, expectedAnswer: r.expectedAnswer, conceptState: r.conceptState };
}

