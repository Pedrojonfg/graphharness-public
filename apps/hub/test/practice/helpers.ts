// Shared utilities for the tests of the PRACTICE lane (hub and worker). Not a test.
// Written from the contract: it assumes neither task names nor the exact shape of the LLM's outputs; the fake LLM
// picks, among several plausible shapes, the first one accepted by the `jsonSchema` the implementation asks for.
import { isoNow, ulid } from "@graphharness/core";
import type { Db } from "@graphharness/db";
import type { LlmRequest } from "@graphharness/llm";
import type { Hono } from "hono";
import type { HubContext } from "../../src/services/context.ts";
import { fakeLlm } from "../../src/testing.ts";

// Real recipes (apps/eval/tests/test_recipes.py and test_errors_reproduce.py).
export const DERIVATIVE = {
  version: 1,
  statement: "Differentiate $f(x) = [[a]] x^3 + [[b]] x$.",
  params: [
    { name: "a", kind: "int", min: -9, max: 9, nonzero: true },
    { name: "b", kind: "int", min: -9, max: 9, nonzero: true },
  ],
  variables: ["x"],
  answer: { kind: "expression", expr: "diff(a*x^3 + b*x, x)" },
  errors: [{ key: "power_not_lowered", description: "Does not lower the exponent", expr: "3*a*x^3 + b" }],
};

export const INVERSE = {
  version: 1,
  statement: "Compute the inverse of the matrix $A = [[A]]$.",
  params: [{ name: "A", kind: "matrix", rows: 2, cols: 2, min: -6, max: 6 }],
  constraints: ["Abs(det(A)) >= 2", "Abs(det(A)) <= 4"],
  answer: { kind: "matrix", expr: "inv(A)" },
  errors: [
    { key: "transpose_instead", description: "Transposes instead of inverting", expr: "transpose(A)" },
    { key: "forgot_det", description: "Forgets to divide by the determinant", expr: "det(A) * inv(A)" },
  ],
};

export const T0 = "2026-11-10T09:00:00.000Z";
export const DAY_MS = 86_400_000;

// ── HTTP ────────────────────────────────────────────────────────────────────────────────

export async function call(app: Hono, method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await app.request(`/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text; // if it is not JSON, a test that inspects the body will fail with the text in plain view
  }
  return { status: res.status, json };
}

// ── Generic fake LLM ──────────────────────────────────────────────────────────────────

export type Kind = "confirmation" | "hint" | "explain" | "hypothesis" | "template" | "cards" | "other";

/** Classifies the implementation's task name (whatever it is) into the test's intent. */
export function kindOf(task: string): Kind {
  if (/confirm/i.test(task)) return "confirmation";
  if (/hint|pista/i.test(task)) return "hint";
  if (/explain|explic/i.test(task)) return "explain";
  if (/hypoth|hipot/i.test(task)) return "hypothesis";
  if (/templ|plantilla|recipe|receta|method|metodo/i.test(task)) return "template";
  if (/card|flash/i.test(task)) return "cards";
  return "other";
}

export type LlmSpec = Partial<Record<Kind, (req: LlmRequest) => unknown[]>>;

/**
 * `fakeLlm` per intent. Each function returns candidates (plausible shapes of the same response); the first one that
 * passes the request's `jsonSchema` is used (or the first, if it asks for no schema). No simulated response → fails.
 */
export function llmFor(spec: LlmSpec) {
  const responders = new Proxy({} as Record<string, (req: LlmRequest) => string | object>, {
    get: (_t, task: string) => (req: LlmRequest) => {
      const kind = kindOf(task);
      const make = spec[kind];
      if (!make) throw new Error(`llmFor: the test does not simulate the intent "${kind}" (task "${task}")`);
      const candidates = make(req);
      if (!req.jsonSchema) return candidates[0] as string | object;
      for (const c of candidates) if (req.jsonSchema.safeParse(c).success) return c as object;
      const issues = req.jsonSchema.safeParse(candidates[0]);
      throw new Error(`llmFor: no candidate matches the schema of "${task}": ${JSON.stringify(issues.success ? null : issues.error.issues)}`);
    },
  });
  return fakeLlm(responders);
}

/** How many LLM calls an intent received. */
export const callsOf = (llm: { calls: LlmRequest[] }, kind: Kind): LlmRequest[] => llm.calls.filter((c) => kindOf(c.task) === kind);

export const hintCandidates = (t: string): unknown[] => [{ hint: t }, { text: t }, { pista: t }, { message: t }, { description: t }, { content: t }, { reformulation: t }, t];

export const hypothesisCandidates = (h: { key: string; description: string; expr: string }): unknown[] => [
  h,
  { ...h, explanation: "Test hypothesis", rationale: "Test hypothesis" },
  { hypothesis: h },
  { candidate: h },
  { error: h },
];

export function templateCandidates(recipe: unknown, over: { name?: string; summary?: string; limits?: string } = {}): unknown[] {
  const name = over.name ?? "Derivative of a polynomial";
  const summary = over.summary ?? "1. Lower the exponent. 2. Subtract one from the exponent.";
  const limits = over.limits ?? "Only valid for integer powers.";
  return [
    { name, title: name, methodSummary: summary, method_summary: summary, methodLimits: limits, method_limits: limits, recipe },
    { name, methodSummary: summary, methodLimits: limits, recipe },
    { name, method_summary: summary, method_limits: limits, recipe },
  ];
}

export function explainCandidates(summary: string, steps: { text: string; formulas: string[] }[]): unknown[] {
  const pair = (f: string) => ({ latex: f, left: f.split("=")[0], right: f.split("=")[1] });
  return [
    { summary, steps: steps.map((s) => ({ text: s.text, formulas: s.formulas })) },
    { summary, steps: steps.map((s) => ({ text: s.text, formulas: s.formulas.map(pair) })) },
    { summary, steps: steps.map((s) => ({ text: s.text, formulas: s.formulas.map((f) => ({ latex: f })) })) },
    { summary, steps: steps.map((s) => ({ text: s.text, formulas: s.formulas, latex: s.formulas })) },
  ];
}

export interface CardSpec {
  kind: "cloze" | "text" | "mcq";
  front: string;
  answer?: string;
  accepted?: string[];
  /** mcq only: text and whether it is correct. */
  options?: { text: string; correct: boolean }[];
}

/** LLM cards with all the field aliases at once (a non-strict schema ignores the ones it does not use). */
export function cardsCandidates(cards: CardSpec[]): unknown[] {
  const one = (c: CardSpec, asStrings: boolean) => ({
    kind: c.kind,
    type: c.kind,
    front: c.front,
    question: c.front,
    prompt: c.front,
    text: c.front,
    ...(c.answer === undefined
      ? {}
      : { answer: c.answer, back: c.answer, correctAnswer: c.answer, accepted: c.accepted ?? [], acceptedAnswers: c.accepted ?? [], variants: c.accepted ?? [] }),
    ...(c.options
      ? {
          options: asStrings
            ? c.options.map((o) => o.text)
            : c.options.map((o, i) => ({ id: `o${i}`, text: o.text, value: o.text, label: o.text, correct: o.correct, isCorrect: o.correct })),
          correctIndex: c.options.findIndex((o) => o.correct),
          correctIndexes: c.options.flatMap((o, i) => (o.correct ? [i] : [])),
        }
      : {}),
  });
  return [false, true].map((asStrings) => {
    const list = cards.map((c) => one(c, asStrings));
    return { cards: list, items: list, flashcards: list };
  });
}

// ── SQL seeds and reads ─────────────────────────────────────────────────────────────

/** Validates the recipe with the REAL eval and saves it as a template (recipe errors go to template_errors). */
const VALIDATION_CACHE = new Map<string, Awaited<ReturnType<HubContext["evalApi"]["validateRecipe"]>>>();

export async function seedTemplate(
  ctx: HubContext,
  o: { conceptId: string; recipe?: unknown; status?: "active" | "failed" | "retired" },
): Promise<{ templateId: string; recipe: any }> {
  // Setup: validation is deterministic (seed 0); it is cached per recipe so ~5 s of eval per seeded template is not repeated.
  const raw = JSON.stringify(o.recipe ?? DERIVATIVE);
  const v = VALIDATION_CACHE.get(raw) ?? (await ctx.evalApi.validateRecipe(JSON.parse(raw) as Record<string, unknown>));
  VALIDATION_CACHE.set(raw, v);
  if (!v.ok || !v.recipe) throw new Error(`invalid test recipe: ${v.problems.join("; ")}`);
  const id = ulid();
  const db = ctx.db as Db;
  db.prepare(
    `INSERT INTO templates (id, concept_id, slug, name, method_summary, method_limits, recipe_json, level, status, validation_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'base', ?, ?, ?)`,
  ).run(id, o.conceptId, `template-${id.slice(-8).toLowerCase()}`, "Derivative of a polynomial", "1. Lower the exponent.\n2. Subtract one from the exponent.", "Only integer powers.", JSON.stringify(v.recipe), o.status ?? "active", JSON.stringify(v), isoNow(ctx.now()));
  for (const e of (v.recipe as any).errors as { key: string; description: string; expr: string }[])
    db.prepare("INSERT INTO template_errors (id, template_id, key, description, expr, origin) VALUES (?, ?, ?, ?, ?, 'recipe')").run(ulid(), id, e.key, e.description, e.expr);
  return { templateId: id, recipe: v.recipe };
}

export interface SeedCard {
  id?: string;
  conceptId?: string | null;
  kind?: "mcq" | "cloze" | "text" | "parsons" | "predict" | "spot_bug";
  purpose?: "review" | "confirmation";
  front?: string;
  options?: { id: string; value: string }[] | null;
  lines?: { id: string; text: string; indent?: number; distractor?: boolean }[];
  figureId?: string | null;
  answer?: unknown;
  ease?: number;
  intervalDays?: number;
  repetitions?: number;
  tRefMs?: number;
  reviewed?: boolean;
  retired?: boolean;
  createdAt?: string;
  declarationId?: string | null;
  instanceId?: string | null;
}

export function seedCard(ctx: HubContext, o: SeedCard = {}): string {
  const id = o.id ?? ulid();
  const kind = o.kind ?? "text";
  const optionsJson =
    o.lines !== undefined
      ? JSON.stringify(o.lines)
      : o.options === undefined
        ? kind === "mcq"
          ? JSON.stringify([{ id: "o1", value: "4" }, { id: "o2", value: "5" }])
          : null
        : o.options && JSON.stringify(o.options);
  ctx.db.prepare(
    `INSERT INTO cards (id, concept_id, kind, purpose, front_text, instance_id, options_json, answer_json, declaration_id,
       ease, interval_days, repetitions, t_ref, reviewed, retired, created_at, figure_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    o.conceptId ?? null,
    kind,
    o.purpose ?? "review",
    o.front ?? "Question $x$",
    o.instanceId ?? null,
    optionsJson,
    JSON.stringify(o.answer ?? (kind === "mcq" ? { optionId: "o1" } : { text: "answer", accepted: [] })),
    o.declarationId ?? null,
    o.ease ?? 2.5,
    o.intervalDays ?? 1,
    o.repetitions ?? 0,
    o.tRefMs ?? ctx.now().getTime(),
    o.reviewed ? 1 : 0,
    o.retired ? 1 : 0,
    o.createdAt ?? isoNow(ctx.now()),
    o.figureId ?? null,
  );
  return id;
}

export function seedDeclaration(ctx: HubContext, conceptId: string, target: "solid" | "review" | "weak" = "review"): string {
  const id = ulid();
  ctx.db.prepare(
    "INSERT INTO declarations (id, concept_id, target_state, justification, origin, raw_text, status, created_at) VALUES (?, ?, ?, 'Class today', 'agent', 'text', 'pending', ?)",
  ).run(id, conceptId, target, isoNow(ctx.now()));
  return id;
}

export const rows = (db: Db, sql: string, ...args: unknown[]): any[] => db.prepare(sql).all(...args);
export const row = (db: Db, sql: string, ...args: unknown[]): any => db.prepare(sql).get(...args);

export function evidenceOf(db: Db, conceptId: string, source?: string): any[] {
  return source
    ? rows(db, "SELECT * FROM evidence_events WHERE concept_id = ? AND source = ? ORDER BY at, id", conceptId, source)
    : rows(db, "SELECT * FROM evidence_events WHERE concept_id = ? ORDER BY at, id", conceptId);
}

/** Stored probability of concept_state (no decay). */
export const storedP = (db: Db, conceptId: string): number | undefined => row(db, "SELECT probability FROM concept_state WHERE concept_id = ?", conceptId)?.probability;

/** Full payload (with solution) of an instance, read from the DB: only so the test knows what to answer. */
export const instancePayload = (db: Db, instanceId: string): any => JSON.parse(row(db, "SELECT payload_json FROM instances WHERE id = ?", instanceId).payload_json);

/** Latest payload generated for a template. */
export const lastInstance = (db: Db, templateId: string): { id: string; payload: any } => {
  const r = row(db, "SELECT id, payload_json FROM instances WHERE template_id = ? ORDER BY created_at DESC, id DESC LIMIT 1", templateId);
  return { id: r.id, payload: JSON.parse(r.payload_json) };
};

/** Id of the correct option: the one equal to the instance's `mcq.correct` whose options (correct + errors) match. */
export function correctOptionId(db: Db, options: { id: string; value: unknown }[]): string {
  const key = (v: unknown) => JSON.stringify(v);
  const want = options.map((o) => key(o.value)).sort();
  for (const r of rows(db, "SELECT payload_json FROM instances")) {
    const p = JSON.parse(r.payload_json) as { mcq: { correct: unknown; distractors: Record<string, unknown> } };
    const have = [p.mcq.correct, ...Object.values(p.mcq.distractors)].map(key).sort();
    if (JSON.stringify(have) !== JSON.stringify(want)) continue;
    const hit = options.find((o) => key(o.value) === key(p.mcq.correct));
    if (hit) return hit.id;
  }
  throw new Error("no instance matches the given options");
}

/** Answer with the personal error "flips the sign of the linear term": 3a·x² − b. */
export const signFlipAnswer = (payload: { params: Record<string, unknown> }): string =>
  `(${3 * Number(payload.params.a)})*x^2 - (${Number(payload.params.b)})`;

export function makeJob(type: string, payload: Record<string, unknown>) {
  return { id: ulid(), type, payload, status: "running" as const, attempts: 1, runAfter: T0, lastError: null };
}
