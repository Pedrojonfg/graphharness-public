// Ported from graphlearn/apps/api/src/diagnostic/mcq.ts (65b56d6).
// Utilities of the PRACTICE lane: state view, boundaries with eval and the LLM, shuffled MCQs.
import { randomUUID } from "node:crypto";
import type { AnswerValue, ConceptStateView, McqOption } from "@graphharness/contracts";
import { fillPrompt, LlmJsonError, LlmError, loadPrompt, type LlmTier } from "@graphharness/llm";
import type { ZodType, ZodTypeDef } from "zod";
import { HubError } from "../errors.ts";
import type { HubContext } from "./context.ts";
import type { RecipeInstancePayload } from "./eval-client.ts";
import { effectiveStates } from "./evidence.ts";

/** Effective state of a concept at `ctx.now()` in the contracts shape. */
export function conceptStateView(ctx: HubContext, conceptId: string): ConceptStateView {
  const s = effectiveStates(ctx.db, ctx.now(), [conceptId]).get(conceptId)!;
  return {
    conceptId,
    state: s.state,
    probability: s.probability,
    stale: s.stale,
    manualConfirmation: s.manualConfirmation,
    lastEvidenceAt: s.updatedAt,
  };
}

/** Call to eval from a route: any eval failure → 502 eval_unavailable (API_ROUTES). */
export async function withEval<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HubError) throw err;
    throw new HubError(502, { error: "eval_unavailable", message: err instanceof Error ? err.message : String(err) });
  }
}

/** Call to the LLM from a route: no valid JSON → 502 llm_bad_output; down → 502 llm_unavailable. */
export async function withLlm<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof LlmJsonError) throw new HubError(502, { error: "llm_bad_output", message: err.message });
    if (err instanceof LlmError) throw new HubError(502, { error: "llm_unavailable", message: err.message });
    throw err;
  }
}

/** Versioned prompt `packages/llm/prompts/<task>.v<N>.md` filled with `vars` → JSON validated with `schema`. */
export async function askJson<T>(
  ctx: HubContext,
  task: string,
  tier: LlmTier,
  vars: Record<string, string | number>,
  schema: ZodType<T, ZodTypeDef, unknown>,
  /** Extra text for the user turn (e.g. eval's problems on a retry). */
  extra?: string,
): Promise<T> {
  const p = loadPrompt(task);
  const r = await ctx.llm.complete<T>({
    task,
    tier,
    system: fillPrompt(p.text, vars),
    messages: [{ role: "user", content: `${extra ? `${extra}\n\n` : ""}Return ONLY the requested JSON object, with no surrounding text.` }],
    jsonSchema: schema as ZodType<T>,
    promptVersion: p.version,
  });
  return r.json as T;
}

/** Fisher–Yates: the order of the options is decided by code, never by the LLM (GL-006). */
export function shuffle<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export interface StoredMcqOption extends McqOption {
  /** null = the correct option; otherwise, the key of the typical error (or eval's `choice_i`) that produces it. */
  errorKey: string | null;
}

/** Maximum number of options of an MCQ (CardSchema allows 2–8). */
export const MAX_MCQ_OPTIONS = 7;

/**
 * Options of an MCQ over an instance (D14): the correct one + the results of typical errors that
 * eval computed on THAT instance (`payload.mcq`), shuffled. null if eval gave no distractor.
 */
export function mcqOptionsFromPayload(payload: RecipeInstancePayload): StoredMcqOption[] | null {
  const correct = payload.mcq?.correct ?? payload.answer;
  const seen = new Set([JSON.stringify(correct)]);
  const wrong: StoredMcqOption[] = [];
  for (const [key, value] of Object.entries(payload.mcq?.distractors ?? {})) {
    const k = JSON.stringify(value);
    if (seen.has(k)) continue;
    seen.add(k);
    wrong.push({ id: randomUUID(), value: value as AnswerValue, errorKey: key });
  }
  if (wrong.length === 0) return null;
  return shuffle([{ id: randomUUID(), value: correct as AnswerValue, errorKey: null }, ...wrong.slice(0, MAX_MCQ_OPTIONS - 1)]);
}

export const publicOptions = (opts: readonly StoredMcqOption[]): McqOption[] => opts.map((o) => ({ id: o.id, value: o.value }));
