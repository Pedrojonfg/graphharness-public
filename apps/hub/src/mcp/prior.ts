// MCP tools for prior knowledge and the syllabus (ADR 105 §6).
import { GetPriorKnowledgeInputSchema, GetSyllabusGapsInputSchema, ImportSyllabusInputSchema } from "@graphharness/contracts";
import { getPriorReport, latestPriorReport } from "../services/prior.ts";
import { putSyllabus, syllabusGaps } from "../services/syllabus.ts";
import { HubError } from "../errors.ts";
import type { McpHandlers } from "./types.ts";

export const priorTools: McpHandlers = {
  get_prior_knowledge: async (ctx, input) => {
    const { reportId, subjectId } = GetPriorKnowledgeInputSchema.parse(input ?? {});
    if (reportId === undefined) return { report: latestPriorReport(ctx, subjectId) };
    try {
      return { report: getPriorReport(ctx, reportId) };
    } catch (err) {
      if (err instanceof HubError && err.status === 404) return { report: null }; // an id that does not exist is not an error for the agent
      throw err;
    }
  },
  import_syllabus: async (ctx, input) => {
    const { subjectId, text } = ImportSyllabusInputSchema.parse(input);
    return putSyllabus(ctx, subjectId, text);
  },
  get_syllabus_gaps: async (ctx, input) => syllabusGaps(ctx, GetSyllabusGapsInputSchema.parse(input).subjectId),
};
