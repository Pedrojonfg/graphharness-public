// MCP tools of the KNOWLEDGE lane. Each input is re-validated with its contracts schema
// (so defaults also apply when the handler is called directly).
import {
  AcceptConceptSuggestionInputSchema,
  AddConceptNoteInputSchema,
  CreateSubjectInputSchema,
  DeclareLearningInputSchema,
  DismissConceptSuggestionInputSchema,
  GetConceptInputSchema,
  GetDailyBriefInputSchema,
  GetWeekPlanInputSchema,
  GetSubjectOverviewInputSchema,
  ListConceptSuggestionsInputSchema,
  ResolveConceptsInputSchema,
  SearchKnowledgeInputSchema,
  type DeclareLearningOutput,
} from "@graphharness/contracts";
import { dailyBrief } from "../services/brief.ts";
import { acceptSuggestion, conceptDetail, dismissSuggestion, listSuggestions } from "../services/concepts.ts";
import { declareLearning } from "../services/declarations.ts";
import { addConceptNote } from "../services/notes.ts";
import { getWeekPlan } from "../services/plan.ts";
import { resolveConcepts, searchKnowledge } from "../services/search.ts";
import { createSubject, subjectOverview } from "../services/subjects.ts";
import type { McpHandlers } from "./types.ts";

export const knowledgeTools: McpHandlers = {
  resolve_concepts: async (ctx, input) => resolveConcepts(ctx, ResolveConceptsInputSchema.parse(input)),
  get_concept: async (ctx, input) => conceptDetail(ctx, GetConceptInputSchema.parse(input).conceptId),
  search_knowledge: async (ctx, input) => searchKnowledge(ctx, SearchKnowledgeInputSchema.parse(input)),
  get_subject_overview: async (ctx, input) => subjectOverview(ctx, GetSubjectOverviewInputSchema.parse(input).subjectId),
  get_daily_brief: async (ctx, input) => dailyBrief(ctx, GetDailyBriefInputSchema.parse(input ?? {}).date),
  get_week_plan: async (ctx, input) => getWeekPlan(ctx, GetWeekPlanInputSchema.parse(input ?? {})),
  declare_learning: async (ctx, input): Promise<DeclareLearningOutput> => {
    const i = DeclareLearningInputSchema.parse(input);
    const r = await declareLearning(ctx, { ...i, origin: "agent" });
    if (r.status === "needs_ack")
      return { status: "needs_ack", weakPrerequisites: r.weakPrerequisites, declarationId: null, conceptState: null, confirmationItems: [] };
    return r;
  },
  add_concept_note: async (ctx, input) => addConceptNote(ctx, { ...AddConceptNoteInputSchema.parse(input), origin: "agent" }),
  create_subject: async (ctx, input) => createSubject(ctx, CreateSubjectInputSchema.parse(input)),
  list_concept_suggestions: async (ctx, input) => ({ suggestions: listSuggestions(ctx, ListConceptSuggestionsInputSchema.parse(input ?? {}).status) }),
  accept_concept_suggestion: async (ctx, input) => acceptSuggestion(ctx, AcceptConceptSuggestionInputSchema.parse(input).suggestionId, "agent"),
  dismiss_concept_suggestion: async (ctx, input) => ({ suggestion: dismissSuggestion(ctx, DismissConceptSuggestionInputSchema.parse(input).suggestionId) }),
};
