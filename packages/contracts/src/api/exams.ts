// Exams (`exams` table, D12, P(prepared); `/exams` route, MCP `upsert_exam`/`list_exams`).
import { z } from "zod";
import { DateOnlySchema, IdSchema, IsoDateTimeSchema } from "./common.ts";

export const ExamSchema = z.object({
  id: IdSchema,
  subjectId: IdSchema,
  subjectName: z.string(),
  title: z.string(),
  date: DateOnlySchema,
  /** Empty = the whole subject. */
  scopeConceptIds: z.array(IdSchema),
  notes: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
  /** Calendar days until the date (negative if already past). */
  daysLeft: z.number().int(),
  /** `goalPreparedProbability` over the scope; null if the scope has no concepts. */
  preparedProbability: z.number().min(0).max(1).nullable(),
  /** `unknown` concepts in the scope (shown separately). */
  unknownCount: z.number().int().nonnegative(),
});
export type Exam = z.infer<typeof ExamSchema>;

/** GET /exams?subjectId&from&to — by ascending date. `from`/`to` inclusive (YYYY-MM-DD). */
export const ExamListQuerySchema = z.object({
  subjectId: IdSchema.optional(),
  from: DateOnlySchema.optional(),
  to: DateOnlySchema.optional(),
});
export type ExamListQuery = z.infer<typeof ExamListQuerySchema>;
export const ExamListSchema = z.array(ExamSchema);

const examFields = {
  title: z.string().trim().min(1).max(200),
  date: DateOnlySchema,
  scopeConceptIds: z.array(IdSchema).max(500),
  notes: z.string().max(5000),
};

/** POST /exams */
export const CreateExamBodySchema = z.object({
  subjectId: IdSchema,
  title: examFields.title,
  date: examFields.date,
  scopeConceptIds: examFields.scopeConceptIds.default([]),
  notes: examFields.notes.optional(),
});
export type CreateExamBody = z.infer<typeof CreateExamBodySchema>;

/** PATCH /exams/:id — the subject does not change. */
export const PatchExamBodySchema = z
  .object({
    title: examFields.title.optional(),
    date: examFields.date.optional(),
    scopeConceptIds: examFields.scopeConceptIds.optional(),
    notes: examFields.notes.nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, "empty body");
export type PatchExamBody = z.infer<typeof PatchExamBodySchema>;
