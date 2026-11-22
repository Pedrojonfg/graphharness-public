// Deterministic exercises for the PWA (GL-010; `/exercises` route).
// The instance travels as `client_json` (without solution). The solution is only returned once the exercise is finished.
import { z } from "zod";
import { AnswerValueSchema, ClientInstanceSchema, ConceptStateViewSchema, IdSchema } from "./common.ts";
import { CodeComprehensionGivenSchema } from "../recipe.ts";

/** POST /exercises → new instance. Exactly one of `templateId` / `conceptId` (with `conceptId`, its active template). */
export const CreateExerciseBodySchema = z
  .object({ templateId: IdSchema.optional(), conceptId: IdSchema.optional() })
  .strict()
  .refine((b) => (b.templateId === undefined) !== (b.conceptId === undefined), "provide templateId or conceptId, not both");
export type CreateExerciseBody = z.infer<typeof CreateExerciseBodySchema>;

export const ExerciseSchema = z
  .object({
    instanceId: IdSchema,
    templateId: IdSchema,
    templateName: z.string(),
    conceptId: IdSchema,
    instance: ClientInstanceSchema,
    /** The method's summary sheet, to ask for the intermediate steps (step 4). */
    methodSummary: z.string().nullable(),
  })
  .strict();
export type Exercise = z.infer<typeof ExerciseSchema>;

/** POST /exercises/:instanceId/attempt — `userInput` as in eval (recipe: `result`; code: `given`). */
export const ExerciseAttemptBodySchema = z.object({
  userInput: z
    .object({ result: AnswerValueSchema.optional(), given: CodeComprehensionGivenSchema.optional() })
    .strict()
    .refine((u) => u.result !== undefined || u.given !== undefined, "provide result or given"),
  responseMs: z.number().int().nonnegative().max(3_600_000).optional(),
});
export type ExerciseAttemptBody = z.infer<typeof ExerciseAttemptBodySchema>;

/**
 * GL-010 flow: success → finished. Failure → `canRetry` (hint via /hint) → second attempt → finished
 * with solution. `known_error` = matches an error of the template; `unknown_error` = no pattern: the PWA
 * asks for the intermediate steps and offers to explain (/explain).
 */
export const ExerciseAttemptResponseSchema = z
  .object({
    attemptId: IdSchema,
    attemptNumber: z.number().int().min(1).max(2),
    correct: z.boolean(),
    outcome: z.enum(["correct", "known_error", "unknown_error"]),
    canRetry: z.boolean(),
    finished: z.boolean(),
    /** Only with `finished`: solution (recipe: `result`; code: canonical `given`). */
    solution: z.union([AnswerValueSchema, CodeComprehensionGivenSchema]).nullable(),
    /** After a failure with adaptive distractors: how many distractors are still visible (ADR 108). */
    visibleDistractorCount: z.number().int().nonnegative().optional(),
    /** `hub_exercise` evidence of the first attempt; null if not yet recorded. */
    conceptState: ConceptStateViewSchema.nullable(),
  })
  .strict();
export type ExerciseAttemptResponse = z.infer<typeof ExerciseAttemptResponseSchema>;

/** POST /exercises/:instanceId/hint — counts as a hint used (`hints_used`). 409 `exercise_finished`. */
export const ExerciseHintResponseSchema = z.object({
  instanceId: IdSchema,
  hint: z.string(),
  /** `known_error`: hint for the recognized error (cached, ADR 102 §5); `method`: no recognized error, step from the summary sheet. */
  kind: z.enum(["known_error", "method"]),
  hintsUsed: z.number().int().min(1),
});
export type ExerciseHintResponse = z.infer<typeof ExerciseHintResponseSchema>;

/**
 * POST /exercises/:instanceId/explain — after at least one attempt (409 `no_attempt`).
 * `steps` = the user's intermediate steps (one per step of the summary sheet); `learnerExplanation` = their
 * optional explanation, written or dictated (GL-070). Both also feed `error-hypothesize`.
 */
export const ExerciseExplainBodySchema = z.object({
  steps: z.array(z.string().max(500)).max(20).optional(),
  learnerExplanation: z.string().max(2000).optional(),
});
export type ExerciseExplainBody = z.infer<typeof ExerciseExplainBodySchema>;

/** Instant explanation (LLM `strong`); only formulas verified by eval (GL-011, GL-044). */
export const ExerciseExplanationSchema = z.object({
  instanceId: IdSchema,
  summary: z.string(),
  steps: z.array(
    z.object({
      /** Text with `$…$` only for formulas already verified. */
      text: z.string(),
      formulas: z.array(z.object({ latex: z.string(), verified: z.literal(true) })),
    }),
  ),
  /** Formulas that did not verify and were omitted (notice). */
  omittedFormulas: z.number().int().nonnegative(),
  /** Index (from 0) of the first step of the user that does not match; null if it could not be compared or there were no steps. */
  firstMismatchStep: z.number().int().nonnegative().nullable(),
});
export type ExerciseExplanation = z.infer<typeof ExerciseExplanationSchema>;
