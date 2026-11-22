// Flashcards (D14, D15, D26; `/cards` route).
//
// DECISION — what travels to the client:
// - Card grading is LOCAL in the client (D15, GL-025), so the queue DOES carry the
//   answer of the cards graded locally (`answer`: `{optionId}` or `{text, accepted}`),
//   like GL's `FlashcardSchema`. It is a single-user installation: there is no one to hide it from.
// - What NEVER leaves the Hub is an instance's solution (`instances.payload_json`: `answer`,
//   `errors`, `mcq`, `params`). That is why `front.instance` is `ClientInstanceSchema` (strict) and the card
//   is also strict: a solution field makes the parse fail.
// - Exception: a card with `front.instance` and `kind ≠ "mcq"` (confirmation item of a template,
//   open numeric/expression/matrix answer) CANNOT be graded with `normalizeAnswer`: it goes with
//   `answer: null` and the Hub grades it with eval from `given` (POST /cards/:id/review without `correct`).
//   The correct answer is only revealed afterwards, in `expectedAnswer`.
// - Template MCQs carry as options the correct result and the typical errors (D14): the
//   options are what is taught, not the instance's solution.
import { z } from "zod";
import { FlashcardImportBodySchema } from "../flashcards.ts";
import {
  AnswerValueSchema,
  ClientInstanceSchema,
  ConceptStateViewSchema,
  IdSchema,
  IsoDateTimeSchema,
  McqOptionSchema,
} from "./common.ts";

export const CardKindSchema = z.enum(["mcq", "cloze", "text", "parsons", "predict", "spot_bug"]);
export type CardKind = z.infer<typeof CardKindSchema>;

export const CardPurposeSchema = z.enum(["review", "confirmation"]);
export type CardPurpose = z.infer<typeof CardPurposeSchema>;

/** Parsons line (also in the persisted `options_json`). */
export const ParsonsLineSchema = z
  .object({
    id: IdSchema,
    text: z.string().min(1).max(500),
    indent: z.number().int().min(0).max(8).default(0),
    /** true = not part of the solution. */
    distractor: z.boolean().optional(),
  })
  .strict();
export type ParsonsLine = z.infer<typeof ParsonsLineSchema>;

/** Front: text / instance / Parsons; at least one of text|instance|parsons. */
export const CardFrontSchema = z
  .object({
    text: z.string().nullable(),
    instance: ClientInstanceSchema.nullable(),
    parsons: z
      .object({
        lines: z.array(ParsonsLineSchema).min(2).max(24),
        language: z.string().max(40).optional(),
        /** Blanks `____` in `text` of some lines (faded). */
        faded: z.boolean().optional(),
      })
      .strict()
      .nullable()
      .optional(),
    figureId: IdSchema.nullable().optional(),
  })
  .strict()
  .refine((f) => f.text !== null || f.instance !== null || (f.parsons?.lines.length ?? 0) > 0, "empty front");
export type CardFront = z.infer<typeof CardFrontSchema>;

/**
 * `cards.answer_json`: MCQ → optionId; cloze/text/predict → text+accepted;
 * parsons → order (ids, without distractors); spot_bug → lineId.
 */
export const CardAnswerSchema = z.union([
  z.object({ optionId: IdSchema }).strict(),
  z.object({ text: z.string().min(1).max(500), accepted: z.array(z.string().min(1).max(500)) }).strict(),
  z.object({ order: z.array(IdSchema).min(1).max(24) }).strict(),
  z.object({ lineId: IdSchema }).strict(),
]);
export type CardAnswer = z.infer<typeof CardAnswerSchema>;

export const CardScheduleViewSchema = z
  .object({
    /** (now − t_ref) / interval (GL-025). */
    priority: z.number(),
    due: z.boolean(),
    intervalDays: z.number().nonnegative(),
    repetitions: z.number().int().nonnegative(),
  })
  .strict();
export type CardScheduleView = z.infer<typeof CardScheduleViewSchema>;

/** One card in the queue. Strict (see the header). */
export const CardSchema = z
  .object({
    id: IdSchema,
    conceptId: IdSchema.nullable(),
    conceptName: z.string().nullable(),
    kind: CardKindSchema,
    /** `confirmation` = item of a declaration: they come first and are marked in the PWA. */
    purpose: CardPurposeSchema,
    declarationId: IdSchema.nullable(),
    front: CardFrontSchema,
    /** MCQ: options; Parsons: not used (goes in front.parsons). */
    options: z.array(McqOptionSchema).min(2).max(8).nullable(),
    /** For local grading; null ⇒ the Hub grades it (send `given`). */
    answer: CardAnswerSchema.nullable(),
    schedule: CardScheduleViewSchema,
    sourceChatId: IdSchema.nullable(),
    createdAt: IsoDateTimeSchema,
    figureId: IdSchema.nullable().optional(),
  })
  .strict();
export type Card = z.infer<typeof CardSchema>;

/** GET /cards/queue?offset&limit */
export const CardQueueQuerySchema = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type CardQueueQuery = z.infer<typeof CardQueueQuerySchema>;

/** Infinite queue: confirmation first, then by priority. */
export const CardQueueSchema = z
  .object({
    cards: z.array(CardSchema),
    total: z.number().int().nonnegative(),
    dueCount: z.number().int().nonnegative(),
    /** Confirmation cards already visible in the queue (ADR 102 §10). */
    confirmationPending: z.number().int().nonnegative(),
    nextOffset: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type CardQueue = z.infer<typeof CardQueueSchema>;

/**
 * POST /cards/:id/review — `{correct, responseMs, override?, given?}`.
 * - Local grading: `correct` required; `given` is stored as history.
 * - Card with `answer: null`: without `correct` and with `given` (the Hub grades it). If `correct` arrives it is ignored.
 * - `override: true` = "it actually went well" (cloze/text, 60 s after a failure); `correct` is not needed there.
 * `given`: option id (MCQ), text (cloze/text) or instance value.
 */
export const CardReviewBodySchema = z
  .object({
    correct: z.boolean().optional(),
    responseMs: z.number().int().nonnegative().max(3_600_000).optional(),
    override: z.boolean().optional(),
    given: AnswerValueSchema.optional(),
  })
  .refine((b) => b.override === true || b.correct !== undefined || b.given !== undefined, "correct or given is missing");
export type CardReviewBody = z.infer<typeof CardReviewBodySchema>;

export const CardReviewResponseSchema = z
  .object({
    cardId: IdSchema,
    correct: z.boolean(),
    /** Early review: the interval does not grow and no evidence is generated if correct. */
    early: z.boolean(),
    /** `flashcard` (weight 0.5) or `confirmation` evidence was recorded. */
    evidenceRecorded: z.boolean(),
    /** Confirmation cards are retired once answered. */
    retired: z.boolean(),
    schedule: CardScheduleViewSchema,
    /** Only for cards the Hub grades: the correct answer, already answered. */
    expectedAnswer: AnswerValueSchema.nullable(),
    conceptState: ConceptStateViewSchema.nullable(),
  })
  .strict();
export type CardReviewResponse = z.infer<typeof CardReviewResponseSchema>;

/** POST /cards/import — GL format, append-only. */
export const CardImportBodySchema = FlashcardImportBodySchema;
export const CardImportResponseSchema = z.object({ created: z.number().int().nonnegative() });
export type CardImportResponse = z.infer<typeof CardImportResponseSchema>;

/** POST /cards/:id/retire — removes the card from the queue (`retired=1`). Idempotent. No evidence and no schedule change. */
export const CardRetireResponseSchema = z
  .object({
    cardId: IdSchema,
    retired: z.literal(true),
  })
  .strict();
export type CardRetireResponse = z.infer<typeof CardRetireResponseSchema>;
