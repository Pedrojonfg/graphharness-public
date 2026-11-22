// MCP tools of the PRACTICE lane: answer_confirmation.
import { answerConfirmationItem } from "../services/confirmations.ts";
import type { McpHandlers } from "./types.ts";

export const practiceTools: McpHandlers = {
  /** Confirmation on the spot: deterministic grading → `confirmation` event. Output: {correct, conceptState, expectedAnswer}. */
  answer_confirmation: async (ctx, input: { itemId: string; answer: unknown }) => {
    const r = await answerConfirmationItem(ctx, { itemId: input.itemId, answer: input.answer });
    return { correct: r.correct, conceptState: r.conceptState, expectedAnswer: r.expectedAnswer };
  },
};
