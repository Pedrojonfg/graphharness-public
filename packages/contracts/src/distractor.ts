// Ported from graphlearn/packages/contracts/src/distractor.ts (65b56d6).
import { z } from "zod";
import { TemplateIdSchema, TypicalErrorIdSchema } from "./template.ts";

export const ResponseFormatSchema = z.enum(["open", "mcq"]);
export type ResponseFormat = z.infer<typeof ResponseFormatSchema>;

export const DEFAULT_DISTRACTOR_PRIOR_FLOOR = 1;

export function resolveDistractorPriorFloor(
  raw: string | undefined = process.env.DISTRACTOR_PRIOR_FLOOR,
): number {
  if (!raw) return DEFAULT_DISTRACTOR_PRIOR_FLOOR;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_DISTRACTOR_PRIOR_FLOOR;
  return n;
}

export type DistractorWeightInput = {
  errorId: string;
  count: number;
  distractorWeightBase: number;
};

export type DistractorWeightResult = {
  errorId: string;
  weight: number;
};

/** ADR 037.2 — normalized weights; no raw counts in the API. */
export function computeDistractorWeights(
  errors: DistractorWeightInput[],
  priorFloor: number = DEFAULT_DISTRACTOR_PRIOR_FLOOR,
): DistractorWeightResult[] {
  if (errors.length === 0) return [];
  const raw = errors.map((e) => ({
    errorId: e.errorId,
    value:
      e.count + Math.max(e.distractorWeightBase, priorFloor),
  }));
  const sum = raw.reduce((acc, r) => acc + r.value, 0);
  if (sum <= 0) {
    const u = 1 / errors.length;
    return errors.map((e) => ({ errorId: e.errorId, weight: u }));
  }
  return raw.map((r) => ({
    errorId: r.errorId,
    weight: r.value / sum,
  }));
}

export const DistractorWeightEntrySchema = z.object({
  errorId: TypicalErrorIdSchema,
  weight: z.number().min(0).max(1),
});

export type DistractorWeightEntry = z.infer<typeof DistractorWeightEntrySchema>;

export const DistractorWeightsResponseSchema = z.object({
  templateId: TemplateIdSchema,
  levelId: TemplateIdSchema,
  stepId: TemplateIdSchema,
  weights: z.array(DistractorWeightEntrySchema),
});

export type DistractorWeightsResponse = z.infer<
  typeof DistractorWeightsResponseSchema
>;

export const RecordAnonymousErrorObservationInputSchema = z.object({
  templateId: TemplateIdSchema,
  levelId: TemplateIdSchema,
  stepId: TemplateIdSchema,
  errorId: TypicalErrorIdSchema,
  responseFormat: ResponseFormatSchema,
});

export type RecordAnonymousErrorObservationInput = z.infer<
  typeof RecordAnonymousErrorObservationInputSchema
>;
