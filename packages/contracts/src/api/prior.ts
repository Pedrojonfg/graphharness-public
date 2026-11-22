// Prior knowledge when importing material, and the syllabus per subject (ADR 105 §6, points 19, 20 and 22).
import { z } from "zod";
import { ConceptStateSchema, IdSchema, IsoDateTimeSchema } from "./common.ts";

export const PriorBucketSchema = z.enum(["known", "stale", "weak", "new"]);
export type PriorBucket = z.infer<typeof PriorBucketSchema>;

const bucketCounts = z.object({
  known: z.number().int().nonnegative(),
  stale: z.number().int().nonnegative(),
  weak: z.number().int().nonnegative(),
  new: z.number().int().nonnegative(),
});

const summaryFields = {
  id: IdSchema,
  subjectId: IdSchema,
  /** Imported paths (relative to the materials folder). */
  paths: z.array(z.string()),
  createdAt: IsoDateTimeSchema,
  total: z.number().int().nonnegative(),
  counts: bucketCounts,
  /** Integers that sum to 100 (0 everywhere if `total` is 0). */
  percentages: bucketCounts,
};

export const PriorReportItemSchema = z.object({
  propositionId: IdSchema,
  name: z.string(),
  bucket: PriorBucketSchema,
  relation: z.enum(["same", "related", "new"]),
  matchedConceptId: IdSchema.nullable(),
  matchedConceptName: z.string().nullable(),
});

export type PriorReportItem = z.infer<typeof PriorReportItemSchema>;

/** GET /prior-reports/:id and MCP `get_prior_knowledge`. */
export const PriorReportSchema = z.object({ ...summaryFields, items: z.array(PriorReportItemSchema) });
export type PriorReport = z.infer<typeof PriorReportSchema>;

export const PriorReportSummarySchema = z.object(summaryFields);
export type PriorReportSummary = z.infer<typeof PriorReportSummarySchema>;

export const PriorReportListQuerySchema = z.object({
  subjectId: IdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type PriorReportListQuery = z.infer<typeof PriorReportListQuerySchema>;
/** From most recent to oldest, without `items`. */
export const PriorReportListSchema = z.object({ reports: z.array(PriorReportSummarySchema) });

// ---------------------------------------------------------------- syllabus

export const SubjectIdParamsSchema = z.object({ subjectId: IdSchema });

export const PutSyllabusBodySchema = z.object({
  /** One topic per line; indentation = level; optional markers "- ", "* ", "1. ". Max 300 topics of 200 characters. */
  text: z.string().max(200_000),
});
export const PutSyllabusResponseSchema = z.object({ count: z.number().int().nonnegative(), errors: z.array(z.string()) });
export type PutSyllabusResponse = z.infer<typeof PutSyllabusResponseSchema>;

export const SyllabusItemSchema = z.object({
  id: IdSchema,
  position: z.number().int().nonnegative(),
  level: z.number().int().min(0).max(3),
  title: z.string(),
  seen: z.boolean(),
  /** Active concept of the subject that covers the topic (null if not seen). */
  conceptId: IdSchema.nullable(),
  conceptName: z.string().nullable(),
  state: ConceptStateSchema.nullable(),
  stale: z.boolean().nullable(),
});
export const SyllabusSchema = z.object({ items: z.array(SyllabusItemSchema) });
export type Syllabus = z.infer<typeof SyllabusSchema>;

export const GetSyllabusGapsOutputSchema = z.object({
  total: z.number().int().nonnegative(),
  seen: z.number().int().nonnegative(),
  unseen: z.array(z.object({ title: z.string(), level: z.number().int().min(0).max(3) })),
});
