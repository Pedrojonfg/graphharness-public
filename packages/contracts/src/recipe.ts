// Ported from graphlearn/packages/contracts/src/recipe.ts (65b56d6).
import { z } from "zod";

/**
 * Exercise recipe written by the AI (039.4, 051). It is interpreted by the `recipe_v1`
 * evaluator in `apps/eval`, which has the final say on its validity
 * (expression allowlist, simplicity 024, variety, distinguishable errors).
 */

export const RECIPE_EVALUATOR_KEY = "recipe_v1";
export const CODE_COMPREHENSION_EVALUATOR_KEY = "code_comprehension_v1";

const codeKind = z.enum(["parsons", "faded_parsons", "predict", "spot_bug"]);

const CodeComprehensionLineSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    text: z.string().min(1).max(400),
    indent: z.number().int().min(0).max(8),
    distractor: z.literal(true).optional(),
  })
  .strict();

/** Code-comprehension instance visible to the student (without solution). */
export const CodeComprehensionClientPayloadSchema = z
  .object({
    comprehensionVersion: z.literal(1),
    kind: codeKind,
    statement: z.string(),
    lines: z.array(CodeComprehensionLineSchema).min(1),
    language: z.string().optional(),
    distractorsAdaptive: z.literal(true).optional(),
    distractorCount: z.number().int().nonnegative().optional(),
  })
  .strict();
export type CodeComprehensionClientPayload = z.infer<typeof CodeComprehensionClientPayloadSchema>;

/** Student answer in eval `code_comprehension_v1`. */
export const CodeComprehensionGivenSchema = z
  .object({
    order: z.array(z.string()).optional(),
    blanks: z.record(z.string()).optional(),
    output: z.string().max(400).optional(),
    lineKey: z.string().optional(),
  })
  .strict();
export type CodeComprehensionGiven = z.infer<typeof CodeComprehensionGivenSchema>;

const name = z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,15}$/);
const range = { min: z.number().int().min(-50).max(50), max: z.number().int().min(-50).max(50), nonzero: z.boolean().optional() };

export const RecipeParamSchema = z.discriminatedUnion("kind", [
  z.object({ name, kind: z.literal("int"), ...range }),
  z.object({ name, kind: z.literal("matrix"), rows: z.number().int().min(1).max(4), cols: z.number().int().min(1).max(4), ...range }),
  z.object({ name, kind: z.literal("vector"), size: z.number().int().min(1).max(4), ...range }),
]);
export type RecipeParam = z.infer<typeof RecipeParamSchema>;

export const RecipeAnswerKindSchema = z.enum(["number", "expression", "matrix", "vector", "choice"]);
export type RecipeAnswerKind = z.infer<typeof RecipeAnswerKindSchema>;

const expr = z.string().min(1).max(300);

export const TemplateRecipeSchema = z.object({
  version: z.literal(1),
  /** Statement text, with `[[param]]` placeholders (filled with LaTeX). May use $…$. */
  statement: z.string().min(10).max(1200),
  params: z.array(RecipeParamSchema).min(1).max(8),
  /** Free variables that may appear in the answer (e.g. `x`). */
  variables: z.array(name).max(3).default([]),
  /** Boolean expressions over the parameters, e.g. `det(A) != 0`. */
  constraints: z.array(expr).max(8).default([]),
  answer: z.object({
    kind: RecipeAnswerKindSchema,
    /** For `choice`: index (from 0) of the correct option, e.g. with `cases(...)`. */
    expr,
    /** Only `choice`: the options, from 2 to 6. */
    choices: z.array(z.string().min(1).max(120)).min(2).max(6).optional(),
  }),
  errors: z
    .array(
      z.object({
        key: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
        description: z.string().min(5).max(300),
        expr,
      }),
    )
    .max(6)
    .default([]),
});
export type TemplateRecipe = z.infer<typeof TemplateRecipeSchema>;

/** Response of `POST /v1/recipes/validate` (eval). */
export const RecipeValidationSchema = z.object({
  ok: z.boolean(),
  problems: z.array(z.string()),
  droppedErrors: z.array(z.string()),
  stats: z.record(z.unknown()),
  samples: z.array(
    z.object({
      statement: z.string(),
      answerKind: RecipeAnswerKindSchema,
      choices: z.array(z.string()).nullable().optional(),
      shape: z.record(z.number()).nullable(),
      variables: z.array(z.string()),
      payload: z.record(z.unknown()),
    }),
  ),
  /** The normalized recipe without the discarded errors, if it passes. */
  recipe: z.record(z.unknown()).nullable(),
});
export type RecipeValidation = z.infer<typeof RecipeValidationSchema>;

/** What the student sees of a recipe instance (without solution or errors). */
export const RecipeClientPayloadSchema = z.object({
  recipeVersion: z.literal(1),
  statement: z.string(),
  answerKind: RecipeAnswerKindSchema,
  shape: z.record(z.number()).nullable(),
  variables: z.array(z.string()),
  /** Only `choice`. */
  choices: z.array(z.string()).nullable().optional(),
});
export type RecipeClientPayload = z.infer<typeof RecipeClientPayloadSchema>;
