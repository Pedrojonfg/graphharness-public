// Concepts, declarations, maintenance and curator suggestions (`/concepts` route).
import { z } from "zod";
import { CardFrontSchema, CardKindSchema } from "./cards.ts";
import {
  ConceptStateViewSchema,
  IdSchema,
  IsoDateTimeSchema,
  ManualTargetStateSchema,
  McqOptionSchema,
  WeakPrerequisiteSchema,
} from "./common.ts";
import { ConceptEdgeSchema, EdgeRelationSchema } from "./subjects.ts";

export const ConceptStatusSchema = z.enum(["active", "merged", "retired"]);
export const CreatedBySchema = z.enum(["curator", "agent", "pwa"]);
export const OriginSchema = z.enum(["agent", "pwa"]);

export const EvidenceSourceSchema = z.enum([
  "lh_quiz",
  "lh_probe",
  "lh_recall",
  "lh_practice",
  "hub_exercise",
  "hub_diagnostic",
  "flashcard",
  "declaration",
  "confirmation",
]);
export type EvidenceSource = z.infer<typeof EvidenceSourceSchema>;

/** An `evidence_events` row as is. */
export const EvidenceEventSchema = z.object({
  id: IdSchema,
  at: IsoDateTimeSchema,
  source: EvidenceSourceSchema,
  /** null for declarations. */
  correct: z.boolean().nullable(),
  responseFormat: z.enum(["open", "mcq"]).nullable(),
  /** Correctness judged by an LLM (`lh_recall`). */
  inferred: z.boolean(),
  weight: z.number().nonnegative(),
  confidence: z.number().int().min(0).max(100).nullable(),
  targetState: ManualTargetStateSchema.nullable(),
  justification: z.string().nullable(),
  /** `{chatId,toolCallId}` | `{instanceId}` | `{cardId}` | `{declarationId}`. */
  ref: z.record(z.string()),
});
export type EvidenceEvent = z.infer<typeof EvidenceEventSchema>;

export const PropositionSchema = z.object({
  id: IdSchema,
  name: z.string(),
  statement: z.string(),
  aliases: z.array(z.string()),
});
export type Proposition = z.infer<typeof PropositionSchema>;

/** Template (method) of a concept. Without `recipe_json`: the client does not need it. */
export const TemplateSummarySchema = z.object({
  id: IdSchema,
  slug: z.string(),
  name: z.string(),
  level: z.string(),
  status: z.enum(["active", "failed", "retired"]),
  /** The "summary sheet" with the method's steps (GL-039.3). */
  methodSummary: z.string().nullable(),
  /** Where it stops being valid (GL-012). */
  methodLimits: z.string().nullable(),
  generalTemplateId: IdSchema.nullable(),
});
export type TemplateSummary = z.infer<typeof TemplateSummarySchema>;

/** Typical error (`origin: recipe`) or a template's personal error. Without `expr`. */
export const TemplateErrorSchema = z.object({
  id: IdSchema,
  templateId: IdSchema,
  key: z.string(),
  description: z.string(),
  origin: z.enum(["recipe", "personal"]),
  timesSeen: z.number().int().nonnegative(),
  lastSeenAt: IsoDateTimeSchema.nullable(),
});
export type TemplateError = z.infer<typeof TemplateErrorSchema>;

export const NoteSchema = z.object({
  id: IdSchema,
  conceptId: IdSchema.nullable(),
  text: z.string(),
  /** `lh`: captured from an LH session (hub_capture, ADR 105). */
  origin: z.enum([...OriginSchema.options, "lh"]),
  createdAt: IsoDateTimeSchema,
});
export type Note = z.infer<typeof NoteSchema>;

/** GET /concepts/:id and MCP `get_concept`. */
export const ConceptDetailSchema = z.object({
  id: IdSchema,
  subjectId: IdSchema.nullable(),
  subjectName: z.string().nullable(),
  name: z.string(),
  description: z.string(),
  computable: z.boolean(),
  optional: z.boolean(),
  status: ConceptStatusSchema,
  mergedInto: IdSchema.nullable(),
  createdBy: CreatedBySchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  state: ConceptStateViewSchema,
  /** Live propositions (not `deleted`). */
  propositions: z.array(PropositionSchema),
  templates: z.array(TemplateSummarySchema),
  /** The last 20 events, from most recent to oldest. */
  recentEvidence: z.array(EvidenceEventSchema),
  notes: z.array(NoteSchema),
  /** Errors of all its templates, from most to least seen. */
  errors: z.array(TemplateErrorSchema),
});
export type ConceptDetail = z.infer<typeof ConceptDetailSchema>;

// ---------------------------------------------------------------- declarations

/**
 * Confirmation item. `itemId` = id of the card with `purpose='confirmation'` (ADR 102 §10).
 * It carries NO answer: the Hub grades it (`answer_confirmation` or POST /cards/:itemId/review with `given`).
 * What `answer` is: MCQ → option id; `front.instance` and kind ≠ mcq → instance value
 * (`AnswerValue` according to `answerKind`/`shape`); otherwise → text.
 */
export const ConfirmationItemSchema = z
  .object({
    itemId: IdSchema,
    conceptId: IdSchema,
    kind: CardKindSchema,
    front: CardFrontSchema,
    options: z.array(McqOptionSchema).nullable(),
  })
  .strict();
export type ConfirmationItem = z.infer<typeof ConfirmationItemSchema>;

/** PATCH /concepts/:id/state (origin = 'pwa'); same fields as `declare_learning` except `rawText`. */
export const PatchConceptStateBodySchema = z.object({
  targetState: ManualTargetStateSchema,
  justification: z.string().trim().min(1).max(500),
  ackWeakPrerequisites: z.boolean().optional(),
});
export type PatchConceptStateBody = z.infer<typeof PatchConceptStateBodySchema>;

/** POST /concepts/:id/notes — parity with MCP `add_concept_note` (origin = 'pwa'). */
export const AddConceptNoteBodySchema = z.object({
  text: z.string().trim().min(1).max(5000),
});
export type AddConceptNoteBody = z.infer<typeof AddConceptNoteBodySchema>;

/** 200 from PATCH /concepts/:id/state: declaration created (`pending`) with 1–2 confirmation items. */
export const DeclarationRecordedSchema = z.object({
  status: z.literal("recorded"),
  declarationId: IdSchema,
  conceptState: ConceptStateViewSchema,
  /** Warnings accepted with `ackWeakPrerequisites` (empty if there were none). */
  weakPrerequisites: z.array(WeakPrerequisiteSchema),
  confirmationItems: z.array(ConfirmationItemSchema).max(2),
});
export type DeclarationRecorded = z.infer<typeof DeclarationRecordedSchema>;

// ---------------------------------------------------------------- maintenance

/** PATCH /concepts/:id. `addPropositionIds` reassigns those propositions to this concept (assigned_by = 'pwa'). */
export const PatchConceptBodySchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().min(1).max(2000).optional(),
    subjectId: IdSchema.nullable().optional(),
    computable: z.boolean().optional(),
    optional: z.boolean().optional(),
    /** `merged` only via /merge. */
    status: z.enum(["active", "retired"]).optional(),
    addPropositionIds: z.array(IdSchema).min(1).max(200).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, "empty body");
export type PatchConceptBody = z.infer<typeof PatchConceptBodySchema>;

/** POST /concepts/:id/merge — merges `sourceIds` INTO `:id` (target), like the `merge` suggestion. */
export const MergeConceptsBodySchema = z.object({
  sourceIds: z.array(IdSchema).min(1).max(20),
});
export type MergeConceptsBody = z.infer<typeof MergeConceptsBodySchema>;

export const MergeConceptsResponseSchema = z.object({
  targetId: IdSchema,
  mergedIds: z.array(IdSchema),
  concept: ConceptDetailSchema,
});
export type MergeConceptsResponse = z.infer<typeof MergeConceptsResponseSchema>;

export const SplitPartSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(2000),
  propositionIds: z.array(IdSchema).min(1),
});
export type SplitPart = z.infer<typeof SplitPartSchema>;

/** POST /concepts/:id/split — each part is a new concept with those propositions (all from `:id`). */
export const SplitConceptBodySchema = z.object({
  parts: z.array(SplitPartSchema).min(2).max(10),
});
export type SplitConceptBody = z.infer<typeof SplitConceptBodySchema>;

export const SplitConceptResponseSchema = z.object({
  sourceId: IdSchema,
  createdIds: z.array(IdSchema).min(1),
  /** The original stays `active` if it keeps propositions; otherwise `retired`. */
  sourceStatus: z.enum(["active", "retired"]),
});
export type SplitConceptResponse = z.infer<typeof SplitConceptResponseSchema>;

const edgeKey = { from: IdSchema, to: IdSchema };

/** PATCH /concept-edges — added ones get `source='manual'`; removed ones get `removed=1` (they are not re-derived). */
export const PatchConceptEdgesBodySchema = z
  .object({
    add: z
      .array(
        z
          .object({ ...edgeKey, relation: EdgeRelationSchema.default("requires"), justification: z.string().trim().min(1).max(500) })
          .refine((e) => e.from !== e.to, "edge to itself"),
      )
      .max(50)
      .default([]),
    remove: z
      .array(z.object({ ...edgeKey, justification: z.string().trim().min(1).max(500) }))
      .max(50)
      .default([]),
  })
  .refine((b) => b.add.length + b.remove.length > 0, "nothing to change");
export type PatchConceptEdgesBody = z.infer<typeof PatchConceptEdgesBodySchema>;

export const PatchConceptEdgesResponseSchema = z.object({
  added: z.array(ConceptEdgeSchema),
  removed: z.array(z.object(edgeKey)),
});
export type PatchConceptEdgesResponse = z.infer<typeof PatchConceptEdgesResponseSchema>;

// ---------------------------------------------------------------- suggestions (ADR 102 §1)

export const SuggestionStatusSchema = z.enum(["open", "accepted", "dismissed"]);

const suggestionBase = {
  id: IdSchema,
  rationale: z.string().nullable(),
  status: SuggestionStatusSchema,
  createdAt: IsoDateTimeSchema,
  resolvedAt: IsoDateTimeSchema.nullable(),
  /** Names of the cited concepts, to render without another call. */
  conceptNames: z.record(z.string()),
};

export const ConceptSuggestionSchema = z.discriminatedUnion("kind", [
  z.object({ ...suggestionBase, kind: z.literal("merge"), sourceIds: z.array(IdSchema).min(1), targetId: IdSchema }),
  z.object({ ...suggestionBase, kind: z.literal("split"), conceptId: IdSchema, parts: z.array(SplitPartSchema).min(2) }),
]);
export type ConceptSuggestion = z.infer<typeof ConceptSuggestionSchema>;

/** GET /concept-suggestions?status (default `open`). */
export const ConceptSuggestionsQuerySchema = z.object({
  status: SuggestionStatusSchema.default("open"),
});
export const ConceptSuggestionListSchema = z.array(ConceptSuggestionSchema);

/** POST /concept-suggestions/:id/accept — applies the merge or split. 409 `not_open` if it was already resolved. */
export const AcceptSuggestionResponseSchema = z.object({
  suggestionId: IdSchema,
  kind: z.enum(["merge", "split"]),
  /** merge: [target]; split: the concepts created. */
  conceptIds: z.array(IdSchema).min(1),
});
export type AcceptSuggestionResponse = z.infer<typeof AcceptSuggestionResponseSchema>;

/** POST /concept-suggestions/:id/dismiss and MCP `dismiss_concept_suggestion` → the suggestion (`dismissed`). 409 `not_open`. */
export const DismissSuggestionResponseSchema = ConceptSuggestionSchema;
