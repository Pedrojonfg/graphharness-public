// HTTP client for eval. eval decides whether an answer is correct; the Hub never does so on its own (golden rule).
import { CODE_COMPREHENSION_EVALUATOR_KEY, RECIPE_EVALUATOR_KEY, type RecipeValidation } from "@graphharness/contracts";

/** Output of eval /v1/generate for recipe_v1 (includes the solution: it NEVER goes to the client). */
export interface RecipeInstancePayload {
  recipeVersion: 1;
  statement: string;
  params: Record<string, unknown>;
  answerKind: "number" | "expression" | "matrix" | "vector" | "choice";
  shape: Record<string, number> | null;
  variables: string[];
  choices?: string[] | null;
  answer: unknown;
  /** error key → value serialised over this instance. */
  errors: Record<string, unknown>;
  mcq: { correct: unknown; distractors: Record<string, unknown> };
}

export interface GradeResult {
  correct: boolean;
  /** Key of the recognised error; "unreadable_answer" if it could not be read. */
  detectorKey?: string | null;
}

/** Output of eval /v1/generate for code_comprehension_v1 (includes the solution: it NEVER goes to the client). */
export interface CodeComprehensionInstancePayload {
  comprehensionVersion: 1;
  kind: "parsons" | "faded_parsons" | "predict" | "spot_bug";
  statement: string;
  lines: { key: string; text: string; indent: number; distractor?: true }[];
  order: string[];
  blanks?: { lineKey: string; answer: string; accepted?: string[] }[];
  expectedOutput?: string;
  accepted?: string[];
  buggyKey?: string;
  language?: string;
  distractorsAdaptive?: boolean;
  distractorCount?: number;
}

export type InstancePayload = RecipeInstancePayload | CodeComprehensionInstancePayload;

export interface CodeComprehensionValidation {
  ok: boolean;
  problems: string[];
  recipe: Record<string, unknown> | null;
  sample?: Record<string, unknown> | null;
}

export interface ReproduceResult {
  ok: boolean;
  reproducesUser: boolean;
  distinguishable: boolean;
  problems: string[];
}

export class EvalError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super(`eval responded ${status}: ${body.slice(0, 300)}`);
    this.name = "EvalError";
    this.status = status;
    this.body = body;
  }
}

export function createEvalClient({ baseUrl, fetch: f = fetch, timeoutMs = 60_000 }: { baseUrl: string; fetch?: typeof fetch; timeoutMs?: number }) {
  async function post<T>(path: string, body: unknown): Promise<T> {
    const res = await f(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new EvalError(res.status, text);
    return JSON.parse(text) as T;
  }
  return {
    async health(): Promise<boolean> {
      try {
        const res = await f(`${baseUrl}/health`, { signal: AbortSignal.timeout(5_000) });
        return res.ok;
      } catch {
        return false; // /health only needs to know whether it responds
      }
    },
    async generate(recipe: Record<string, unknown>): Promise<RecipeInstancePayload> {
      const r = await post<{ payload: RecipeInstancePayload }>("/v1/generate", {
        evaluatorKey: RECIPE_EVALUATOR_KEY,
        generationSpec: { recipe },
        stepId: "hub",
      });
      return r.payload;
    },
    grade(payload: RecipeInstancePayload, result: unknown): Promise<GradeResult> {
      return post<GradeResult>("/v1/grade", { evaluatorKey: RECIPE_EVALUATOR_KEY, payload, stepId: "hub", userInput: { result } });
    },
    async generateCode(recipe: Record<string, unknown>, seed = 0): Promise<CodeComprehensionInstancePayload> {
      const r = await post<{ payload: CodeComprehensionInstancePayload }>("/v1/generate", {
        evaluatorKey: CODE_COMPREHENSION_EVALUATOR_KEY,
        generationSpec: { recipe, seed },
        stepId: "hub",
      });
      return r.payload;
    },
    gradeCode(payload: CodeComprehensionInstancePayload, userInput: { given?: unknown; result?: unknown }): Promise<GradeResult> {
      return post<GradeResult>("/v1/grade", {
        evaluatorKey: CODE_COMPREHENSION_EVALUATOR_KEY,
        payload,
        stepId: "hub",
        userInput,
      });
    },
    validateCodeComprehension(recipe: Record<string, unknown>, seed = 0): Promise<CodeComprehensionValidation> {
      return post<CodeComprehensionValidation>("/v1/code-comprehension/validate", { recipe, seed });
    },
    async verifyLatex(latexLeft: string, latexRight: string): Promise<boolean> {
      return (await post<{ equivalent: boolean }>("/v1/formulas/verify", { latexLeft, latexRight })).equivalent;
    },
    async verifySympy(left: string, right: string): Promise<boolean> {
      return (await post<{ equivalent: boolean }>("/v1/formulas/verify", { left, right })).equivalent;
    },
    validateRecipe(recipe: Record<string, unknown>, seed = 0): Promise<RecipeValidation> {
      return post<RecipeValidation>("/v1/recipes/validate", { recipe, seed });
    },
    reproduceError(input: {
      recipe: Record<string, unknown>;
      instancePayload: RecipeInstancePayload;
      userInput: { result: unknown };
      candidate: { key: string; description: string; expr: string };
      samples?: number;
    }): Promise<ReproduceResult> {
      return post<ReproduceResult>("/v1/errors/reproduce", { samples: 5, ...input });
    },
  };
}

export type EvalClient = ReturnType<typeof createEvalClient>;
