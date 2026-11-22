// Method templates (D9) and eval instances (ADR 102 point 14).
import { isoNow, ulid } from "@graphharness/core";
import { TemplateRecipeSchema, type ClientInstance, type TemplateRecipe } from "@graphharness/contracts";
import type { Db } from "@graphharness/db";
import { z } from "zod";
import { conflict, notFound } from "../errors.ts";
import type { HubContext } from "./context.ts";
import type { CodeComprehensionInstancePayload, InstancePayload, RecipeInstancePayload } from "./eval-client.ts";

const CODE_RECIPE_KINDS = new Set(["parsons", "faded_parsons", "predict", "spot_bug"]);

/** Recipe of a code-comprehension template (ADR 108). */
export function isCodeRecipe(recipe: Record<string, unknown>): boolean {
  if (recipe.comprehensionVersion === 1) return true;
  const k = recipe.kind;
  return typeof k === "string" && CODE_RECIPE_KINDS.has(k);
}

function stripCodeClient(full: CodeComprehensionInstancePayload): ClientInstance {
  const hide = new Set(["order", "expectedOutput", "accepted", "buggyKey", "blanks"]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(full)) {
    if (!hide.has(k)) out[k] = v;
  }
  return out as ClientInstance;
}
import { askJson } from "./practice-common.ts";

/** `MAX_ERRORS` of eval/app/recipes.py: a recipe carries at most 6 errors. */
export const MAX_RECIPE_ERRORS = 6;

export interface TemplateRow {
  id: string;
  concept_id: string;
  slug: string;
  name: string;
  method_summary: string | null;
  method_limits: string | null;
  recipe_json: string;
  level: string;
  status: "active" | "failed" | "retired";
  created_at: string;
}

export function getTemplate(db: Db, id: string): TemplateRow | undefined {
  return db.prepare("SELECT * FROM templates WHERE id = ?").get(id) as TemplateRow | undefined;
}

/** The concept's first active template (the oldest), or undefined. */
export function activeTemplateOf(db: Db, conceptId: string): TemplateRow | undefined {
  return db.prepare("SELECT * FROM templates WHERE concept_id = ? AND status = 'active' ORDER BY created_at, id LIMIT 1").get(conceptId) as
    | TemplateRow
    | undefined;
}

/**
 * Recipe sent to eval (ADR 102 point 14): the stored one with up to 6 errors — first the personal ones by
 * descending `times_seen`, then those of the recipe.
 */
export function recipeForInstance(db: Db, template: TemplateRow): Record<string, unknown> {
  const recipe = JSON.parse(template.recipe_json) as Record<string, unknown>;
  const errors = db
    .prepare(
      `SELECT key, description, expr FROM template_errors WHERE template_id = ?
       ORDER BY CASE origin WHEN 'personal' THEN 0 ELSE 1 END, CASE origin WHEN 'personal' THEN -times_seen ELSE 0 END, rowid`,
    )
    .all(template.id) as { key: string; description: string; expr: string }[];
  return { ...recipe, errors: errors.slice(0, MAX_RECIPE_ERRORS) };
}

/** What the client sees of an instance (`client_json`): without solution, errors, mcq or params. */
export function clientPayloadOf(p: InstancePayload): ClientInstance {
  if ("comprehensionVersion" in p && p.comprehensionVersion === 1) return stripCodeClient(p);
  const r = p as RecipeInstancePayload;
  return {
    recipeVersion: 1,
    statement: r.statement,
    answerKind: r.answerKind,
    shape: r.shape ?? null,
    variables: r.variables ?? [],
    choices: r.choices ?? null,
  };
}

export interface CreatedInstance {
  id: string;
  template: TemplateRow;
  payload: InstancePayload;
  client: ClientInstance;
}

/** eval /v1/generate with the template's recipe → row of `instances`. Throws 404 / 409 template_not_active. */
export async function createInstance(ctx: HubContext, templateId: string): Promise<CreatedInstance> {
  const template = getTemplate(ctx.db, templateId);
  if (!template) throw notFound();
  if (template.status !== "active") throw conflict("template_not_active");
  const recipe = recipeForInstance(ctx.db, template);
  const payload = isCodeRecipe(recipe) ? await ctx.evalApi.generateCode(recipe) : await ctx.evalApi.generate(recipe);
  const client = clientPayloadOf(payload);
  const now = ctx.now();
  const id = ulid(now.getTime());
  ctx.db
    .prepare("INSERT INTO instances (id, template_id, payload_json, client_json, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, template.id, JSON.stringify(payload), JSON.stringify(client), isoNow(now));
  return { id, template, payload, client };
}

/**
 * Hub-owned key inside `instances.payload_json` (ADR 103 point 4): hints requested before the first attempt.
 * it lives on the instance to avoid a schema migration; `getInstance` splits it off, so it never reaches eval.
 */
const PRE_ATTEMPT_HINTS_KEY = "hubHintsBeforeAttempt";

export interface InstanceRow {
  id: string;
  template_id: string;
  /** eval's output as is (without Hub keys). */
  payload: InstancePayload;
  client: ClientInstance;
  /** Hints requested before the first attempt. */
  hintsBeforeAttempt: number;
}

export function getInstance(db: Db, id: string): InstanceRow | undefined {
  const r = db.prepare("SELECT id, template_id, payload_json, client_json FROM instances WHERE id = ?").get(id) as
    | { id: string; template_id: string; payload_json: string; client_json: string }
    | undefined;
  if (!r) return undefined;
  const { [PRE_ATTEMPT_HINTS_KEY]: hints, ...payload } = JSON.parse(r.payload_json) as InstancePayload & Record<string, unknown>;
  return {
    id: r.id,
    template_id: r.template_id,
    payload: payload as InstancePayload,
    client: JSON.parse(r.client_json),
    hintsBeforeAttempt: typeof hints === "number" ? hints : 0,
  };
}

/** Adds one hint requested before the first attempt. */
export function addPreAttemptHint(db: Db, instanceId: string): void {
  db.prepare(
    `UPDATE instances SET payload_json = json_set(payload_json, '$.${PRE_ATTEMPT_HINTS_KEY}', coalesce(json_extract(payload_json, '$.${PRE_ATTEMPT_HINTS_KEY}'), 0) + 1) WHERE id = ?`,
  ).run(instanceId);
}

/** Steps of the method sheet (one line per step, without the numbering). */
export function methodSteps(summary: string | null): string[] {
  return (summary ?? "")
    .split("\n")
    .map((l) => l.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, "").trim())
    .filter((l) => l.length > 0);
}

// ---------------------------------------------------------------- template-generate

const MethodDraftSchema = z.object({
  name: z.string().trim().min(1).max(120),
  methodSummary: z.string().trim().min(1).max(4000),
  methodLimits: z.string().trim().min(1).max(2000),
  recipe: TemplateRecipeSchema,
});
/** Several methods; a single method is also accepted. */
const TemplateDraftSchema = z.union([
  z.object({ methods: z.array(MethodDraftSchema).min(1).max(3) }),
  MethodDraftSchema.transform((m) => ({ methods: [m] })),
]);
type MethodDraft = z.infer<typeof MethodDraftSchema>;

function slugify(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "method";
}

function uniqueSlug(db: Db, base: string, taken: Set<string>): string {
  const exists = (s: string) => taken.has(s) || db.prepare("SELECT 1 FROM templates WHERE slug = ?").get(s) !== undefined;
  let slug = base;
  for (let n = 2; exists(slug); n++) slug = `${base}-${n}`;
  taken.add(slug);
  return slug;
}

const PROMPT_TASK = "template-generate";
const PROMPT_CODE_EXERCISE = "code-exercise-generate";

const CodeMethodDraftSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    methodSummary: z.string().trim().min(1).max(4000).optional(),
    methodLimits: z.string().trim().min(1).max(2000).optional(),
    kind: z.enum(["parsons", "faded_parsons", "predict", "spot_bug"]),
    statement: z.string().trim().min(10).max(1200),
    language: z.string().trim().min(1).max(40).optional(),
    lines: z
      .array(
        z.object({
          key: z.string(),
          text: z.string(),
          indent: z.number().int().min(0).max(8).default(0),
          distractor: z.boolean().optional(),
        }),
      )
      .min(1),
    order: z.array(z.string()).min(1),
    blanks: z.union([z.record(z.string()), z.array(z.record(z.unknown()))]).optional(),
    expectedOutput: z.string().optional(),
    accepted: z.array(z.string()).optional(),
    buggyKey: z.string().optional(),
    buggyLineKey: z.string().optional(),
    distractorsAdaptive: z.boolean().optional(),
  })
  .transform((m) => {
    const buggyKey = m.buggyKey ?? m.buggyLineKey;
    const recipe: Record<string, unknown> = {
      version: 1,
      kind: m.kind,
      statement: m.statement,
      lines: m.lines,
      order: m.order,
    };
    if (m.language) recipe.language = m.language;
    if (m.blanks !== undefined) recipe.blanks = m.blanks;
    if (m.expectedOutput) recipe.expectedOutput = m.expectedOutput;
    if (m.accepted?.length) recipe.accepted = m.accepted;
    if (buggyKey) recipe.buggyKey = buggyKey;
    if (m.distractorsAdaptive) recipe.distractorsAdaptive = true;
    return {
      name: m.name,
      methodSummary: m.methodSummary ?? `Practice (${m.kind}): ${m.name}`,
      methodLimits: m.methodLimits ?? "One canonical solution; distractors = the concept's usual errors.",
      recipe,
    };
  });

const CodeTemplateDraftSchema = z.union([
  z.object({ methods: z.array(CodeMethodDraftSchema).min(1).max(3) }),
  CodeMethodDraftSchema.transform((m) => ({ methods: [m] })),
]);

/**
 * Method sheet + limits + recipe(s) by the strong LLM, validated in eval; one retry with the `problems`; if it fails
 * again, the template is `failed`. Idempotent: if the concept already has an active template, it does nothing.
 * Returns the ids of the templates created (active and failed).
 */
export async function runTemplateGenerate(ctx: HubContext, conceptId: string): Promise<{ templateIds: string[]; skipped: boolean }> {
  const { db } = ctx;
  const concept = db
    .prepare(
      `SELECT c.id, c.name, c.description, c.computable, c.status, s.name AS subject_name, s.kind AS subject_kind, s.course_notation
       FROM concepts c LEFT JOIN subjects s ON s.id = c.subject_id WHERE c.id = ?`,
    )
    .get(conceptId) as
    | {
        id: string;
        name: string;
        description: string;
        computable: number;
        status: string;
        subject_name: string | null;
        subject_kind: string | null;
        course_notation: string | null;
      }
    | undefined;
  if (!concept || concept.status !== "active" || concept.computable !== 1) return { templateIds: [], skipped: true };
  if (activeTemplateOf(db, conceptId)) return { templateIds: [], skipped: true };

  const propositions = db
    .prepare(
      `SELECT p.statement FROM lh_propositions p JOIN concept_propositions cp ON cp.proposition_id = p.id
       WHERE cp.concept_id = ? AND p.deleted = 0 ORDER BY p.id`,
    )
    .pluck()
    .all(conceptId) as string[];
  const baseVars = {
    conceptName: concept.name,
    conceptDescription: concept.description,
    subjectName: concept.subject_name ?? "(no subject)",
    courseNotation: concept.course_notation?.trim() || "(no notation notes)",
    propositions: propositions.length ? propositions.map((s) => `- ${s}`).join("\n") : "(none)",
  };

  const isProgramming = concept.subject_kind === "programming";
  const promptTask = isProgramming ? PROMPT_CODE_EXERCISE : PROMPT_TASK;
  const draftSchema = isProgramming ? CodeTemplateDraftSchema : TemplateDraftSchema;
  const llmVars = isProgramming ? { ...baseVars, language: "python" } : baseVars;

  const draft = await askJson(ctx, promptTask, "strong", llmVars, draftSchema);

  const results: { method: MethodDraft & { recipe: Record<string, unknown> }; ok: boolean; recipe: Record<string, unknown>; validation: unknown }[] =
    [];
  for (const first of draft.methods) {
    let method = first as MethodDraft & { recipe: Record<string, unknown> };
    let validation: Awaited<ReturnType<HubContext["evalApi"]["validateRecipe"]>> | Awaited<
      ReturnType<HubContext["evalApi"]["validateCodeComprehension"]>
    > = isProgramming
      ? await ctx.evalApi.validateCodeComprehension(method.recipe)
      : await ctx.evalApi.validateRecipe(method.recipe as unknown as Record<string, unknown>);
    if (!validation.ok) {
      // A single retry, with eval's problems.
      const feedback = [
        `Your previous recipe for the method "${method.name}" did NOT pass eval's automatic check, because of this:`,
        ...validation.problems.map((p) => `- ${p}`),
        "Previous recipe:",
        JSON.stringify(isProgramming ? method.recipe : method.recipe),
        "Fix it and return \"methods\" with a SINGLE method (this one).",
      ].join("\n");
      const retry = await askJson(ctx, promptTask, "strong", llmVars, draftSchema, feedback);
      method = retry.methods[0]! as MethodDraft & { recipe: Record<string, unknown> };
      validation = isProgramming
        ? await ctx.evalApi.validateCodeComprehension(method.recipe)
        : await ctx.evalApi.validateRecipe(method.recipe as unknown as Record<string, unknown>);
    }
    results.push({
      method,
      ok: validation.ok && validation.recipe !== null,
      recipe: validation.ok && validation.recipe ? validation.recipe : method.recipe,
      validation,
    });
  }

  // Everything in one transaction at the end: a job retry never leaves half-written templates.
  const now = ctx.now();
  const taken = new Set<string>();
  const ids: string[] = [];
  db.transaction(() => {
    for (const r of results) {
      const id = ulid(now.getTime());
      ids.push(id);
      db.prepare(
        `INSERT INTO templates (id, concept_id, slug, name, method_summary, method_limits, recipe_json, level, status, validation_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'base', ?, ?, ?)`,
      ).run(
        id,
        conceptId,
        uniqueSlug(db, slugify(`${concept.name}-${r.method.name}`), taken),
        r.method.name,
        r.method.methodSummary,
        r.method.methodLimits,
        JSON.stringify(r.recipe),
        r.ok ? "active" : "failed",
        JSON.stringify(r.validation),
        isoNow(now),
      );
      if (!r.ok || isCodeRecipe(r.recipe)) continue;
      // Surviving errors (eval already removed the `droppedErrors` from the normalised recipe).
      const errors = (r.recipe.errors ?? []) as TemplateRecipe["errors"];
      for (const e of errors)
        db.prepare(
          "INSERT OR IGNORE INTO template_errors (id, template_id, key, description, expr, origin, times_seen) VALUES (?, ?, ?, ?, ?, 'recipe', 0)",
        ).run(ulid(now.getTime()), id, e.key, e.description, e.expr);
    }
  })();
  return { templateIds: ids, skipped: false };
}
