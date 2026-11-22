// PWA inbox (ADR 102 §12): GET /inbox.
// Assigning a subject to a concept from `unassignedConcepts` is done with PATCH /concepts/:id `{subjectId}`.
import { z } from "zod";
import { IdSchema, IsoDateTimeSchema } from "./common.ts";
import { ConceptSuggestionListSchema } from "./concepts.ts";

export const InboxSchema = z.object({
  /** Active concepts with `subject_id` NULL ("no subject"). */
  unassignedConcepts: z.array(
    z.object({ conceptId: IdSchema, name: z.string(), description: z.string(), propositionCount: z.number().int().nonnegative() }),
  ),
  /** Open curator suggestions, same as GET /concept-suggestions. */
  suggestions: ConceptSuggestionListSchema,
  /** `failed` templates ("methods that could not be automated"); `problems` from the last eval validation. */
  failedTemplates: z.array(
    z.object({ templateId: IdSchema, conceptId: IdSchema, conceptName: z.string(), problems: z.array(z.string()), createdAt: IsoDateTimeSchema }),
  ),
  /** `unknown_errors` in `open` or `rejected`. */
  unknownErrors: z.array(
    z.object({
      id: IdSchema,
      templateId: IdSchema,
      templateName: z.string(),
      conceptName: z.string(),
      hypothesis: z.object({ key: z.string(), description: z.string(), expr: z.string() }).nullable(),
      status: z.enum(["open", "rejected"]),
      createdAt: IsoDateTimeSchema,
    }),
  ),
  /** Active concepts without live propositions (a schema invariant): for review. */
  orphanConcepts: z.array(z.object({ conceptId: IdSchema, name: z.string() })),
});
export type Inbox = z.infer<typeof InboxSchema>;
