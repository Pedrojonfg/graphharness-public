// "Lens" votes per core node (ADR 109 §6–7): POST /lens-feedback (LH's hub_lens_feedback), GET /lens-feedback
// and MCP list_lens_feedback. No auth, like /capture (ADR 104).
import { z } from "zod";
import { IdSchema, IsoDateTimeSchema } from "./common.ts";

/** Target: exactly one of `conceptId` / `conceptQuery` (the POST checks it with `refine`; the query and the MCP, the service). */
const target = { conceptId: IdSchema.optional(), conceptQuery: z.string().trim().min(1).max(500).optional() };

/** GET query and list_lens_feedback input: plain object (MCP requires it); "exactly one" is checked by the service. */
export const LensFeedbackQuerySchema = z.object(target);
export type LensFeedbackQuery = z.infer<typeof LensFeedbackQuerySchema>;

export const LensVoteSchema = z.object({ label: z.string().trim().min(1).max(200), liked: z.boolean() });

/** If a label is repeated in `lenses`, the last one wins. */
export const LensFeedbackBodySchema = z
  .object({
    ...target,
    chatId: z.string().min(1).max(200),
    nodeId: z.string().min(1).max(100),
    lenses: z.array(LensVoteSchema).min(1).max(12),
  })
  .refine((b) => (b.conceptId === undefined) !== (b.conceptQuery === undefined), "provide conceptId or conceptQuery, not both");
export type LensFeedbackBody = z.infer<typeof LensFeedbackBodySchema>;

export const LensFeedbackSavedSchema = z.object({
  /** Distinct lenses written. */
  saved: z.number().int().positive(),
  conceptId: IdSchema,
  conceptName: z.string(),
});
export type LensFeedbackSaved = z.infer<typeof LensFeedbackSavedSchema>;

/** Votes aggregated by label over all chats and nodes of the concept: likedCount desc, shownCount desc, label asc. */
export const LensFeedbackListSchema = z.object({
  conceptId: IdSchema,
  conceptName: z.string(),
  lenses: z.array(
    z.object({
      label: z.string(),
      likedCount: z.number().int().nonnegative(),
      shownCount: z.number().int().positive(),
      lastAt: IsoDateTimeSchema,
    }),
  ),
});
export type LensFeedbackList = z.infer<typeof LensFeedbackListSchema>;
