// Ported from graphlearn/apps/api/src/flashcards/flashcard-routes.ts (65b56d6).
// Flashcards (D14, D15, D26; GL-025/057): queue, review with core's scheduler, override and import.
import {
  flashcardGeneratesEvidence,
  gradeParsons,
  gradePredict,
  gradeSpotBug,
  isDue,
  isoNow,
  newSchedule,
  orderQueue,
  overrideToCorrect,
  priority,
  review,
  ulid,
  type CardSchedule,
} from "@graphharness/core";
import type {
  AnswerValue,
  Card,
  CardAnswer,
  FlashcardImportBody,
  CardKind,
  CardPurpose,
  CardQueue,
  CardQueueQuery,
  CardRetireResponse,
  CardReviewBody,
  CardReviewResponse,
  CardScheduleView,
  ClientInstance,
  McqOption,
  ParsonsLine,
} from "@graphharness/contracts";
import type { Db } from "@graphharness/db";
import { conflict, notFound } from "../errors.ts";
import { answerConfirmation } from "./confirmations.ts";
import type { HubContext } from "./context.ts";
import { canonicalJson, recomputeConceptState, recordEvidence, weighted } from "./evidence.ts";
import { conceptStateView, withEval } from "./practice-common.ts";
import { getInstance } from "./templates.ts";


export interface CardRow {
  id: string;
  concept_id: string | null;
  proposition_ids_json: string;
  kind: CardKind;
  purpose: CardPurpose;
  front_text: string | null;
  instance_id: string | null;
  options_json: string | null;
  answer_json: string;
  source_chat_id: string | null;
  declaration_id: string | null;
  ease: number;
  interval_days: number;
  repetitions: number;
  t_ref: number;
  reviewed: number;
  retired: number;
  created_at: string;
  figure_id: string | null;
}

export interface NewCard {
  conceptId: string | null;
  propositionIds?: string[];
  kind: CardKind;
  purpose?: CardPurpose;
  frontText: string | null;
  instanceId?: string | null;
  options?: McqOption[] | null;
  /** Parsons / spot_bug: lines in `options_json` (not MCQ). */
  parsonsLines?: ParsonsLine[] | null;
  figureId?: string | null;
  /** null ⇒ the Hub grades it with eval (instance with an open answer, ADR 102 point 13). */
  answer: CardAnswer | null;
  sourceChatId?: string | null;
  declarationId?: string | null;
  schedule: CardSchedule;
}

export function insertCard(db: Db, card: NewCard, now: Date): string {
  const id = ulid(now.getTime());
  db.prepare(
    `INSERT INTO cards (id, concept_id, proposition_ids_json, kind, purpose, front_text, instance_id, options_json, answer_json,
       source_chat_id, declaration_id, ease, interval_days, repetitions, t_ref, reviewed, retired, created_at, figure_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    id,
    card.conceptId,
    JSON.stringify(card.propositionIds ?? []),
    card.kind,
    card.purpose ?? "review",
    card.frontText,
    card.instanceId ?? null,
    card.options ? JSON.stringify(card.options) : card.parsonsLines ? JSON.stringify(card.parsonsLines) : null,
    JSON.stringify(card.answer),
    card.sourceChatId ?? null,
    card.declarationId ?? null,
    card.schedule.ease,
    card.schedule.intervalDays,
    card.schedule.repetitions,
    card.schedule.tRef,
    card.schedule.reviewed ? 1 : 0,
    isoNow(now),
    card.figureId ?? null,
  );
  return id;
}

export function getCard(db: Db, id: string): CardRow | undefined {
  return db.prepare("SELECT * FROM cards WHERE id = ?").get(id) as CardRow | undefined;
}

export const scheduleOf = (c: CardRow): CardSchedule => ({
  ease: c.ease,
  intervalDays: c.interval_days,
  repetitions: c.repetitions,
  tRef: c.t_ref,
  reviewed: c.reviewed === 1,
});

export const cardAnswer = (c: CardRow): CardAnswer | null => JSON.parse(c.answer_json) as CardAnswer | null;

export function scheduleView(s: CardSchedule, nowMs: number, forceDue = false): CardScheduleView {
  return {
    priority: Math.round(priority(s, nowMs) * 1000) / 1000,
    due: forceDue || isDue(s, nowMs),
    intervalDays: s.intervalDays,
    repetitions: s.repetitions,
  };
}

/** Local grading (D15) on the server, when `given` arrives without `correct`. */
export function gradeLocally(answer: CardAnswer, given: unknown): boolean {
  if ("optionId" in answer) return given === answer.optionId;
  if ("order" in answer) return gradeParsons(answer.order, given);
  if ("lineId" in answer) return gradeSpotBug(answer.lineId, given);
  if ("text" in answer) return gradePredict(answer.text, answer.accepted, given);
  return false;
}

interface QueueRow extends CardRow {
  concept_name: string | null;
  client_json: string | null;
  declaration_status: string | null;
}

function linesFromOptions(kind: CardKind, optionsJson: string | null): ParsonsLine[] | null {
  if (!optionsJson || (kind !== "parsons" && kind !== "spot_bug")) return null;
  return JSON.parse(optionsJson) as ParsonsLine[];
}

function toCardDto(r: QueueRow, nowMs: number): Card {
  const isConfirmation = r.purpose === "confirmation";
  const lines = linesFromOptions(r.kind, r.options_json);
  const mcqOptions =
    r.options_json && r.kind === "mcq" ? (JSON.parse(r.options_json) as McqOption[]) : null;
  return {
    id: r.id,
    conceptId: r.concept_id,
    conceptName: r.concept_name,
    kind: r.kind,
    purpose: r.purpose,
    declarationId: r.declaration_id,
    front: {
      text: r.front_text,
      instance: r.client_json ? (JSON.parse(r.client_json) as ClientInstance) : null,
      ...(lines ? { parsons: { lines } } : {}),
      figureId: r.figure_id,
    },
    options: mcqOptions,
    answer: cardAnswer(r),
    schedule: scheduleView(scheduleOf(r), nowMs, isConfirmation),
    sourceChatId: r.source_chat_id,
    createdAt: r.created_at,
    figureId: r.figure_id ?? undefined,
  };
}

/**
 * GET /cards/queue. Confirmation items first (ADR 102 point 10): hidden until `created_at +
 * DECLARATION_CONFIRM_DEFER_MIN` and without those of expired declarations; then the rest by priority (GL-025).
 */
export function cardQueue(ctx: HubContext, q: CardQueueQuery): CardQueue {
  const now = ctx.now();
  const nowMs = now.getTime();
  const visibleFrom = nowMs - ctx.config.declarationConfirmDeferMin * 60_000;
  const rows = ctx.db
    .prepare(
      `SELECT c.*, k.name AS concept_name, i.client_json, d.status AS declaration_status
       FROM cards c
       LEFT JOIN concepts k ON k.id = c.concept_id
       LEFT JOIN instances i ON i.id = c.instance_id
       LEFT JOIN declarations d ON d.id = c.declaration_id
       WHERE c.retired = 0`,
    )
    .all() as QueueRow[];
  const confirmations = rows
    .filter((r) => r.purpose === "confirmation" && r.declaration_status !== "expired" && Date.parse(r.created_at) <= visibleFrom)
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  const reviews = orderQueue(
    rows.filter((r) => r.purpose === "review").map((r) => ({ row: r, schedule: scheduleOf(r) })),
    nowMs,
  ).map((x) => x.row);
  const all = [...confirmations, ...reviews];
  const page = all.slice(q.offset, q.offset + q.limit);
  return {
    cards: page.map((r) => toCardDto(r, nowMs)),
    total: all.length,
    dueCount: confirmations.length + reviews.filter((r) => isDue(scheduleOf(r), nowMs)).length,
    confirmationPending: confirmations.length,
    nextOffset: q.offset + q.limit < all.length ? q.offset + q.limit : null,
  };
}

interface ReviewRow {
  id: string;
  correct: number;
  schedule_before_json: string;
  reviewed_at: string;
  override: number;
}

function saveReview(
  db: Db,
  card: CardRow,
  r: { correct: boolean; responseMs: number | null; early: boolean; override: boolean; given: unknown; before: CardSchedule; after: CardSchedule; at: Date },
): string {
  const id = ulid(r.at.getTime());
  db.prepare(
    `INSERT INTO card_reviews (id, card_id, correct, response_ms, early, override, given_json, schedule_before_json, reviewed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    card.id,
    r.correct ? 1 : 0,
    r.responseMs,
    r.early ? 1 : 0,
    r.override ? 1 : 0,
    r.given === undefined ? null : JSON.stringify(r.given),
    JSON.stringify(r.before),
    isoNow(r.at),
  );
  db.prepare("UPDATE cards SET ease = ?, interval_days = ?, repetitions = ?, t_ref = ?, reviewed = ? WHERE id = ?").run(
    r.after.ease,
    r.after.intervalDays,
    r.after.repetitions,
    r.after.tRef,
    r.after.reviewed ? 1 : 0,
    card.id,
  );
  return id;
}

/** POST /cards/:id/review (review; flashcard row; ADR 102 points 10 and 13). */
export async function reviewCard(ctx: HubContext, cardId: string, body: CardReviewBody): Promise<CardReviewResponse> {
  const card = getCard(ctx.db, cardId);
  if (!card) throw notFound();
  const now = ctx.now();
  const nowMs = now.getTime();
  const responseMs = body.responseMs ?? null;
  const answer = cardAnswer(card);

  if (card.purpose === "confirmation") {
    if (card.retired === 1) throw conflict("already_answered");
    if (body.override === true) throw conflict("nothing_to_override");
    if (answer === null && body.given === undefined) throw conflict("given_required");
    const r = await answerConfirmation(ctx, {
      itemId: card.id,
      answer: body.given,
      correct: answer === null ? undefined : body.correct,
      responseMs,
    });
    return {
      cardId: card.id,
      correct: r.correct,
      early: false,
      evidenceRecorded: r.evidenceRecorded,
      retired: true,
      schedule: scheduleView(scheduleOf(card), nowMs, true),
      expectedAnswer: answer === null ? r.expectedAnswer : null,
      conceptState: card.concept_id ? r.conceptState : null,
    };
  }

  if (card.retired === 1) throw notFound();

  if (body.override === true) {
    // "I actually had it right" (D15): only cloze/text, right after a miss and within 60 s.
    const last = ctx.db
      .prepare("SELECT id, correct, schedule_before_json, reviewed_at, override FROM card_reviews WHERE card_id = ? ORDER BY reviewed_at DESC, rowid DESC LIMIT 1")
      .get(card.id) as ReviewRow | undefined;
    if (card.kind === "mcq" || card.kind === "parsons" || card.kind === "spot_bug" || !last || last.correct === 1)
      throw conflict("nothing_to_override");
    const before = JSON.parse(last.schedule_before_json) as CardSchedule;
    const r = overrideToCorrect(before, Date.parse(last.reviewed_at), nowMs, responseMs);
    if (!r) throw conflict("override_window_passed");
    const generates = flashcardGeneratesEvidence({ early: r.early, correct: true });
    const evidenceRecorded = ctx.db.transaction(() => {
      saveReview(ctx.db, card, { correct: true, responseMs, early: r.early, override: true, given: body.given, before, after: r.schedule, at: now });
      if (!card.concept_id) return false;
      // The undone miss is corrected in its own event (it is not new evidence), with `at` = now, when it is known it was
      // a hit; if it is now an early hit, it does not count.
      const ref = canonicalJson({ cardId: card.id, reviewId: last.id });
      const changed = generates
        ? ctx.db.prepare("UPDATE evidence_events SET correct = 1, at = ? WHERE source = 'flashcard' AND ref_json = ?").run(isoNow(now), ref).changes
        : ctx.db.prepare("DELETE FROM evidence_events WHERE source = 'flashcard' AND ref_json = ?").run(ref).changes;
      if (changed > 0) recomputeConceptState(ctx.db, card.concept_id);
      return generates && changed > 0;
    })();
    return {
      cardId: card.id,
      correct: true,
      early: r.early,
      evidenceRecorded,
      retired: false,
      schedule: scheduleView(r.schedule, nowMs),
      expectedAnswer: null,
      conceptState: card.concept_id ? conceptStateView(ctx, card.concept_id) : null,
    };
  }

  // Grading: local on the client (`correct`); if the card carries no answer, the Hub grades `given` with eval.
  let correct: boolean;
  let expectedAnswer: AnswerValue | null = null;
  if (answer === null) {
    if (body.given === undefined) throw conflict("given_required");
    const instance = card.instance_id ? getInstance(ctx.db, card.instance_id) : undefined;
    if (!instance) throw notFound();
    correct = (
      await withEval(() => ctx.evalApi.grade(instance.payload as import("./eval-client.ts").RecipeInstancePayload, body.given))
    ).correct;
    expectedAnswer = (instance.payload as import("./eval-client.ts").RecipeInstancePayload).answer as AnswerValue;
  } else if (body.correct !== undefined) correct = body.correct;
  else correct = gradeLocally(answer, body.given);

  const before = scheduleOf(card);
  const r = review(before, { correct, responseMs, now: nowMs });
  const evidenceRecorded = ctx.db.transaction(() => {
    const reviewId = saveReview(ctx.db, card, { correct, responseMs, early: r.early, override: false, given: body.given, before, after: r.schedule, at: now });
    if (!card.concept_id || !flashcardGeneratesEvidence({ early: r.early, correct })) return false;
    return recordEvidence(
      ctx.db,
      {
        conceptId: card.concept_id,
        at: isoNow(now),
        source: "flashcard",
        correct,
        responseFormat: card.kind === "mcq" ? "mcq" : "open",
        ...weighted(ctx.config.weights, ctx.config.flashcardEvidenceWeight, { source: "flashcard", correct, responseMs }),
        responseMs,
        ref: { cardId: card.id, reviewId },
      },
      now,
    ).inserted;
  })();
  return {
    cardId: card.id,
    correct,
    early: r.early,
    evidenceRecorded,
    retired: false,
    schedule: scheduleView(r.schedule, nowMs),
    expectedAnswer,
    conceptState: card.concept_id ? conceptStateView(ctx, card.concept_id) : null,
  };
}

/** POST /cards/:id/retire — takes the card out of the queue (`retired=1`). Idempotent; no evidence or schedule change. */
export function retireCard(ctx: HubContext, cardId: string): CardRetireResponse {
  const card = getCard(ctx.db, cardId);
  if (!card) throw notFound();
  if (card.retired === 0) ctx.db.prepare("UPDATE cards SET retired = 1 WHERE id = ? AND retired = 0").run(cardId);
  return { cardId, retired: true };
}

/** POST /cards/import — append-only, GL format (`FlashcardImportBodySchema`). No concept: external content. */
export function importCards(ctx: HubContext, body: FlashcardImportBody): { created: number } {
  const now = ctx.now();
  const schedule = newSchedule(now.getTime(), 1);
  ctx.db.transaction(() => {
    for (const c of body.cards)
      insertCard(ctx.db, { conceptId: null, kind: c.kind, frontText: c.front, answer: { text: c.back, accepted: [] }, schedule }, now);
  })();
  return { created: body.cards.length };
}
