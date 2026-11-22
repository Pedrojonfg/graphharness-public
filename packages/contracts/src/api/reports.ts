// Session reports and master document (D11, GL-019/029/058; `/reports` route).
// Inspired by graphlearn/packages/contracts/src/reports.ts (65b56d6). `data` = `reports.data_json`.
import { z } from "zod";
import { ConceptStateSchema, DateOnlySchema, IdSchema, IsoDateTimeSchema, ManualTargetStateSchema } from "./common.ts";
import { EvidenceSourceSchema } from "./concepts.ts";

export const ReportKindSchema = z.enum(["session", "master"]);
export type ReportKind = z.infer<typeof ReportKindSchema>;

/** Section omitted from the PDF (unverified formula, TikZ > 8000 or that does not compile; GL-058). */
export const OmittedSectionSchema = z.object({ sectionKey: z.string(), reason: z.string() });

const conceptRef = { conceptId: IdSchema, name: z.string() };

/** Session report data (step 5). `text` is the part written by the LLM. */
export const SessionReportDataSchema = z.object({
  schemaVersion: z.literal(1),
  chatId: IdSchema,
  title: z.string(),
  subjectId: IdSchema.nullable(),
  subjectName: z.string().nullable(),
  closedAt: IsoDateTimeSchema,
  conceptsTouched: z.array(
    z.object({
      ...conceptRef,
      before: ConceptStateSchema,
      after: ConceptStateSchema,
      probabilityBefore: z.number().min(0).max(1).nullable(),
      probabilityAfter: z.number().min(0).max(1).nullable(),
    }),
  ),
  questions: z.array(
    z.object({
      source: EvidenceSourceSchema,
      conceptId: IdSchema.nullable(),
      correct: z.boolean().nullable(),
      at: IsoDateTimeSchema,
    }),
  ),
  practices: z.array(
    z.object({
      conceptIds: z.array(IdSchema),
      outcome: z.string(),
      verdict: z.string().nullable(),
    }),
  ),
  errors: z.array(z.object({ templateId: IdSchema, errorKey: z.string(), description: z.string(), times: z.number().int().min(1) })),
  declarations: z.array(
    z.object({ declarationId: IdSchema, ...conceptRef, targetState: ManualTargetStateSchema, status: z.enum(["pending", "confirmed", "refuted", "expired"]) }),
  ),
  cardsCreated: z.number().int().nonnegative(),
  /** The 3 weak/review concepts of the subject with the most dependents. */
  nextRecommendation: z.array(z.object({ ...conceptRef, state: ConceptStateSchema, dependents: z.number().int().nonnegative() })),
  /** null if the LLM failed: the report is saved with data only. */
  text: z
    .object({
      summary: z.string(),
      reviewMaterial: z.array(z.object({ title: z.string(), body: z.string() })),
      mistakes: z.array(z.object({ mistake: z.string(), correction: z.string() })),
    })
    .nullable(),
  verifiedFormulas: z.array(z.object({ label: z.string(), latex: z.string() })),
});
export type SessionReportData = z.infer<typeof SessionReportDataSchema>;

/** Master document data for a subject (step 6). */
export const MasterReportDataSchema = z.object({
  schemaVersion: z.literal(1),
  subjectId: IdSchema,
  subjectName: z.string(),
  generatedAt: IsoDateTimeSchema,
  /** Review frontier: concepts whose prerequisites are solid and they are not. */
  reviewFrontier: z.array(z.object({ ...conceptRef, state: ConceptStateSchema })),
  weakAndReview: z.array(z.object({ ...conceptRef, state: ConceptStateSchema, probability: z.number().min(0).max(1).nullable(), stale: z.boolean() })),
  /** "Errors you repeat most" (`times_seen`). */
  recurringErrors: z.array(
    z.object({ templateId: IdSchema, templateName: z.string(), errorKey: z.string(), description: z.string(), timesSeen: z.number().int().min(1), lastSeenAt: IsoDateTimeSchema.nullable() }),
  ),
  /** Unknown errors not promoted ("failures without a pattern"). */
  unpatternedFailures: z.number().int().nonnegative(),
  consolidated: z.array(z.object(conceptRef)),
  upcomingExams: z.array(
    z.object({ examId: IdSchema, title: z.string(), date: DateOnlySchema, daysLeft: z.number().int(), preparedProbability: z.number().min(0).max(1).nullable(), unknownCount: z.number().int().nonnegative() }),
  ),
});
export type MasterReportData = z.infer<typeof MasterReportDataSchema>;

const reportBase = {
  id: IdSchema,
  createdAt: IsoDateTimeSchema,
  /** A compiled PDF exists (GET /reports/:id/pdf). */
  hasPdf: z.boolean(),
  omitted: z.array(OmittedSectionSchema),
};

export const ReportSummarySchema = z.discriminatedUnion("kind", [
  z.object({ ...reportBase, kind: z.literal("session"), chatId: IdSchema, subjectId: IdSchema.nullable(), title: z.string() }),
  z.object({ ...reportBase, kind: z.literal("master"), chatId: z.null(), subjectId: IdSchema, title: z.string() }),
]);
export type ReportSummary = z.infer<typeof ReportSummarySchema>;

/** GET /reports?kind&subjectId — from most recent to oldest. */
export const ReportListQuerySchema = z.object({
  kind: ReportKindSchema.optional(),
  subjectId: IdSchema.optional(),
});
export type ReportListQuery = z.infer<typeof ReportListQuerySchema>;
export const ReportListSchema = z.array(ReportSummarySchema);

/** GET /reports/:id and MCP `get_session_report` (without the .tex or the PDF). */
export const SessionReportSchema = z.object({
  ...reportBase,
  kind: z.literal("session"),
  chatId: IdSchema,
  subjectId: IdSchema.nullable(),
  title: z.string(),
  data: SessionReportDataSchema,
});
export type SessionReport = z.infer<typeof SessionReportSchema>;
export const MasterReportSchema = z.object({
  ...reportBase,
  kind: z.literal("master"),
  chatId: z.null(),
  subjectId: IdSchema,
  title: z.string(),
  data: MasterReportDataSchema,
});
export type MasterReport = z.infer<typeof MasterReportSchema>;
export const ReportSchema = z.discriminatedUnion("kind", [SessionReportSchema, MasterReportSchema]);
export type Report = z.infer<typeof ReportSchema>;

/**
 * POST /reports/:id/render — compiles the .tex (on demand) and responds when there is a PDF.
 * 422 `latex_failed` if it does not compile, not even omitting sections.
 */
export const RenderReportResponseSchema = z.object({
  reportId: IdSchema,
  /** Path on the VPS (the one `render_pdf` returns). */
  path: z.string(),
  /** `GET /api/v1/reports/:id/pdf`. */
  pdfUrl: z.string(),
  omitted: z.array(OmittedSectionSchema),
});
export type RenderReportResponse = z.infer<typeof RenderReportResponseSchema>;
