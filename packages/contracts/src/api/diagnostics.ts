// Ported from graphlearn/packages/contracts/src/diagnostic.ts (65b56d6).
// Diagnostic from "Prepare exam" (GL-006/028/052/053; ADR 102 §2; `/diagnostics` route): per exam instead of per session.
import { z } from "zod";
import { AnswerValueSchema, ClientInstanceSchema, IdSchema, McqOptionSchema } from "./common.ts";

export const DIAGNOSTIC_MAX_ITEMS = 20;

/** POST /diagnostics `{examId}` — opens a pass (or returns the open one for that exam). */
export const CreateDiagnosticBodySchema = z.object({ examId: IdSchema });
export type CreateDiagnosticBody = z.infer<typeof CreateDiagnosticBodySchema>;

/** Pending question. MCQ: correct + typical errors on the same instance; "I don't know" always counts and is not an option. */
export const DiagnosticItemSchema = z
  .object({
    itemId: IdSchema,
    conceptId: IdSchema,
    conceptName: z.string(),
    format: z.enum(["mcq", "open"]),
    instance: ClientInstanceSchema,
    /** Only `mcq`. */
    options: z.array(McqOptionSchema).nullable(),
  })
  .strict();
export type DiagnosticItem = z.infer<typeof DiagnosticItemSchema>;

/**
 * - `complete`: nothing left to ask;
 * - `max_items`: cap of 20 questions;
 * - `nothing_to_ask`: no concept in the scope is stale/unknown/pending with a template.
 */
export const DiagnosticFinishReasonSchema = z.enum(["complete", "max_items", "nothing_to_ask"]);

export const DiagnosticStateSchema = z
  .object({
    id: IdSchema,
    examId: IdSchema,
    status: z.enum(["open", "done"]),
    answered: z.number().int().nonnegative(),
    maxItems: z.number().int().min(1),
    /** null if it has finished. */
    item: DiagnosticItemSchema.nullable(),
    finished: z
      .object({
        reason: DiagnosticFinishReasonSchema,
        /** Concepts in the scope without a template: they are diagnosed with confirmation cards or with an LH session. */
        unaskableConceptIds: z.array(IdSchema),
      })
      .nullable(),
  })
  .strict();
export type DiagnosticState = z.infer<typeof DiagnosticStateSchema>;

/** POST /diagnostics/:id/answer */
export const DiagnosticAnswerBodySchema = z.object({
  itemId: IdSchema,
  answer: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("mcq"), optionId: IdSchema }),
    z.object({ kind: z.literal("open"), userInput: z.object({ result: AnswerValueSchema }).strict() }),
    z.object({ kind: z.literal("dont_know") }),
  ]),
  responseMs: z.number().int().nonnegative().max(3_600_000).optional(),
});
export type DiagnosticAnswerBody = z.infer<typeof DiagnosticAnswerBodySchema>;

/** 409: `already_answered` | `diagnostic_finished` | `wrong_format`. */
export const DiagnosticAnswerResponseSchema = z
  .object({
    outcome: z.enum(["correct", "incorrect", "dont_know"]),
    state: DiagnosticStateSchema,
  })
  .strict();
export type DiagnosticAnswerResponse = z.infer<typeof DiagnosticAnswerResponseSchema>;
