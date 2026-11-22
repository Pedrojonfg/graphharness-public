// Route table of the REST API. Single source for the hub (validation) and for the OpenAPI.
// `path` in Hono style (`:id`), relative to API_BASE (`/api/v1`).
import type { z } from "zod";
import { BriefQuerySchema, DailyBriefSchema } from "./brief.ts";
import { PlanQuerySchema, WeekPlanSchema } from "./plan.ts";
import {
  CardImportBodySchema,
  CardImportResponseSchema,
  CardQueueQuerySchema,
  CardQueueSchema,
  CardRetireResponseSchema,
  CardReviewBodySchema,
  CardReviewResponseSchema,
} from "./cards.ts";
import {
  ApiErrorSchema,
  ChatIdParamsSchema,
  IdParamsSchema,
  InstanceIdParamsSchema,
  InvalidRequestErrorSchema,
  NotFoundErrorSchema,
  ModelsNotConfiguredErrorSchema,
  UpstreamErrorSchema,
  WeakPrerequisitesErrorSchema,
} from "./common.ts";
import {
  AcceptSuggestionResponseSchema,
  AddConceptNoteBodySchema,
  ConceptDetailSchema,
  DismissSuggestionResponseSchema,
  ConceptSuggestionListSchema,
  ConceptSuggestionsQuerySchema,
  DeclarationRecordedSchema,
  MergeConceptsBodySchema,
  MergeConceptsResponseSchema,
  NoteSchema,
  PatchConceptBodySchema,
  PatchConceptEdgesBodySchema,
  PatchConceptEdgesResponseSchema,
  PatchConceptStateBodySchema,
  SplitConceptBodySchema,
  SplitConceptResponseSchema,
} from "./concepts.ts";
import {
  ImportClassNotesBodySchema,
  ImportClassNotesResponseSchema,
  ImportMaterialBodySchema,
  ImportMaterialResponseSchema,
  MaterialsListSchema,
} from "./materials.ts";
import {
  ResolveConceptsBodySchema,
  ResolveConceptsResponseSchema,
  SearchKnowledgeBodySchema,
  SearchKnowledgeResponseSchema,
} from "./search.ts";
import {
  CreateDiagnosticBodySchema,
  DiagnosticAnswerBodySchema,
  DiagnosticAnswerResponseSchema,
  DiagnosticStateSchema,
} from "./diagnostics.ts";
import { CreateExamBodySchema, ExamListQuerySchema, ExamListSchema, ExamSchema, PatchExamBodySchema } from "./exams.ts";
import {
  CreateExerciseBodySchema,
  ExerciseAttemptBodySchema,
  ExerciseAttemptResponseSchema,
  ExerciseExplainBodySchema,
  ExerciseExplanationSchema,
  ExerciseHintResponseSchema,
  ExerciseSchema,
} from "./exercises.ts";
import { HealthSchema } from "./health.ts";
import { InboxSchema } from "./inbox.ts";
import { LlmUsageQuerySchema, LlmUsageSchema } from "./llm-usage.ts";
import { MasteryQuerySchema, MasterySchema } from "./mastery.ts";
import { CaptureBodySchema, CaptureResponseSchema, ErrorsQuerySchema, ErrorsResponseSchema, ProfileSchema } from "./agent-tools.ts";
import { LensFeedbackBodySchema, LensFeedbackListSchema, LensFeedbackQuerySchema, LensFeedbackSavedSchema } from "./lens-feedback.ts";
import {
  GetSyllabusGapsOutputSchema,
  PriorReportListQuerySchema,
  PriorReportListSchema,
  PriorReportSchema,
  PutSyllabusBodySchema,
  PutSyllabusResponseSchema,
  SubjectIdParamsSchema,
  SyllabusSchema,
} from "./prior.ts";
import {
  RenderReportResponseSchema,
  ReportListQuerySchema,
  ReportListSchema,
  ReportSchema,
} from "./reports.ts";
import {
  CloseSessionResponseSchema,
  SessionListQuerySchema,
  SessionListSchema,
  StartSessionBodySchema,
  StartSessionResponseSchema,
} from "./sessions.ts";
import {
  CreateSubjectBodySchema,
  PatchSubjectBodySchema,
  SubjectListSchema,
  SubjectMapSchema,
  SubjectOverviewSchema,
  SubjectSchema,
} from "./subjects.ts";

export type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

export interface ApiResponseSpec {
  /** Possible `error` codes in error responses (`not_found`, `weak_prerequisites`…). */
  description: string;
  /** No schema = no body (204) or binary (see `contentType`). */
  schema?: z.ZodTypeAny;
  /** Default `application/json`. */
  contentType?: string;
}

export interface ApiRoute {
  method: HttpMethod;
  path: string;
  summary: string;
  params?: z.AnyZodObject;
  query?: z.AnyZodObject;
  body?: z.ZodTypeAny;
  responses: Record<number, ApiResponseSpec>;
}

const invalid: ApiResponseSpec = { description: "invalid_request", schema: InvalidRequestErrorSchema };
const notFound: ApiResponseSpec = { description: "not_found", schema: NotFoundErrorSchema };
const conflict = (codes: string): ApiResponseSpec => ({ description: codes, schema: ApiErrorSchema });
const evalDown: ApiResponseSpec = { description: "eval_unavailable", schema: UpstreamErrorSchema };
const llmDown: ApiResponseSpec = { description: "llm_unavailable | llm_bad_output", schema: UpstreamErrorSchema };
const ok = (description: string, schema: z.ZodTypeAny): ApiResponseSpec => ({ description, schema });

export const API_ROUTES: readonly ApiRoute[] = [
  // ------------------------------------------------------------ subjects
  { method: "get", path: "/subjects", summary: "Subjects (including archived ones)", responses: { 200: ok("List", SubjectListSchema) } },
  {
    method: "post",
    path: "/subjects",
    summary: "Create subject",
    body: CreateSubjectBodySchema,
    responses: { 201: ok("Created", SubjectSchema), 400: invalid, 409: conflict("slug_taken") },
  },
  {
    method: "patch",
    path: "/subjects/:id",
    summary: "Edit or archive subject",
    params: IdParamsSchema,
    body: PatchSubjectBodySchema,
    responses: { 200: ok("Updated", SubjectSchema), 400: invalid, 404: notFound, 409: conflict("slug_taken") },
  },
  {
    method: "get",
    path: "/subjects/:id/map",
    summary: "Concepts + edges + effective states (Map)",
    params: IdParamsSchema,
    responses: { 200: ok("Map", SubjectMapSchema), 404: notFound },
  },
  {
    method: "get",
    path: "/subjects/:id/overview",
    summary: "Subject overview (parity with MCP get_subject_overview)",
    params: IdParamsSchema,
    responses: { 200: ok("Overview", SubjectOverviewSchema), 404: notFound },
  },
  {
    method: "post",
    path: "/knowledge/search",
    summary: "FTS search of concepts and propositions (parity with MCP search_knowledge)",
    body: SearchKnowledgeBodySchema,
    responses: { 200: ok("Results", SearchKnowledgeResponseSchema), 400: invalid },
  },
  {
    method: "post",
    path: "/knowledge/resolve",
    summary: "Resolve text to candidate concepts (parity with MCP resolve_concepts)",
    body: ResolveConceptsBodySchema,
    responses: { 200: ok("Candidates", ResolveConceptsResponseSchema), 400: invalid, 502: llmDown },
  },
  // ------------------------------------------------------------ concepts
  {
    method: "get",
    path: "/concepts/:id",
    summary: "Detail: propositions, templates, state, recent events, notes, errors",
    params: IdParamsSchema,
    responses: { 200: ok("Detail", ConceptDetailSchema), 404: notFound },
  },
  {
    method: "post",
    path: "/concepts/:id/notes",
    summary: "Add a free-form note to the concept (parity with MCP add_concept_note)",
    params: IdParamsSchema,
    body: AddConceptNoteBodySchema,
    responses: { 201: ok("Note", NoteSchema), 400: invalid, 404: notFound },
  },
  {
    method: "patch",
    path: "/concepts/:id/state",
    summary: "Manual change from the PWA (same flow as declare_learning, origin = 'pwa')",
    params: IdParamsSchema,
    body: PatchConceptStateBodySchema,
    responses: {
      200: ok("Declaration recorded (pending) with confirmation items", DeclarationRecordedSchema),
      400: invalid,
      404: notFound,
      409: { description: "weak_prerequisites: repeat with ackWeakPrerequisites: true", schema: WeakPrerequisitesErrorSchema },
    },
  },
  {
    method: "post",
    path: "/concepts/:id/merge",
    summary: "Merge sourceIds into this concept (target)",
    params: IdParamsSchema,
    body: MergeConceptsBodySchema,
    responses: { 200: ok("Merged", MergeConceptsResponseSchema), 400: invalid, 404: notFound, 409: conflict("invalid_merge") },
  },
  {
    method: "post",
    path: "/concepts/:id/split",
    summary: "Split the concept into new parts",
    params: IdParamsSchema,
    body: SplitConceptBodySchema,
    responses: { 201: ok("Split", SplitConceptResponseSchema), 400: invalid, 404: notFound, 409: conflict("invalid_split") },
  },
  {
    method: "patch",
    path: "/concepts/:id",
    summary: "Edit concept (name, description, subject, flags, state, propositions)",
    params: IdParamsSchema,
    body: PatchConceptBodySchema,
    responses: { 200: ok("Updated", ConceptDetailSchema), 400: invalid, 404: notFound },
  },
  {
    method: "patch",
    path: "/concept-edges",
    summary: "Add or remove edges with justification",
    body: PatchConceptEdgesBodySchema,
    responses: { 200: ok("Applied", PatchConceptEdgesResponseSchema), 400: invalid, 404: notFound, 409: conflict("cycle") },
  },
  {
    method: "get",
    path: "/concept-suggestions",
    summary: "Curator merge/split suggestions",
    query: ConceptSuggestionsQuerySchema,
    responses: { 200: ok("List", ConceptSuggestionListSchema), 400: invalid },
  },
  {
    method: "post",
    path: "/concept-suggestions/:id/accept",
    summary: "Accept (apply) a suggestion",
    params: IdParamsSchema,
    responses: { 200: ok("Applied", AcceptSuggestionResponseSchema), 404: notFound, 409: conflict("not_open | invalid_merge | invalid_split") },
  },
  {
    method: "post",
    path: "/concept-suggestions/:id/dismiss",
    summary: "Dismiss a suggestion",
    params: IdParamsSchema,
    responses: { 200: ok("Suggestion dismissed", DismissSuggestionResponseSchema), 404: notFound, 409: conflict("not_open") },
  },
  {
    method: "get",
    path: "/inbox",
    summary: "Inbox: no subject, open suggestions, failed templates, unknown errors, orphan concepts",
    responses: { 200: ok("Inbox", InboxSchema) },
  },
  // ------------------------------------------------------------ cards
  {
    method: "get",
    path: "/cards/queue",
    summary: "Infinite queue (confirmation cards first)",
    query: CardQueueQuerySchema,
    responses: { 200: ok("Queue", CardQueueSchema), 400: invalid },
  },
  {
    method: "post",
    path: "/cards/:id/review",
    summary: "Review: {correct, responseMs, override?, given?}",
    params: IdParamsSchema,
    body: CardReviewBodySchema,
    responses: {
      200: ok("Review recorded", CardReviewResponseSchema),
      400: invalid,
      404: notFound,
      409: conflict("nothing_to_override | override_window_passed | given_required | already_answered"),
      502: evalDown,
    },
  },
  {
    method: "post",
    path: "/cards/:id/retire",
    summary: "Retire card from the queue (soft; idempotent)",
    params: IdParamsSchema,
    responses: { 200: ok("Retired", CardRetireResponseSchema), 404: notFound },
  },
  {
    method: "post",
    path: "/cards/import",
    summary: "Import JSON append-only (GL format)",
    body: CardImportBodySchema,
    responses: { 201: ok("Imported", CardImportResponseSchema), 400: invalid },
  },
  // ------------------------------------------------------------ exercises
  {
    method: "post",
    path: "/exercises",
    summary: "New instance of a template, or of a concept's active one (without solution)",
    body: CreateExerciseBodySchema,
    responses: { 201: ok("Instance", ExerciseSchema), 400: invalid, 404: notFound, 409: conflict("template_not_active"), 502: evalDown },
  },
  {
    method: "post",
    path: "/exercises/:instanceId/attempt",
    summary: "Grade an attempt (eval)",
    params: InstanceIdParamsSchema,
    body: ExerciseAttemptBodySchema,
    responses: { 200: ok("Graded", ExerciseAttemptResponseSchema), 400: invalid, 404: notFound, 409: conflict("exercise_finished"), 502: evalDown },
  },
  {
    method: "post",
    path: "/exercises/:instanceId/hint",
    summary: "Hint",
    params: InstanceIdParamsSchema,
    responses: { 200: ok("Hint", ExerciseHintResponseSchema), 404: notFound, 409: conflict("exercise_finished"), 502: llmDown },
  },
  {
    method: "post",
    path: "/exercises/:instanceId/explain",
    summary: "Instant explanation with verified formulas",
    params: InstanceIdParamsSchema,
    body: ExerciseExplainBodySchema,
    responses: { 200: ok("Explanation", ExerciseExplanationSchema), 400: invalid, 404: notFound, 409: conflict("no_attempt"), 502: llmDown },
  },
  // ------------------------------------------------------------ diagnostics
  {
    method: "post",
    path: "/diagnostics",
    summary: "Open an exam diagnostic (or return the open one)",
    body: CreateDiagnosticBodySchema,
    responses: { 201: ok("Status", DiagnosticStateSchema), 400: invalid, 404: notFound, 502: evalDown },
  },
  {
    method: "post",
    path: "/diagnostics/:id/answer",
    summary: "Answer the pending question",
    params: IdParamsSchema,
    body: DiagnosticAnswerBodySchema,
    responses: {
      200: ok("Graded; includes the next state", DiagnosticAnswerResponseSchema),
      400: invalid,
      404: notFound,
      409: conflict("already_answered | diagnostic_finished | wrong_format"),
      502: evalDown,
    },
  },
  // ------------------------------------------------------------ exams
  {
    method: "get",
    path: "/exams",
    summary: "Exams with P(prepared)",
    query: ExamListQuerySchema,
    responses: { 200: ok("List", ExamListSchema), 400: invalid },
  },
  {
    method: "post",
    path: "/exams",
    summary: "Create exam",
    body: CreateExamBodySchema,
    responses: { 201: ok("Created", ExamSchema), 400: invalid, 404: notFound },
  },
  {
    method: "patch",
    path: "/exams/:id",
    summary: "Edit exam",
    params: IdParamsSchema,
    body: PatchExamBodySchema,
    responses: { 200: ok("Updated", ExamSchema), 400: invalid, 404: notFound },
  },
  {
    method: "delete",
    path: "/exams/:id",
    summary: "Delete exam",
    params: IdParamsSchema,
    responses: { 204: { description: "Deleted" }, 404: notFound },
  },
  // ------------------------------------------------------------ LH sessions
  {
    method: "get",
    path: "/sessions",
    summary: "Mirrored LH sessions",
    query: SessionListQuerySchema,
    responses: { 200: ok("List", SessionListSchema), 400: invalid },
  },
  {
    method: "post",
    path: "/sessions",
    summary: "Open LH session (like start_session) — Today button",
    body: StartSessionBodySchema,
    responses: {
      201: ok("Session created", StartSessionResponseSchema),
      400: invalid,
      404: notFound,
      502: { description: "lh_unavailable", schema: UpstreamErrorSchema },
      503: { description: "models_not_configured (LH envelope as is)", schema: ModelsNotConfiguredErrorSchema },
    },
  },
  {
    method: "post",
    path: "/sessions/:chatId/close",
    summary: "Close session (queues session-close)",
    params: ChatIdParamsSchema,
    responses: { 202: ok("Queued (idempotent)", CloseSessionResponseSchema), 404: notFound },
  },
  // ------------------------------------------------------------ reports
  {
    method: "get",
    path: "/reports",
    summary: "Session and master reports",
    query: ReportListQuerySchema,
    responses: { 200: ok("List", ReportListSchema), 400: invalid },
  },
  {
    method: "get",
    path: "/reports/:id",
    summary: "Report (data + text)",
    params: IdParamsSchema,
    responses: { 200: ok("Report", ReportSchema), 404: notFound },
  },
  {
    method: "post",
    path: "/reports/:id/render",
    summary: "Compile the PDF on demand",
    params: IdParamsSchema,
    responses: { 200: ok("PDF ready", RenderReportResponseSchema), 404: notFound, 422: conflict("latex_failed") },
  },
  {
    method: "get",
    path: "/reports/:id/pdf",
    summary: "Download the PDF",
    params: IdParamsSchema,
    responses: { 200: { description: "PDF", contentType: "application/pdf" }, 404: notFound, 409: conflict("not_rendered") },
  },
  // ------------------------------------------------------------ brief and health
  {
    method: "get",
    path: "/brief",
    summary: "Daily brief",
    query: BriefQuerySchema,
    responses: { 200: ok("Brief", DailyBriefSchema), 400: invalid },
  },
  {
    method: "get",
    path: "/plan",
    summary: "N-day plan between sessions, deterministic and without LLM (ADR 105 §7)",
    query: PlanQuerySchema,
    responses: { 200: ok("Plan", WeekPlanSchema), 400: invalid },
  },
  {
    method: "get",
    path: "/llm-usage",
    summary: "LLM usage by task, provider and model (Settings, R4)",
    query: LlmUsageQuerySchema,
    responses: { 200: ok("Summary", LlmUsageSchema), 400: invalid },
  },
  {
    method: "get",
    path: "/mastery",
    summary: "State, age and expiry of the concepts of some LH propositions (hub_mastery tool, P3a)",
    query: MasteryQuerySchema,
    responses: { 200: ok("Concepts", MasterySchema), 400: invalid },
  },
  {
    method: "get",
    path: "/errors",
    summary: "Typical and personal errors of the requested concepts (hub_errors tool, ADR 105)",
    query: ErrorsQuerySchema,
    responses: { 200: ok("Errors", ErrorsResponseSchema), 400: invalid },
  },
  {
    method: "get",
    path: "/profile",
    summary: "Recurring errors, failure classes and confidence calibration (hub_profile tool, ADR 105)",
    responses: { 200: ok("Profile", ProfileSchema) },
  },
  {
    method: "post",
    path: "/capture",
    summary: "Saves a note or a card about a concept from the LH session (hub_capture tool, ADR 105)",
    body: CaptureBodySchema,
    responses: {
      201: ok("Saved", CaptureResponseSchema),
      400: invalid,
      404: notFound,
      409: conflict("ambiguous_concept"),
    },
  },
  {
    method: "get",
    path: "/lens-feedback",
    summary: "Lens votes for a concept, aggregated by label (MCP list_lens_feedback tool, ADR 109)",
    query: LensFeedbackQuerySchema,
    responses: { 200: ok("Lenses", LensFeedbackListSchema), 400: invalid, 404: notFound, 409: conflict("ambiguous_concept") },
  },
  {
    method: "post",
    path: "/lens-feedback",
    summary: "Saves the lens votes for a core node from the LH session (hub_lens_feedback tool, ADR 109)",
    body: LensFeedbackBodySchema,
    responses: {
      201: ok("Saved", LensFeedbackSavedSchema),
      400: invalid,
      404: notFound,
      409: conflict("ambiguous_concept"),
    },
  },
  // ------------------------------------------------------------ prior knowledge and syllabus (ADR 105 §6)
  {
    method: "get",
    path: "/prior-reports",
    summary: "Prior-knowledge reports, from most recent to oldest (without items)",
    query: PriorReportListQuerySchema,
    responses: { 200: ok("Summaries", PriorReportListSchema), 400: invalid },
  },
  {
    method: "get",
    path: "/prior-reports/:id",
    summary: "Full prior-knowledge report",
    params: IdParamsSchema,
    responses: { 200: ok("Report", PriorReportSchema), 404: notFound },
  },
  {
    method: "put",
    path: "/syllabus/:subjectId",
    summary: "Save the subject's syllabus (replaces the previous one)",
    params: SubjectIdParamsSchema,
    body: PutSyllabusBodySchema,
    responses: { 200: ok("Saved", PutSyllabusResponseSchema), 400: invalid, 404: notFound },
  },
  {
    method: "get",
    path: "/syllabus/:subjectId",
    summary: "Syllabus with which topics have been seen and their status",
    params: SubjectIdParamsSchema,
    responses: { 200: ok("Syllabus", SyllabusSchema), 404: notFound },
  },
  {
    method: "get",
    path: "/syllabus/:subjectId/gaps",
    summary: "Syllabus topics not yet seen (parity with MCP get_syllabus_gaps)",
    params: SubjectIdParamsSchema,
    responses: { 200: ok("Gaps", GetSyllabusGapsOutputSchema), 404: notFound },
  },
  {
    method: "get",
    path: "/materials/:subjectId",
    summary: "List files under the subject's materials folder",
    params: SubjectIdParamsSchema,
    responses: { 200: ok("List", MaterialsListSchema), 404: notFound },
  },
  {
    method: "post",
    path: "/materials/notes",
    summary: "Write class notes and import them into LH (parity with MCP import_class_notes)",
    body: ImportClassNotesBodySchema,
    responses: { 201: ok("Imported", ImportClassNotesResponseSchema), 400: invalid, 404: notFound, 502: { description: "lh_unavailable", schema: UpstreamErrorSchema } },
  },
  {
    method: "post",
    path: "/materials/import",
    summary: "Import PDFs/MD from the materials folder into LH (parity with MCP import_material)",
    body: ImportMaterialBodySchema,
    responses: { 200: ok("Results", ImportMaterialResponseSchema), 400: invalid, 404: notFound, 502: { description: "lh_unavailable", schema: UpstreamErrorSchema } },
  },
  { method: "get", path: "/health", summary: "Status of LH, eval, worker, jobs queue, last backup", responses: { 200: ok("Status", HealthSchema) } },
];
