// Mastery per proposition for the P3a patch of the LH fork (GET /mastery). ADR 104.
import { z } from "zod";
import { ConceptStateSchema, IdSchema, IsoDateTimeSchema } from "./common.ts";

/** Up to 100 LH proposition ids (`n_…`) separated by commas, and/or free text to search concepts. At least one of the two (the service checks it). */
export const MasteryQuerySchema = z.object({
  propositionIds: z
    .string()
    .optional()
    .transform((s) => [...new Set((s ?? "").split(",").map((x) => x.trim()).filter(Boolean))])
    .pipe(z.array(z.string().max(100)).max(100)),
  query: z.string().trim().min(1).max(500).optional(),
});
export type MasteryQuery = z.infer<typeof MasteryQuerySchema>;

export const MasteryConceptSchema = z.object({
  conceptId: IdSchema,
  name: z.string(),
  state: ConceptStateSchema,
  /** Stale evidence (`isEvidenceStaleForDiagnostic` from GL): it has to be checked again. */
  stale: z.boolean(),
  lastEvidenceAt: IsoDateTimeSchema.nullable(),
  /** Whole days since the last evidence; null if there is none. */
  ageDays: z.number().int().nonnegative().nullable(),
  /** The requested propositions that belong to this concept (empty if the concept came from `query`). */
  propositionIds: z.array(z.string()),
});

export const MasterySchema = z.object({
  concepts: z.array(MasteryConceptSchema),
  /** Requested ids that the Hub does not know or that have no concept (not yet synced/curated): LH treats them as `unknown`. */
  unmappedPropositionIds: z.array(z.string()),
});
export type Mastery = z.infer<typeof MasterySchema>;
