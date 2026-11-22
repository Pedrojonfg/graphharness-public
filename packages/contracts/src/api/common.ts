// Shared DTOs of the REST API and of the MCP. Route base: API_BASE.
import { z } from "zod";
import { CodeComprehensionClientPayloadSchema, RecipeClientPayloadSchema } from "../recipe.ts";

export const API_BASE = "/api/v1";

/** Hub IDs: TEXT (ULID except for some: `n_…` from LH, LH chatId). The format is never validated. */
export const IdSchema = z.string().min(1).max(200);

/** ISO 8601 date and time in UTC (`2026-11-09T08:00:00.000Z`), like `isoNow()`. */
export const IsoDateTimeSchema = z.string().datetime();

/** Calendar day `YYYY-MM-DD` (exams, brief). */
export const DateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date YYYY-MM-DD");

/** Concept states (D2). `unknown` = no evidence. */
export const ConceptStateSchema = z.enum(["solid", "review", "weak", "unknown"]);
export type ConceptState = z.infer<typeof ConceptStateSchema>;

/** States that can be declared by hand (GL-041). */
export const ManualTargetStateSchema = z.enum(["solid", "review", "weak"]);
export type ManualTargetState = z.infer<typeof ManualTargetStateSchema>;

export const ManualConfirmationSchema = z.enum(["pending", "confirmed"]);

/**
 * Effective state of a concept at an instant: `probability` is P' (with decay),
 * null if there is no evidence (then `state = "unknown"`).
 */
export const ConceptStateViewSchema = z.object({
  conceptId: IdSchema,
  state: ConceptStateSchema,
  probability: z.number().min(0).max(1).nullable(),
  /** `isEvidenceStaleForDiagnostic` from GL. */
  stale: z.boolean(),
  /** `pending` = unconfirmed declaration (dashed outline on the map). */
  manualConfirmation: ManualConfirmationSchema.nullable(),
  lastEvidenceAt: IsoDateTimeSchema.nullable(),
});
export type ConceptStateView = z.infer<typeof ConceptStateViewSchema>;

/**
 * Answer value of a `recipe_v1` instance, same as `userInput.result` in eval:
 * number or expression as text (or number), vector `string[]`, matrix `string[][]`,
 * choice as the option's text or an index from 0.
 */
export const AnswerValueSchema = z.union([
  z.string().max(200),
  z.number(),
  z.array(z.string().max(200)).max(16),
  z.array(z.array(z.string().max(200)).max(4)).max(4),
]);
export type AnswerValue = z.infer<typeof AnswerValueSchema>;

/** Weak prerequisite. `path` = concept ids [ancestor, …, declared concept]. */
export const WeakPrerequisiteSchema = z.object({
  conceptId: IdSchema,
  name: z.string(),
  state: ConceptStateSchema,
  path: z.array(IdSchema).min(2),
});
export type WeakPrerequisite = z.infer<typeof WeakPrerequisiteSchema>;

/**
 * Template instance as the client sees it (`instances.client_json`). STRICT: rejects
 * any solution field (`answer`, `errors`, `mcq`, `params` of `payload_json`), which never leaves the Hub.
 */
export const ClientInstanceSchema = z.union([RecipeClientPayloadSchema.strict(), CodeComprehensionClientPayloadSchema]);
export type ClientInstance = z.infer<typeof ClientInstanceSchema>;

export function isRecipeClientInstance(
  i: ClientInstance,
): i is z.infer<typeof RecipeClientPayloadSchema> {
  return "recipeVersion" in i && i.recipeVersion === 1;
}

export function isCodeClientInstance(
  i: ClientInstance,
): i is z.infer<typeof CodeComprehensionClientPayloadSchema> {
  return "comprehensionVersion" in i && i.comprehensionVersion === 1;
}

/** MCQ option as the client sees it: it does not say whether it is the right one or which error it comes from. */
export const McqOptionSchema = z.object({ id: IdSchema, value: AnswerValueSchema }).strict();
export type McqOption = z.infer<typeof McqOptionSchema>;

// ---------------------------------------------------------------- errors

/** Any Hub error: `error` is a machine code in snake_case. */
export const ApiErrorSchema = z.object({
  error: z.string().min(1),
  /** Human-readable text, if any. */
  message: z.string().optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

/** 400: params, query or body do not pass the schema. */
export const InvalidRequestErrorSchema = z.object({
  error: z.literal("invalid_request"),
  issues: z.array(z.object({ path: z.array(z.union([z.string(), z.number()])), message: z.string() })),
});
export type InvalidRequestError = z.infer<typeof InvalidRequestErrorSchema>;

/** 404 */
export const NotFoundErrorSchema = z.object({ error: z.literal("not_found") });
export type NotFoundError = z.infer<typeof NotFoundErrorSchema>;

/** 409 for a manual change without `ackWeakPrerequisites` (GL-041). */
export const WeakPrerequisitesErrorSchema = z.object({
  error: z.literal("weak_prerequisites"),
  weakPrerequisites: z.array(WeakPrerequisiteSchema).min(1),
});
export type WeakPrerequisitesError = z.infer<typeof WeakPrerequisitesErrorSchema>;

/** Generic 409 with a code (`already_answered`, `override_window_passed`…). */
export const ConflictErrorSchema = ApiErrorSchema;

/**
 * 503 from LH with no model configured. The LH envelope is forwarded AS IS
 * (`LH:src/core/settings.ts` `ModelsNotConfigured`): there `error` is readable text and the code goes in `code`.
 */
export const ModelsNotConfiguredErrorSchema = z.object({
  error: z.string(),
  code: z.literal("models_not_configured"),
  missing: z.array(z.string()),
});
export type ModelsNotConfiguredError = z.infer<typeof ModelsNotConfiguredErrorSchema>;

/** 502/503 when LH, eval or the LLM do not respond. */
export const UpstreamErrorSchema = z.object({
  error: z.enum(["lh_unavailable", "eval_unavailable", "llm_unavailable", "llm_bad_output"]),
  message: z.string().optional(),
});
export type UpstreamError = z.infer<typeof UpstreamErrorSchema>;

// ---------------------------------------------------------------- route params

export const IdParamsSchema = z.object({ id: IdSchema });
export const ChatIdParamsSchema = z.object({ chatId: IdSchema });
export const InstanceIdParamsSchema = z.object({ instanceId: IdSchema });

/** Absolute path on the VPS, without `..` segments (the Hub also restricts it to the materials folder). */
export const MaterialPathSchema = z
  .string()
  .min(2)
  .max(1024)
  .regex(/^\/[^\0]*$/, "absolute path")
  .refine((p) => !p.split("/").includes(".."), "no '..' segments");
