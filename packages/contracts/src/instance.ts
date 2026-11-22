// Ported from graphlearn/packages/contracts/src/instance.ts (65b56d6).
import { z } from "zod";
import { GenerationSpecSchema, TemplateIdSchema, TypicalErrorIdSchema } from "./template.ts";

export const InstanceIdSchema = z.string().uuid();
export type InstanceId = z.infer<typeof InstanceIdSchema>;

export const VerifiedInstanceSchema = z.object({
  id: InstanceIdSchema,
  templateId: TemplateIdSchema,
  levelId: TemplateIdSchema,
  stepId: TemplateIdSchema,
  payload: z.record(z.unknown()),
});

export type VerifiedInstance = z.infer<typeof VerifiedInstanceSchema>;

export const StepGradeSchema = z.object({
  correct: z.boolean(),
  typicalErrorId: TypicalErrorIdSchema.optional(),
  feedbackKey: z.string().optional(),
  /** ADR 048 — no known typical error (before the S19 promotion). */
  unknownErrorPattern: z.literal(true).optional(),
});

export type StepGrade = z.infer<typeof StepGradeSchema>;

export const GenerateInstanceBodySchema = z.object({
  templateId: TemplateIdSchema,
  levelId: TemplateIdSchema,
});

export type GenerateInstanceBody = z.infer<typeof GenerateInstanceBodySchema>;

/** Method/grader override (032.6, ADR 038.5). Default: project metadata + step in the catalog. */
export const GradingContextSchema = z.object({
  evaluatorKey: z.string().min(1).optional(),
  /** Human-readable UI label ("Gauss", "by rows"); does not replace evaluatorKey in eval. */
  methodVariant: z.string().min(1).max(200).optional(),
});
export type GradingContext = z.infer<typeof GradingContextSchema>;

export const GradeInstanceBodySchema = z.object({
  instanceId: InstanceIdSchema,
  stepId: TemplateIdSchema,
  userInput: z.record(z.unknown()),
  gradingContext: GradingContextSchema.optional(),
});

export type GradeInstanceBody = z.infer<typeof GradeInstanceBodySchema>;

/** Simple SymPy (034.7) or LaTeX pair (038.13 / S10); do not mix modes in one request. */
export const FormulaVerifyBodySchema = z
  .object({
    left: z.string().min(1).optional(),
    right: z.string().min(1).optional(),
    latexLeft: z.string().min(1).max(4000).optional(),
    latexRight: z.string().min(1).max(4000).optional(),
  })
  .refine(
    (b) =>
      (b.left !== undefined && b.right !== undefined) ||
      (b.latexLeft !== undefined && b.latexRight !== undefined),
    { message: "Provide left+right or latexLeft+latexRight" },
  )
  .refine(
    (b) =>
      !(
        (b.left !== undefined || b.right !== undefined) &&
        (b.latexLeft !== undefined || b.latexRight !== undefined)
      ),
    { message: "Do not mix sympy strings and latex in one request" },
  );

export type FormulaVerifyBody = z.infer<typeof FormulaVerifyBodySchema>;

export const FormulaVerifyResponseSchema = z.object({
  equivalent: z.boolean(),
});

export type FormulaVerifyResponse = z.infer<typeof FormulaVerifyResponseSchema>;

/** Internal eval: the API resolves `detectorKey` → `typicalErrorId` via the template. */
export const EvalStepGradeSchema = StepGradeSchema.extend({
  // apps/eval (pydantic) sends `"detectorKey": null` when there is no typical error.
  detectorKey: z
    .string()
    .nullish()
    .transform((v) => v ?? undefined),
});

export type EvalStepGrade = z.infer<typeof EvalStepGradeSchema>;

export const EvalGenerateRequestSchema = z.object({
  evaluatorKey: z.string().min(1),
  generationSpec: GenerationSpecSchema,
  stepId: TemplateIdSchema,
});

export const EvalGenerateResponseSchema = z.object({
  stepId: TemplateIdSchema,
  payload: z.record(z.unknown()),
});

/** Implementation in S04 (`packages/templates` + `apps/eval`). */
export interface StepEvaluator {
  validateInstance(params: unknown): VerifiedInstance;
  grade(instance: VerifiedInstance, userInput: unknown): StepGrade;
}
