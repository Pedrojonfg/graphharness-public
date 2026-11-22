// Ported from graphlearn/packages/contracts/src/template.ts (65b56d6).
import { z } from "zod";

export const TemplateIdSchema = z.string().uuid();
export type TemplateId = z.infer<typeof TemplateIdSchema>;

export const TemplateDomainSchema = z.enum(["mathematics", "economics"]);
export type TemplateDomain = z.infer<typeof TemplateDomainSchema>;

export const MethodLimitsSchema = z
  .object({
    summary: z.string().max(500),
    optionalGeneralTemplateId: TemplateIdSchema.optional(),
  })
  .nullable()
  .optional();

export type MethodLimits = z.infer<typeof MethodLimitsSchema>;

export const GenerationParameterSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(["integer", "matrix"]),
  description: z.string().optional(),
});

export const GenerationSpecSchema = z.object({
  parameters: z.array(GenerationParameterSchema),
  constraints: z.array(z.record(z.unknown())),
  simplicityPolicy: z
    .object({
      maxAttempts: z.number().int().positive().optional(),
    })
    .optional(),
  /** `recipe_v1` templates (039.4): the validated recipe that eval interprets. */
  recipe: z.record(z.unknown()).optional(),
});

export type GenerationSpec = z.infer<typeof GenerationSpecSchema>;

export const TemplateLevelSchema = z.object({
  id: TemplateIdSchema,
  templateId: TemplateIdSchema,
  orderIndex: z.number().int().nonnegative(),
  difficultyBand: z.string().min(1),
  description: z.string(),
});

export type TemplateLevel = z.infer<typeof TemplateLevelSchema>;

export const GradingMethodOptionSchema = z.object({
  evaluatorKey: z.string().min(1),
  label: z.string().min(1).max(120),
});
export type GradingMethodOption = z.infer<typeof GradingMethodOptionSchema>;

export const TemplateStepSchema = z.object({
  id: TemplateIdSchema,
  levelId: TemplateIdSchema,
  orderIndex: z.number().int().nonnegative(),
  evaluatorKey: z.string().min(1),
  paramsSchema: z.record(z.unknown()),
  /** Grading variants (032.6 / ADR 071); UI selector only if length > 1. */
  gradingMethods: z.array(GradingMethodOptionSchema).optional(),
});

export type TemplateStep = z.infer<typeof TemplateStepSchema>;

/** Options for the method selector in block/diagnostic; undefined if there is a single method. */
export function uiGradingMethods(step: Pick<TemplateStep, "evaluatorKey" | "gradingMethods">): GradingMethodOption[] | undefined {
  const methods = step.gradingMethods?.length ? step.gradingMethods : undefined;
  if (!methods || methods.length <= 1) return undefined;
  return methods;
}

export const TypicalErrorIdSchema = z.string().uuid();
export type TypicalErrorId = z.infer<typeof TypicalErrorIdSchema>;

export const TypicalErrorSchema = z.object({
  id: TypicalErrorIdSchema,
  templateId: TemplateIdSchema,
  stepId: TemplateIdSchema.optional(),
  detectorKey: z.string().min(1),
  distractorWeightBase: z.number().nonnegative(),
  /** S19: detector by hash of the aggregated answer (048). */
  patternHash: z.string().min(16).optional(),
});

export type TypicalError = z.infer<typeof TypicalErrorSchema>;

export const GlobalTemplateSchema = z.object({
  id: TemplateIdSchema,
  slug: z.string().min(1),
  domain: TemplateDomainSchema,
  name: z.string().min(1),
  methodLimits: MethodLimitsSchema,
  prerequisiteTemplateIds: z.array(TemplateIdSchema),
  generationSpec: GenerationSpecSchema,
  levels: z.array(TemplateLevelSchema),
  steps: z.array(TemplateStepSchema),
  typicalErrors: z.array(TypicalErrorSchema),
});

export type GlobalTemplate = z.infer<typeof GlobalTemplateSchema>;

export const GlobalTemplateSummarySchema = z.object({
  id: TemplateIdSchema,
  slug: z.string().min(1),
  domain: TemplateDomainSchema,
  name: z.string().min(1),
});

export type GlobalTemplateSummary = z.infer<typeof GlobalTemplateSummarySchema>;
