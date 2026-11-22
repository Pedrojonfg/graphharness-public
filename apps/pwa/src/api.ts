// Hub API client (ADR 102 §12). All types and validation come from @graphharness/contracts:
// the body is validated against the route schema (API_ROUTES) before sending, and the response is
// validated against the schema of its status code. If the Hub answers with something that breaks
// the contract, ContractError is thrown instead of rendering half-baked data.
import {
  API_BASE,
  API_ROUTES,
  ApiErrorSchema,
  CaptureResponseSchema,
  CardImportResponseSchema,
  CardQueueSchema,
  CardRetireResponseSchema,
  CardReviewResponseSchema,
  CloseSessionResponseSchema,
  ConceptDetailSchema,
  DailyBriefSchema,
  DeclarationRecordedSchema,
  DiagnosticAnswerResponseSchema,
  DiagnosticStateSchema,
  DismissSuggestionResponseSchema,
  AcceptSuggestionResponseSchema,
  ErrorsResponseSchema,
  ExamListSchema,
  ExamSchema,
  ExerciseAttemptResponseSchema,
  ExerciseExplanationSchema,
  ExerciseHintResponseSchema,
  ExerciseSchema,
  GetSyllabusGapsOutputSchema,
  HealthSchema,
  InboxSchema,
  ImportClassNotesResponseSchema,
  ImportMaterialResponseSchema,
  LensFeedbackListSchema,
  LlmUsageSchema,
  MasterySchema,
  MaterialsListSchema,
  MergeConceptsResponseSchema,
  NoteSchema,
  PatchConceptEdgesResponseSchema,
  PriorReportListSchema,
  PriorReportSchema,
  ProfileSchema,
  PutSyllabusResponseSchema,
  RenderReportResponseSchema,
  ReportListSchema,
  ReportSchema,
  ResolveConceptsResponseSchema,
  SearchKnowledgeResponseSchema,
  SessionListSchema,
  SplitConceptResponseSchema,
  StartSessionResponseSchema,
  SubjectListSchema,
  SubjectMapSchema,
  SubjectOverviewSchema,
  SubjectSchema,
  SyllabusSchema,
  WeekPlanSchema,
  type ApiRoute,
  type CaptureBody,
  type CardReviewBody,
  type CreateExamBody,
  type CreateSubjectBody,
  type DiagnosticAnswerBody,
  type ExerciseAttemptBody,
  type ExerciseExplainBody,
  type FlashcardImportBody,
  type HttpMethod,
  type ImportClassNotesBody,
  type ImportMaterialBody,
  type MergeConceptsBody,
  type PatchConceptBody,
  type PatchConceptEdgesBody,
  type PatchConceptStateBody,
  type PatchExamBody,
  type PatchSubjectBody,
  type ReportKind,
  type ResolveConceptsBody,
  type SearchKnowledgeBody,
  type SplitConceptBody,
  type StartSessionBody,
  type WeakPrerequisite,
} from "@graphharness/contracts";

/** A zod schema from contracts (without depending on zod directly). */
type Schema = NonNullable<ApiRoute["body"]>;
type Out<S extends Schema> = S["_output"];
type Issue = { path: (string | number)[]; message: string };

/** The Hub answered with an error status (body per that route's contract, if it complies). */
export class HubError extends Error {
  readonly status: number;
  /** Machine code (`weak_prerequisites`, `not_found`, `models_not_configured`...). */
  readonly code: string;
  readonly body: unknown;
  constructor(status: number, code: string, message: string, body: unknown) {
    super(message);
    this.name = "HubError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
  /** Weak prerequisites from the 409 of PATCH /concepts/:id/state. */
  get weakPrerequisites(): WeakPrerequisite[] | null {
    const b = this.body as { error?: unknown; weakPrerequisites?: WeakPrerequisite[] } | null;
    return this.code === "weak_prerequisites" && b?.weakPrerequisites ? b.weakPrerequisites : null;
  }
}

/** The request or the response breaks the contract (@graphharness/contracts). */
export class ContractError extends Error {
  readonly issues: Issue[];
  constructor(message: string, issues: Issue[]) {
    super(message);
    this.name = "ContractError";
    this.issues = issues;
  }
}

/** No connection to the Hub (network down, Hub stopped). */
export class NetworkError extends Error {
  constructor(cause: unknown) {
    super("Could not connect to the Hub. Check your tailnet connection.", { cause });
    this.name = "NetworkError";
  }
}

type Opts = {
  params?: Record<string, string>;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
};

function findRoute(method: HttpMethod, path: string): ApiRoute {
  const route = API_ROUTES.find((r) => r.method === method && r.path === path);
  if (!route) throw new Error(`Unknown route in contracts: ${method.toUpperCase()} ${path}`);
  return route;
}

export function buildUrl(path: string, opts: Opts = {}): string {
  const filled = path.replace(/:(\w+)/g, (_, k: string) => {
    const v = opts.params?.[k];
    if (v === undefined) throw new Error(`Missing parameter :${k} for ${path}`);
    return encodeURIComponent(v);
  });
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== "") qs.set(k, String(v));
  const q = qs.toString();
  return `${API_BASE}${filled}${q ? `?${q}` : ""}`;
}

async function call<S extends Schema>(method: HttpMethod, path: string, schema: S | null, opts: Opts = {}): Promise<Out<S>> {
  const route = findRoute(method, path);
  let body: string | undefined;
  if (route.body) {
    const parsed = route.body.safeParse(opts.body ?? {});
    if (!parsed.success) throw new ContractError(`Invalid request for ${method.toUpperCase()} ${path}`, parsed.error.issues);
    body = JSON.stringify(parsed.data);
  }
  let res: Response;
  try {
    res = await fetch(buildUrl(path, opts), {
      method: method.toUpperCase(),
      headers: body !== undefined ? { "content-type": "application/json", accept: "application/json" } : { accept: "application/json" },
      body,
    });
  } catch (e) {
    throw new NetworkError(e);
  }

  if (res.status === 204) return undefined as Out<S>;
  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch (e) {
      if (res.ok) throw new ContractError(`Non-JSON response from ${path}: ${String(e)}`, []);
    }
  }

  if (!res.ok) throw toHubError(route, res.status, json);

  if (!route.responses[res.status] || !schema) throw new ContractError(`Status ${res.status} not expected in the contract of ${path}`, []);
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new ContractError(`The response of ${method.toUpperCase()} ${path} does not match the contract`, parsed.error.issues);
  return parsed.data;
}

function toHubError(route: ApiRoute, status: number, json: unknown): HubError {
  const schema = route.responses[status]?.schema ?? ApiErrorSchema;
  const parsed = schema.safeParse(json);
  const body = parsed.success ? (parsed.data as Record<string, unknown>) : null;
  // The LH 503 carries the code in `code` and the text in `error` (ModelsNotConfiguredErrorSchema).
  const code = body ? String(body.code ?? body.error ?? `http_${status}`) : `http_${status}`;
  const message = body && typeof body.message === "string" ? body.message : body && typeof body.code === "string" ? String(body.error) : "";
  return new HubError(status, code, message || errorText(code, status), body ?? json);
}

const ERROR_TEXT: Record<string, string> = {
  not_found: "Not found (it may have been deleted or merged).",
  invalid_request: "The Hub rejected the request because of invalid data.",
  weak_prerequisites: "There are weak prerequisites.",
  eval_unavailable: "The grading service (eval) is not responding. Try again in a moment.",
  llm_unavailable: "The Hub LLM is not responding right now.",
  llm_bad_output: "The LLM returned something unusable. Try again.",
  lh_unavailable: "LearnHarness is not responding.",
  models_not_configured: "LearnHarness has no model configured.",
  template_not_active: "That template is no longer active.",
  exercise_finished: "The exercise has already finished.",
  no_attempt: "Answer at least once before asking for the explanation.",
  already_answered: "That question was already answered.",
  override_window_passed: "The 60 s window to correct it has passed.",
  nothing_to_override: "There is no mistake to correct.",
  given_required: "This card needs your answer to be graded.",
  diagnostic_finished: "The diagnostic has already finished.",
  wrong_format: "The answer format does not match the question.",
  not_open: "That suggestion was already resolved.",
  invalid_merge: "That merge cannot be applied.",
  invalid_split: "That split cannot be applied.",
  latex_failed: "The PDF does not compile even when omitting sections.",
  not_rendered: "There is no compiled PDF yet.",
  slug_taken: "A subject with that name already exists.",
  cycle: "That change would create a prerequisite cycle.",
};

function errorText(code: string, status: number): string {
  return ERROR_TEXT[code] ?? `The Hub responded with an error (${status}).`;
}

/** Display text for any error. */
export function errorMessage(e: unknown): string {
  if (e instanceof HubError || e instanceof NetworkError) return e.message;
  if (e instanceof ContractError) return `${e.message}. The PWA and the Hub may not be the same version.`;
  return e instanceof Error ? e.message : String(e);
}

// ------------------------------------------------------------------ endpoints

export const api = {
  subjects: () => call("get", "/subjects", SubjectListSchema),
  createSubject: (body: CreateSubjectBody) => call("post", "/subjects", SubjectSchema, { body }),
  patchSubject: (id: string, body: PatchSubjectBody) => call("patch", "/subjects/:id", SubjectSchema, { params: { id }, body }),
  subjectMap: (id: string) => call("get", "/subjects/:id/map", SubjectMapSchema, { params: { id } }),
  subjectOverview: (id: string) => call("get", "/subjects/:id/overview", SubjectOverviewSchema, { params: { id } }),

  searchKnowledge: (body: SearchKnowledgeBody) => call("post", "/knowledge/search", SearchKnowledgeResponseSchema, { body }),
  resolveConcepts: (body: ResolveConceptsBody) => call("post", "/knowledge/resolve", ResolveConceptsResponseSchema, { body }),

  concept: (id: string) => call("get", "/concepts/:id", ConceptDetailSchema, { params: { id } }),
  addConceptNote: (id: string, text: string) => call("post", "/concepts/:id/notes", NoteSchema, { params: { id }, body: { text } }),
  patchConcept: (id: string, body: PatchConceptBody) => call("patch", "/concepts/:id", ConceptDetailSchema, { params: { id }, body }),
  setConceptState: (id: string, body: PatchConceptStateBody) =>
    call("patch", "/concepts/:id/state", DeclarationRecordedSchema, { params: { id }, body }),
  mergeConcepts: (id: string, body: MergeConceptsBody) =>
    call("post", "/concepts/:id/merge", MergeConceptsResponseSchema, { params: { id }, body }),
  splitConcept: (id: string, body: SplitConceptBody) =>
    call("post", "/concepts/:id/split", SplitConceptResponseSchema, { params: { id }, body }),
  patchConceptEdges: (body: PatchConceptEdgesBody) => call("patch", "/concept-edges", PatchConceptEdgesResponseSchema, { body }),
  acceptSuggestion: (id: string) => call("post", "/concept-suggestions/:id/accept", AcceptSuggestionResponseSchema, { params: { id } }),
  dismissSuggestion: (id: string) => call("post", "/concept-suggestions/:id/dismiss", DismissSuggestionResponseSchema, { params: { id } }),
  inbox: () => call("get", "/inbox", InboxSchema),

  cardQueue: (offset: number, limit = 20) => call("get", "/cards/queue", CardQueueSchema, { query: { offset, limit } }),
  reviewCard: (id: string, body: CardReviewBody) => call("post", "/cards/:id/review", CardReviewResponseSchema, { params: { id }, body }),
  retireCard: (id: string) => call("post", "/cards/:id/retire", CardRetireResponseSchema, { params: { id } }),
  importCards: (body: FlashcardImportBody) => call("post", "/cards/import", CardImportResponseSchema, { body }),

  createExercise: (templateId: string) => call("post", "/exercises", ExerciseSchema, { body: { templateId } }),
  attempt: (instanceId: string, body: ExerciseAttemptBody) =>
    call("post", "/exercises/:instanceId/attempt", ExerciseAttemptResponseSchema, { params: { instanceId }, body }),
  hint: (instanceId: string) => call("post", "/exercises/:instanceId/hint", ExerciseHintResponseSchema, { params: { instanceId } }),
  explain: (instanceId: string, body: ExerciseExplainBody) =>
    call("post", "/exercises/:instanceId/explain", ExerciseExplanationSchema, { params: { instanceId }, body }),

  createDiagnostic: (examId: string) => call("post", "/diagnostics", DiagnosticStateSchema, { body: { examId } }),
  answerDiagnostic: (id: string, body: DiagnosticAnswerBody) =>
    call("post", "/diagnostics/:id/answer", DiagnosticAnswerResponseSchema, { params: { id }, body }),

  exams: () => call("get", "/exams", ExamListSchema),
  createExam: (body: CreateExamBody) => call("post", "/exams", ExamSchema, { body }),
  patchExam: (id: string, body: PatchExamBody) => call("patch", "/exams/:id", ExamSchema, { params: { id }, body }),
  deleteExam: async (id: string): Promise<void> => {
    await call<Schema>("delete", "/exams/:id", null, { params: { id } });
  },

  sessions: (limit = 20) => call("get", "/sessions", SessionListSchema, { query: { limit } }),
  startSession: (body: StartSessionBody) => call("post", "/sessions", StartSessionResponseSchema, { body }),
  closeSession: (chatId: string) => call("post", "/sessions/:chatId/close", CloseSessionResponseSchema, { params: { chatId } }),

  reports: (kind?: ReportKind) => call("get", "/reports", ReportListSchema, { query: { kind } }),
  report: (id: string) => call("get", "/reports/:id", ReportSchema, { params: { id } }),
  renderReport: (id: string) => call("post", "/reports/:id/render", RenderReportResponseSchema, { params: { id } }),
  reportPdfUrl: (id: string) => buildUrl("/reports/:id/pdf", { params: { id } }),

  brief: () => call("get", "/brief", DailyBriefSchema),
  plan: (days?: number) => call("get", "/plan", WeekPlanSchema, { query: { days } }),

  priorReports: (subjectId?: string) => call("get", "/prior-reports", PriorReportListSchema, { query: { subjectId } }),
  priorReport: (id: string) => call("get", "/prior-reports/:id", PriorReportSchema, { params: { id } }),
  syllabus: (subjectId: string) => call("get", "/syllabus/:subjectId", SyllabusSchema, { params: { subjectId } }),
  syllabusGaps: (subjectId: string) => call("get", "/syllabus/:subjectId/gaps", GetSyllabusGapsOutputSchema, { params: { subjectId } }),
  putSyllabus: (subjectId: string, text: string) =>
    call("put", "/syllabus/:subjectId", PutSyllabusResponseSchema, { params: { subjectId }, body: { text } }),

  materials: (subjectId: string) => call("get", "/materials/:subjectId", MaterialsListSchema, { params: { subjectId } }),
  importClassNotes: (body: ImportClassNotesBody) => call("post", "/materials/notes", ImportClassNotesResponseSchema, { body }),
  importMaterial: (body: ImportMaterialBody) => call("post", "/materials/import", ImportMaterialResponseSchema, { body }),

  mastery: (query: string) => call("get", "/mastery", MasterySchema, { query: { query } }),
  conceptErrors: (conceptIds: string) => call("get", "/errors", ErrorsResponseSchema, { query: { conceptIds } }),
  profile: () => call("get", "/profile", ProfileSchema),
  capture: (body: CaptureBody) => call("post", "/capture", CaptureResponseSchema, { body }),
  lensFeedback: (conceptId: string) => call("get", "/lens-feedback", LensFeedbackListSchema, { query: { conceptId } }),

  llmUsage: (days = 7) => call("get", "/llm-usage", LlmUsageSchema, { query: { days } }),
  health: () => call("get", "/health", HealthSchema),
};
