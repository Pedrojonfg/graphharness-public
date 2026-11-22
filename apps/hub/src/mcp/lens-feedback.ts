// MCP tool of ADR 109: list_lens_feedback (read-only; the vote is written by LH via POST /lens-feedback).
import { LensFeedbackQuerySchema } from "@graphharness/contracts";
import { listLensFeedback } from "../services/lens-feedback.ts";
import type { McpHandlers } from "./types.ts";

export const lensFeedbackTools: McpHandlers = {
  list_lens_feedback: (ctx, input) => listLensFeedback(ctx, LensFeedbackQuerySchema.parse(input)),
};
