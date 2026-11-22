// Search and concept resolution (REST parity with MCP resolve_concepts / search_knowledge).
import { z } from "zod";
import { ConceptStateSchema, IdSchema } from "./common.ts";

export const ResolveConceptsBodySchema = z.object({
  text: z.string().trim().min(1).max(2000),
  subjectId: IdSchema.optional(),
  limit: z.number().int().min(1).max(20).default(8),
});
export type ResolveConceptsBody = z.infer<typeof ResolveConceptsBodySchema>;

export const ResolveConceptsResponseSchema = z.object({
  candidates: z.array(
    z.object({
      conceptId: IdSchema,
      name: z.string(),
      subject: z.string().nullable(),
      score: z.number().min(0).max(1),
      state: ConceptStateSchema,
    }),
  ),
});
export type ResolveConceptsResponse = z.infer<typeof ResolveConceptsResponseSchema>;

export const SearchKnowledgeBodySchema = z.object({
  query: z.string().trim().min(1).max(500),
  subjectId: IdSchema.optional(),
  limit: z.number().int().min(1).max(50).default(20),
});
export type SearchKnowledgeBody = z.infer<typeof SearchKnowledgeBodySchema>;

export const SearchKnowledgeResponseSchema = z.object({
  concepts: z.array(
    z.object({
      conceptId: IdSchema,
      name: z.string(),
      description: z.string(),
      subject: z.string().nullable(),
      state: ConceptStateSchema,
    }),
  ),
  propositions: z.array(
    z.object({
      propositionId: IdSchema,
      name: z.string(),
      statement: z.string(),
      conceptId: IdSchema.nullable(),
      conceptName: z.string().nullable(),
    }),
  ),
});
export type SearchKnowledgeResponse = z.infer<typeof SearchKnowledgeResponseSchema>;
