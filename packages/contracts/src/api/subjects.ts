// Subjects and concept map (`subjects` table; `/subjects` route).
import { z } from "zod";
import { ConceptStateSchema, IdSchema, IsoDateTimeSchema, ManualConfirmationSchema } from "./common.ts";
import { ExamSchema } from "./exams.ts";

export const SubjectKindSchema = z.enum(["computable_math", "general", "programming"]);
export type SubjectKind = z.infer<typeof SubjectKindSchema>;

export const SubjectSchema = z.object({
  id: IdSchema,
  name: z.string(),
  slug: z.string(),
  kind: SubjectKindSchema,
  /** Course notation notes (GL-012). */
  courseNotation: z.string().nullable(),
  /** Associated LH source folder. */
  lhSourceFolder: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
  archivedAt: IsoDateTimeSchema.nullable(),
});
export type Subject = z.infer<typeof SubjectSchema>;

/** GET /subjects — all of them, including archived ones (`archivedAt` ≠ null); the client filters. */
export const SubjectListSchema = z.array(SubjectSchema);

/** POST /subjects and MCP `create_subject`. The Hub derives the `slug` from the name (409 `slug_taken` on collision). */
export const CreateSubjectBodySchema = z.object({
  name: z.string().trim().min(1).max(200),
  kind: SubjectKindSchema.default("general"),
  courseNotation: z.string().max(5000).optional(),
  lhSourceFolder: z.string().max(500).optional(),
});
export type CreateSubjectBody = z.infer<typeof CreateSubjectBodySchema>;

/** PATCH /subjects/:id — `archived: true` archives, `false` unarchives. `null` clears an optional field. */
export const PatchSubjectBodySchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    kind: SubjectKindSchema.optional(),
    courseNotation: z.string().max(5000).nullable().optional(),
    lhSourceFolder: z.string().max(500).nullable().optional(),
    archived: z.boolean().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, "empty body");
export type PatchSubjectBody = z.infer<typeof PatchSubjectBodySchema>;

// ---------------------------------------------------------------- map

export const EdgeRelationSchema = z.enum(["requires", "illustrates"]);
export const EdgeConfidenceSchema = z.enum(["high", "medium", "low"]);
export const EdgeSourceSchema = z.enum(["derived", "curator", "manual"]);

/** Edge A → B: "B requires A" (`concept_edges`). `removed` ones are not sent. */
export const ConceptEdgeSchema = z.object({
  from: IdSchema,
  to: IdSchema,
  relation: EdgeRelationSchema,
  /** `low` ones do not count for warnings or inference; the PWA may render them faded. */
  confidence: EdgeConfidenceSchema,
  chainSupport: z.number().int().nonnegative(),
  source: EdgeSourceSchema,
  justification: z.string().nullable(),
});
export type ConceptEdge = z.infer<typeof ConceptEdgeSchema>;

/** Map node: active concept with its effective state. */
export const MapConceptSchema = z.object({
  id: IdSchema,
  name: z.string(),
  description: z.string(),
  computable: z.boolean(),
  optional: z.boolean(),
  state: ConceptStateSchema,
  /** P' (with decay); null without evidence. */
  probability: z.number().min(0).max(1).nullable(),
  stale: z.boolean(),
  manualConfirmation: ManualConfirmationSchema.nullable(),
  /** `active` templates. */
  templateCount: z.number().int().nonnegative(),
  /** Live propositions assigned. */
  propositionCount: z.number().int().nonnegative(),
});
export type MapConcept = z.infer<typeof MapConceptSchema>;

/** GET /subjects/:id/map — active concepts + non-removed edges between them. */
export const SubjectMapSchema = z.object({
  subject: SubjectSchema,
  concepts: z.array(MapConceptSchema),
  edges: z.array(ConceptEdgeSchema),
});
export type SubjectMap = z.infer<typeof SubjectMapSchema>;

const overviewConcept = z.object({
  conceptId: IdSchema,
  name: z.string(),
  probability: z.number().min(0).max(1).nullable(),
  stale: z.boolean(),
  manualConfirmation: ManualConfirmationSchema.nullable(),
});

/** GET /subjects/:id/overview and MCP `get_subject_overview`. */
export const SubjectOverviewSchema = z.object({
  subject: SubjectSchema,
  conceptsByState: z.object({
    solid: z.array(overviewConcept),
    review: z.array(overviewConcept),
    weak: z.array(overviewConcept),
    unknown: z.array(overviewConcept),
  }),
  exams: z.array(ExamSchema),
  recurringErrors: z.array(
    z.object({ templateId: IdSchema, template: z.string(), errorKey: z.string(), error: z.string(), timesSeen: z.number().int().min(1) }),
  ),
});
export type SubjectOverview = z.infer<typeof SubjectOverviewSchema>;
