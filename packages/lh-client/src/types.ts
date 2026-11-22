// Wire types of the LearnHarness HTTP API (ADR 105; ADR 103 for `fileSources`), as read by the Hub.
// TOLERANT zod schemas: they only validate what the Hub reads and let everything else through
// (`.passthrough()`), so a new upstream field breaks nothing and a field the Hub reads that changes
// shape fails HERE (LhContractError).
// Each schema cites the LearnHarness API area its shape mirrors (plain-text pointers, no code is included).
import { z } from "zod";

// ─── Graph (LearnHarness API: graph contracts, GET /api/graph) ─────────────────

/** LearnHarness `ProvenancePoint`. `chatId` may be a notes-source id ("src_…"); `messageId` "" = chat level. */
export const ProvenancePointSchema = z
  .object({ chatId: z.string(), messageId: z.string() })
  .passthrough();
export type ProvenancePoint = z.infer<typeof ProvenancePointSchema>;

/** LearnHarness `GraphNode` (a saved proposition). */
export const GraphNodeSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    statement: z.string(),
    aliases: z.array(z.string()),
    provenance: z.array(ProvenancePointSchema),
    createdAt: z.string(),
  })
  .passthrough();
export type GraphNode = z.infer<typeof GraphNodeSchema>;

/** LearnHarness `GraphChain` (an argument: premises that together imply the conclusion). */
export const GraphChainSchema = z
  .object({
    id: z.string(),
    premises: z.array(z.string()),
    conclusion: z.string(),
    provenance: z.array(ProvenancePointSchema),
    createdAt: z.string(),
  })
  .passthrough();
export type GraphChain = z.infer<typeof GraphChainSchema>;

/**
 * `GET /api/graph` → LearnHarness `GraphSnapshot`. The Hub reads ONLY `propositions` and
 * `chains` (ADR 105). Unlike the rest, this object is NOT passthrough: the other keys
 * (`nodes`, `edges`, `logicalEdges`, `impLinks`, `clusters`, `positions`…) are dropped at the
 * boundary so that nobody can read the implication nodes derived for the canvas.
 */
export const GraphSnapshotSchema = z.object({
  propositions: z.array(GraphNodeSchema),
  chains: z.array(GraphChainSchema),
  /** chatId → title, for every chat that touched the graph (optional: subject inheritance, ADR 103). */
  sessions: z.record(z.string()).optional(),
  /** srcId ("src_…") → path of the imported notes file (optional: inheritance by `lh_source_folder`, ADR 103). */
  fileSources: z.record(z.string()).optional(),
});
export type GraphSnapshot = z.infer<typeof GraphSnapshotSchema>;

// ─── Sessions (LearnHarness API: chat contracts, GET /api/chats) ─────────────

/** LearnHarness `ChatKind` (the summary normalizes it: absent → "teach"). */
export const ChatKindSchema = z.enum(["teach", "practice"]);
export type ChatKind = z.infer<typeof ChatKindSchema>;

/** LearnHarness `ChatListItem` (= `ChatSummary` + `busy` + `compacting`). */
export const ChatListItemSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    kind: ChatKindSchema,
    createdAt: z.string(),
    updatedAt: z.string(),
    messageCount: z.number().int().nonnegative(),
    busy: z.boolean(),
  })
  .passthrough();
export type ChatListItem = z.infer<typeof ChatListItemSchema>;

/** `GET /api/chats` → `{chats}`. */
export const ChatListResponseSchema = z.object({ chats: z.array(ChatListItemSchema) }).passthrough();

// Native messages (LearnHarness API: `LhMessage` = pi-ai
// UserMessage | AssistantMessage | ToolResultMessage | LhMarkerMessage, all with an `id`).

export const TextPartSchema = z.object({ type: z.literal("text"), text: z.string() }).passthrough();
export const ThinkingPartSchema = z.object({ type: z.literal("thinking"), thinking: z.string() }).passthrough();
/** Tool call inside an assistant message. */
export const ToolCallPartSchema = z
  .object({
    type: z.literal("toolCall"),
    id: z.string(),
    name: z.string(),
    arguments: z.record(z.unknown()),
  })
  .passthrough();
export type ToolCallPart = z.infer<typeof ToolCallPartSchema>;
/** Any other part (images…): tolerated without reading it. */
const OtherPartSchema = z.object({ type: z.string() }).passthrough();

export const UserMessageSchema = z
  .object({
    role: z.literal("user"),
    id: z.string(),
    content: z.union([z.string(), z.array(z.union([TextPartSchema, OtherPartSchema]))]),
    timestamp: z.number(),
  })
  .passthrough();

export const AssistantMessageSchema = z
  .object({
    role: z.literal("assistant"),
    id: z.string(),
    content: z.array(z.union([TextPartSchema, ThinkingPartSchema, ToolCallPartSchema, OtherPartSchema])),
    timestamp: z.number(),
  })
  .passthrough();
export type AssistantMessage = z.infer<typeof AssistantMessageSchema>;

/** Tool result. The student's answer to a question lives in `details` (see extract.ts). */
export const ToolResultMessageSchema = z
  .object({
    role: z.literal("toolResult"),
    id: z.string(),
    toolCallId: z.string(),
    toolName: z.string(),
    content: z.array(z.union([TextPartSchema, OtherPartSchema])),
    details: z.unknown(),
    isError: z.boolean(),
    timestamp: z.number(),
  })
  .passthrough();
export type ToolResultMessage = z.infer<typeof ToolResultMessageSchema>;

/** LearnHarness `LhMarkerMessage` (graph-context, plan-block, problem-dismissed, practice-thinking…). */
export const CustomMessageSchema = z
  .object({
    role: z.literal("custom"),
    id: z.string(),
    customType: z.string(),
    content: z.string(),
    details: z.unknown(),
    timestamp: z.number(),
  })
  .passthrough();

export const LhMessageSchema = z.discriminatedUnion("role", [
  UserMessageSchema,
  AssistantMessageSchema,
  ToolResultMessageSchema,
  CustomMessageSchema,
]);
export type LhMessage = z.infer<typeof LhMessageSchema>;

/** LearnHarness `ChatRecord` (native messages served as they are). */
export const ChatRecordSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    kind: ChatKindSchema.optional(),
    messages: z.array(LhMessageSchema),
  })
  .passthrough();
export type ChatRecord = z.infer<typeof ChatRecordSchema>;

/** LearnHarness `SessionCoverage` — only what the session close looks at. */
export const SessionCoverageSchema = z
  .object({ uncoveredCount: z.number(), running: z.boolean() })
  .passthrough();

/** `GET /api/chats/:id` → record (without `imageSnapshots`) + pricing/turnInFlight/turnError/compacting/coverage. */
export const ChatDetailSchema = ChatRecordSchema.extend({
  turnInFlight: z.boolean(),
  coverage: SessionCoverageSchema.nullable(),
}).passthrough();
export type ChatDetail = z.infer<typeof ChatDetailSchema>;

/** `POST /api/chats` → `{id, title}`. */
export const CreateChatResponseSchema = z.object({ id: z.string(), title: z.string() }).passthrough();
export type CreateChatResponse = z.infer<typeof CreateChatResponseSchema>;

/** `POST /api/chat` with `{type:"text"}` → 200 `{ok:true}` (the turn runs on the server; LearnHarness no
 *  longer keeps the stream open on the POST). */
export const SendMessageResponseSchema = z.object({ ok: z.literal(true) }).passthrough();

// ─── Questions (LearnHarness API: question core) ─────────────────────────────

/** LearnHarness `QuestionKind`. */
export const QuestionKindSchema = z.enum(["quiz", "ask", "explain"]);

/** LearnHarness `QuestionAnswerData`: the `details` of the toolResult of quiz/probe/explain/recall/ask_user_question. */
export const QuestionAnswerDataSchema = z
  .object({
    kind: QuestionKindSchema,
    /** Tool name; absent in old records and in dismissals. Use `toolResult.toolName`. */
    tool: z.string().optional(),
    questionType: z.string().optional(),
    questionText: z.string(),
    dontKnow: z.boolean(),
    answers: z.array(z.object({ label: z.string(), index: z.number() }).passthrough()),
    text: z.string().optional(),
    thinking: z.string().optional(),
    /** @deprecated in LearnHarness (renamed to `thinking`); read as `thinking ?? note`. */
    note: z.string().optional(),
    readingThinking: z.string().optional(),
    /** 0–100; never present with dontKnow. */
    confidence: z.number().optional(),
    correct: z.boolean().optional(),
    committed: z.string().optional(),
    dismissed: z.boolean().optional(),
    answeredAt: z.string(),
  })
  .passthrough();
export type QuestionAnswerData = z.infer<typeof QuestionAnswerDataSchema>;

/** Arguments of quiz/explain (teach): only `nodeId` and `question` are read. probe/recall carry no `nodeId`. */
export const QuestionCallArgsSchema = z
  .object({ question: z.string().optional(), nodeId: z.string().optional() })
  .passthrough();

// ─── Practice (LearnHarness API: practice tools) ─────────────────────────────

export const ProblemModeSchema = z.enum(["recall", "discrimination", "composition"]);
export type ProblemMode = z.infer<typeof ProblemModeSchema>;

/** `problemInputObject`. Absent `target` = unlabelled problem (topic session). */
export const ProblemArgsSchema = z
  .object({
    statement: z.string(),
    mode: ProblemModeSchema,
    target: z.array(z.string()).optional(),
    modelSolution: z.string(),
  })
  .passthrough();
export type ProblemArgs = z.infer<typeof ProblemArgsSchema>;

export const ConcludeOutcomeSchema = z.enum(["solved", "solvedWithHints", "movedOn", "surrendered", "dismissed"]);
export type ConcludeOutcome = z.infer<typeof ConcludeOutcomeSchema>;
export const RungSchema = z.enum(["R0", "R1", "R2", "R3", "R4", "R5"]);
export type Rung = z.infer<typeof RungSchema>;
export const MissClassSchema = z.enum(["cue", "discrimination", "execution", "careless", "structural"]);
export type MissClass = z.infer<typeof MissClassSchema>;

/** `concludeInputObject`. The synthetic conclude of a dismissal only carries `{outcome:"dismissed"}`
 *  (LearnHarness API: `concludedByDismissalPair`), hence the optionals. */
export const ConcludeArgsSchema = z
  .object({
    outcome: ConcludeOutcomeSchema,
    verdict: z.string().optional(),
    rung: RungSchema.nullable().optional(),
    missClass: MissClassSchema.nullable().optional(),
    retest: z.boolean().optional(),
  })
  .passthrough();
export type ConcludeArgs = z.infer<typeof ConcludeArgsSchema>;

// ─── Plan (LearnHarness API: plan_init, `details` of its toolResult) ─────────

export const PlanNodeSchema = z.object({ id: z.string(), title: z.string() }).passthrough();
export type PlanNode = z.infer<typeof PlanNodeSchema>;
/** `details` of a successful plan_init: `{ok:true, tree:{nodes:[{id,title}], edges, version}}`. */
export const PlanInitDetailsSchema = z
  .object({ ok: z.literal(true), tree: z.object({ nodes: z.array(PlanNodeSchema) }).passthrough() })
  .passthrough();

// ─── SSE events (LearnHarness API: server events stream) ─────────────────────

/** Frame `event: <type>\ndata: <payload JSON>\n\n`; `: ping` every 25 s. The client rebuilds `{type, ...payload}`. */
export const ServerEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("turn-started"), chatId: z.string() }).passthrough(),
  z.object({ type: z.literal("turn-settled"), chatId: z.string() }).passthrough(),
  z.object({ type: z.literal("jobs-changed"), chatId: z.string().optional() }).passthrough(),
  z.object({ type: z.literal("activity-changed") }).passthrough(),
  z.object({ type: z.literal("chats-changed") }).passthrough(),
  z.object({ type: z.literal("sources-changed") }).passthrough(),
  z.object({ type: z.literal("subscriptions-changed") }).passthrough(),
  z.object({ type: z.literal("record-changed"), chatId: z.string() }).passthrough(),
  z.object({ type: z.literal("compaction-changed"), chatId: z.string(), running: z.boolean() }).passthrough(),
]);
export type ServerEvent = z.infer<typeof ServerEventSchema>;
export type ServerEventType = ServerEvent["type"];
/** LearnHarness `SERVER_EVENT_TYPES`. */
export const SERVER_EVENT_TYPES: readonly ServerEventType[] = [
  "turn-started",
  "turn-settled",
  "jobs-changed",
  "activity-changed",
  "chats-changed",
  "sources-changed",
  "subscriptions-changed",
  "record-changed",
  "compaction-changed",
];

// ─── Import and extraction (LearnHarness API: graph/import, coverage/extract, status) ─

/** LearnHarness `EmissionStats`. */
export const EmissionStatsSchema = z
  .object({ nodes: z.number(), chains: z.number().optional(), droppedChains: z.number().optional() })
  .passthrough();

/** LearnHarness `ImportResult` (internal to the graph/import route). `ok` ⇔ `outcome === "completed"`. */
export const ImportResultSchema = z
  .object({
    requestIndex: z.number().int().nonnegative(),
    outcome: z.enum(["completed", "failed", "partial", "aborted", "busy"]),
    filePath: z.string(),
    ok: z.boolean(),
    stats: EmissionStatsSchema.optional(),
    error: z.string().optional(),
    /** "models_not_configured" | "provider_key_missing". */
    code: z.string().optional(),
    missing: z.array(z.string()).optional(),
    notice: z.string().optional(),
  })
  .passthrough();
export type ImportResult = z.infer<typeof ImportResultSchema>;
export const ImportResponseSchema = z.object({ results: z.array(ImportResultSchema) }).passthrough();

/** `POST /api/graph/coverage/extract` → 202 `{started:true}` (409 `{error}` if one is already running). */
export const CoverageExtractResponseSchema = z.object({ started: z.literal(true) }).passthrough();

/** LearnHarness `ExtractionPhase`. */
export const ExtractionPhaseSchema = z.enum(["queued", "extracting", "waiting", "auditing", "merging"]);
/** One row of `GET /api/graph/status`. `chatId` is the source id (a chat or "src_…"); `id` appends "#i" for chunks. */
export const GraphStatusRunSchema = z
  .object({
    id: z.string(),
    chatId: z.string(),
    title: z.string(),
    phase: ExtractionPhaseSchema,
    startedAt: z.number(),
  })
  .passthrough();
export type GraphStatusRun = z.infer<typeof GraphStatusRunSchema>;
export const GraphStatusResponseSchema = z.object({ runs: z.array(GraphStatusRunSchema) }).passthrough();

// ─── Errors (LearnHarness API: models-not-configured rejection, routes) ──────

/** LearnHarness error body: `{error}` and, for configuration rejections, `{code, missing}`. */
export const LhErrorBodySchema = z
  .object({ error: z.string(), code: z.string().optional(), missing: z.array(z.string()).optional() })
  .passthrough();
export type LhErrorBody = z.infer<typeof LhErrorBodySchema>;
