// Ported from graphlearn/packages/contracts/src/flashcards.ts (65b56d6).
import { z } from "zod";

/** S18 — flashcards with ordinal SM-2 (025, 057). Local grading, no AI in review. */
export const FlashcardKindSchema = z.enum(["mcq", "cloze", "text"]);
export type FlashcardKind = z.infer<typeof FlashcardKindSchema>;

export const FlashcardSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  sessionId: z.string().nullable(),
  nodeId: z.string().nullable(),
  /** Topic name, if any. */
  topic: z.string().nullable(),
  kind: FlashcardKindSchema,
  /**
   * Front: text with formulas between $…$ (cloze/text/import) or an exercise already generated
   * (`evaluatorKey` + `prompt`, as in the blocks).
   */
  front: z.object({
    text: z.string().nullable(),
    evaluatorKey: z.string().nullable(),
    prompt: z.record(z.unknown()).nullable(),
  }),
  /** MCQ: options; the right one is `answer` (its id). */
  options: z.array(z.object({ id: z.string(), value: z.unknown() })).nullable(),
  /** The answer, for grading in the browser (025: local grading). */
  answer: z.unknown(),
  priority: z.number(),
  due: z.boolean(),
  intervalDays: z.number(),
  repetitions: z.number().int().nonnegative(),
});
export type Flashcard = z.infer<typeof FlashcardSchema>;

/** GET /v1/projects/:id/flashcards — infinite queue, from highest to lowest priority. */
export const FlashcardQueueSchema = z.object({
  cards: z.array(FlashcardSchema),
  total: z.number().int().nonnegative(),
  dueCount: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative().nullable(),
});
export type FlashcardQueue = z.infer<typeof FlashcardQueueSchema>;

export const FlashcardReviewBodySchema = z.object({
  correct: z.boolean(),
  responseMs: z.number().int().nonnegative().max(3_600_000).optional(),
  /** "Actually it went well" after a failure in cloze/text (short window). */
  override: z.boolean().optional(),
});
export type FlashcardReviewBody = z.infer<typeof FlashcardReviewBodySchema>;

/** Append-only JSON import (025), compatible with the basics of simple_study. */
export const FlashcardImportBodySchema = z.object({
  cards: z
    .array(
      z.object({
        kind: z.enum(["cloze", "text"]).default("text"),
        front: z.string().min(1).max(2000),
        back: z.string().min(1).max(500),
        topic: z.string().max(200).optional(),
      }),
    )
    .min(1)
    .max(500),
});
export type FlashcardImportBody = z.infer<typeof FlashcardImportBodySchema>;
