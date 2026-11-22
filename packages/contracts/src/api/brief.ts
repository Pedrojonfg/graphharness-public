// Daily brief (GET /brief?date and MCP `get_daily_brief`). Objects are strict so that nobody adds
// fields without changing the contract. Where the contract leaves it open: `subject`, `template` and `error` are
// readable NAMES (subject.name, template.name, error.description), because the brief is narrated; `conceptsTouched` carries `{conceptId, name}`.
import { z } from "zod";
import { ConceptStateSchema, DateOnlySchema, IdSchema, IsoDateTimeSchema } from "./common.ts";

/** GET /brief?date — defaults to today (VPS timezone). */
export const BriefQuerySchema = z.object({ date: DateOnlySchema.optional() });
export type BriefQuery = z.infer<typeof BriefQuerySchema>;

export const DailyBriefSchema = z
  .object({
    date: DateOnlySchema,
    examsSoon: z.array(
      z
        .object({
          title: z.string(),
          subject: z.string(),
          date: DateOnlySchema,
          daysLeft: z.number().int(),
          preparedProbability: z.number().min(0).max(1).nullable(),
          unknownCount: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    dueCards: z.object({ count: z.number().int().nonnegative(), confirmationPending: z.number().int().nonnegative() }).strict(),
    weakest: z.array(
      z
        .object({
          conceptId: IdSchema,
          name: z.string(),
          subject: z.string().nullable(),
          state: ConceptStateSchema,
          /** P' (with decay); null without evidence. */
          probability: z.number().min(0).max(1).nullable(),
          stale: z.boolean(),
          lastEvidenceAt: IsoDateTimeSchema.nullable(),
        })
        .strict(),
    ),
    yesterday: z.array(
      z
        .object({
          chatId: IdSchema,
          title: z.string(),
          conceptsTouched: z.array(z.object({ conceptId: IdSchema, name: z.string() }).strict()),
          /** ≤ 3 sentences of the report; null if there is no report yet. */
          highlights: z.string().nullable(),
        })
        .strict(),
    ),
    recurringErrors: z.array(z.object({ template: z.string(), error: z.string(), timesSeen: z.number().int().min(1) }).strict()),
    /** Deterministic (ADR 102 §9). */
    suggestedToday: z.array(
      z
        .object({
          kind: z.enum(["session", "cards", "exercises"]),
          conceptIds: z.array(IdSchema).min(1),
          why: z.string(),
        })
        .strict(),
    ),
  })
  .strict();
export type DailyBrief = z.infer<typeof DailyBriefSchema>;
