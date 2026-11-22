// LH agent tools over the Hub (ADR 105 §5, points 15–16): GET /errors (hub_errors), GET /profile
// (hub_profile) and POST /capture (hub_capture). No auth, like /mastery (ADR 104).
import { z } from "zod";
import { IdSchema, IsoDateTimeSchema } from "./common.ts";

/** Up to 100 concept ids separated by commas, and/or free text. At least one of the two (the service checks it). */
export const ErrorsQuerySchema = z.object({
  conceptIds: z
    .string()
    .optional()
    .transform((s) => [...new Set((s ?? "").split(",").map((x) => x.trim()).filter(Boolean))])
    .pipe(z.array(z.string().max(200)).max(100)),
  query: z.string().trim().min(1).max(500).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});
export type ErrorsQuery = z.infer<typeof ErrorsQuerySchema>;

/** Typical error (from a recipe or personal) of the active template of a live concept. */
export const ErrorViewSchema = z.object({
  conceptId: IdSchema,
  conceptName: z.string(),
  templateId: IdSchema,
  errorKey: z.string(),
  description: z.string(),
  origin: z.enum(["recipe", "personal"]),
  timesSeen: z.number().int().nonnegative(),
  lastSeenAt: IsoDateTimeSchema.nullable(),
});
export type ErrorView = z.infer<typeof ErrorViewSchema>;

export const ErrorsResponseSchema = z.object({ errors: z.array(ErrorViewSchema) });
export type ErrorsResponse = z.infer<typeof ErrorsResponseSchema>;

export const MissClassSchema = z.enum(["cue", "discrimination", "execution", "careless", "structural"]);
export type MissClass = z.infer<typeof MissClassSchema>;

export const CalibrationRowSchema = z.object({
  subjectId: IdSchema,
  subjectName: z.string(),
  /** Events with confidence in the 90-day window. */
  n: z.number().int().positive(),
  /** Mean of the declared confidence (0–100), 1 decimal. */
  meanConfidence: z.number().min(0).max(100),
  /** Fraction of successes (0–1), 3 decimals. */
  accuracy: z.number().min(0).max(1),
  /** Failures with confidence ≥ 75. */
  overconfidentWrong: z.number().int().nonnegative(),
  /** Successes with confidence ≤ 25. */
  underconfidentRight: z.number().int().nonnegative(),
});

export const ProfileSchema = z.object({
  /** The 5 errors with the most repetitions (timesSeen ≥ 2). */
  recurringErrors: z.array(ErrorViewSchema).max(5),
  /** LH practice failures by class in the last 90 days. */
  missClassCounts: z.object({
    cue: z.number().int().nonnegative(),
    discrimination: z.number().int().nonnegative(),
    execution: z.number().int().nonnegative(),
    careless: z.number().int().nonnegative(),
    structural: z.number().int().nonnegative(),
  }),
  calibration: z.array(CalibrationRowSchema),
});
export type Profile = z.infer<typeof ProfileSchema>;

/** Target: exactly one of `conceptId` / `conceptQuery` (checked by the `refine` below). */
const target = { conceptId: IdSchema.optional(), conceptQuery: z.string().trim().min(1).max(500).optional() };
const NoteCaptureSchema = z.object({ kind: z.literal("note"), ...target, text: z.string().min(1).max(2000) });
const CardCaptureSchema = z.object({
  kind: z.literal("card"),
  ...target,
  /** LH capture: only cloze/text (not parsons/predict/spot_bug/mcq). */
  type: z.enum(["cloze", "text"]),
  front: z.string().min(1).max(2000),
  answer: z.string().min(1),
});
/** The card rules (answer ≤ 60, `$` in pairs…) are applied by the service with `validateDraft`. */
export const CaptureBodySchema = z
  .discriminatedUnion("kind", [NoteCaptureSchema, CardCaptureSchema])
  .refine((b) => (b.conceptId === undefined) !== (b.conceptQuery === undefined), "provide conceptId or conceptQuery, not both");
export type CaptureBody = z.infer<typeof CaptureBodySchema>;

export const CaptureResponseSchema = z.object({
  kind: z.enum(["note", "card"]),
  id: IdSchema,
  conceptId: IdSchema,
  conceptName: z.string(),
});
export type CaptureResponse = z.infer<typeof CaptureResponseSchema>;
