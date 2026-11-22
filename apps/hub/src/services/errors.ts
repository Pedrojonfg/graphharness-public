// Typical and personal errors of a template (D10): matches, cached hint and promotion by reproduction.
import { isoNow, ulid } from "@graphharness/core";
import type { Db } from "@graphharness/db";
import { z } from "zod";
import type { HubContext } from "./context.ts";
import { enqueueJob } from "./jobs.ts";
import { askJson } from "./practice-common.ts";
import type { RecipeInstancePayload } from "./eval-client.ts";
import { getInstance, getTemplate, methodSteps, recipeForInstance } from "./templates.ts";

/** Key eval returns when it cannot understand the answer: it is not an error pattern. */
export const UNREADABLE_ANSWER = "unreadable_answer";

/**
 * eval recognised `detectorKey`: if it is a template error, bumps `times_seen` and `last_seen_at` (promotion
 * step 4) and returns its id. Keys that are not template errors (`choice_i`, `unreadable_answer`) → null.
 */
export function touchMatchedError(db: Db, templateId: string, detectorKey: string | null | undefined, atIso: string): string | null {
  if (!detectorKey) return null;
  const row = db.prepare("SELECT id FROM template_errors WHERE template_id = ? AND key = ?").get(templateId, detectorKey) as { id: string } | undefined;
  if (!row) return null;
  db.prepare("UPDATE template_errors SET times_seen = times_seen + 1, last_seen_at = ? WHERE id = ?").run(atIso, row.id);
  return row.id;
}

/** Unknown error (no `detectorKey`): open `unknown_errors` row + `error-hypothesize` job. */
export function recordUnknownError(ctx: HubContext, input: { attemptId: string; templateId: string }): string {
  const now = ctx.now();
  const id = ulid(now.getTime());
  ctx.db
    .prepare("INSERT INTO unknown_errors (id, attempt_id, template_id, status, created_at) VALUES (?, ?, ?, 'open', ?)")
    .run(id, input.attemptId, input.templateId, isoNow(now));
  enqueueJob(ctx.db, "error-hypothesize", { unknownErrorId: id }, { now });
  return id;
}

// ---------------------------------------------------------------- hint (ADR 102 point 5)

const HintSchema = z.object({ hint: z.string().trim().min(1).max(600) });

/** Hint for a known error: `description` rephrased by the cheap LLM, cached in `template_errors.hint`. */
export async function errorHint(ctx: HubContext, errorId: string): Promise<string> {
  const row = ctx.db
    .prepare(
      `SELECT e.description, e.hint, t.name AS template_name, t.method_summary FROM template_errors e
       JOIN templates t ON t.id = e.template_id WHERE e.id = ?`,
    )
    .get(errorId) as { description: string; hint: string | null; template_name: string; method_summary: string | null } | undefined;
  if (!row) throw new Error(`template_errors ${errorId} does not exist`);
  if (row.hint) return row.hint;
  const { hint } = await askJson(
    ctx,
    "error-hint",
    "cheap",
    { templateName: row.template_name, errorDescription: row.description, methodSummary: row.method_summary ?? "(no summary)" },
    HintSchema,
  );
  ctx.db.prepare("UPDATE template_errors SET hint = ? WHERE id = ?").run(hint, errorId);
  return hint;
}

// ---------------------------------------------------------------- error-hypothesize (promotion)

const HypothesisSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,55}$/),
  description: z.string().trim().min(5).max(300),
  expr: z.string().trim().min(1).max(300),
});

function freeKey(db: Db, templateId: string, key: string): string {
  const taken = (k: string) => db.prepare("SELECT 1 FROM template_errors WHERE template_id = ? AND key = ?").get(templateId, k) !== undefined;
  let out = key;
  for (let n = 2; taken(out); n++) out = `${key}_${n}`;
  return out;
}

/**
 * Job `error-hypothesize {unknownErrorId}`: the strong LLM proposes {key, description, expr} → eval /v1/errors/reproduce →
 * `template_errors` origin 'personal' (promoted) or `unknown_errors.status = 'rejected'`. Idempotent: only handles the `open` ones.
 */
export async function runErrorHypothesize(ctx: HubContext, unknownErrorId: string): Promise<"promoted" | "rejected" | "skipped"> {
  const { db } = ctx;
  const ue = db.prepare("SELECT * FROM unknown_errors WHERE id = ?").get(unknownErrorId) as
    | { id: string; attempt_id: string; template_id: string; status: string }
    | undefined;
  if (!ue || ue.status !== "open") return "skipped";
  const attempt = db.prepare("SELECT * FROM attempts WHERE id = ?").get(ue.attempt_id) as
    | { id: string; instance_id: string; user_input_json: string; learner_explanation: string | null; created_at: string }
    | undefined;
  const template = getTemplate(db, ue.template_id);
  const instance = attempt ? getInstance(db, attempt.instance_id) : undefined;
  if (!attempt || !template || !instance) {
    db.prepare("UPDATE unknown_errors SET status = 'rejected' WHERE id = ?").run(ue.id);
    return "rejected";
  }
  if ("comprehensionVersion" in instance.payload) {
    db.prepare("UPDATE unknown_errors SET status = 'rejected' WHERE id = ?").run(ue.id);
    return "skipped";
  }
  const userInput = JSON.parse(attempt.user_input_json) as { result: unknown; steps?: string[] };
  const recipe = recipeForInstance(db, template);
  const existing = db.prepare("SELECT key, description FROM template_errors WHERE template_id = ?").all(template.id) as {
    key: string;
    description: string;
  }[];

  const candidate = await askJson(
    ctx,
    "error-hypothesize",
    "strong",
    {
      templateName: template.name,
      methodSummary: methodSteps(template.method_summary).map((s, i) => `${i + 1}. ${s}`).join("\n") || "(no summary)",
      recipe: JSON.stringify(recipe),
      statement: instance.payload.statement,
      params: JSON.stringify((instance.payload as RecipeInstancePayload).params),
      correctAnswer: JSON.stringify((instance.payload as RecipeInstancePayload).answer),
      userAnswer: JSON.stringify(userInput.result),
      steps: userInput.steps?.length ? userInput.steps.map((s, i) => `${i + 1}. ${s}`).join("\n") : "(not given)",
      learnerExplanation: attempt.learner_explanation?.trim() || "(not given)",
      knownErrors: existing.length ? existing.map((e) => `- ${e.key}: ${e.description}`).join("\n") : "(none)",
    },
    HypothesisSchema,
  );
  const key = freeKey(db, template.id, candidate.key);
  const hypothesis = { key, description: candidate.description, expr: candidate.expr };
  db.prepare("UPDATE unknown_errors SET hypothesis_json = ? WHERE id = ?").run(JSON.stringify(hypothesis), ue.id);

  const check = await ctx.evalApi.reproduceError({
    recipe,
    instancePayload: instance.payload as RecipeInstancePayload,
    userInput: { result: userInput.result },
    candidate: hypothesis,
  });
  if (!check.ok) {
    db.prepare("UPDATE unknown_errors SET status = 'rejected', hypothesis_json = ? WHERE id = ?").run(
      JSON.stringify({ ...hypothesis, problems: check.problems }),
      ue.id,
    );
    return "rejected";
  }
  db.transaction(() => {
    const errorId = ulid(ctx.now().getTime());
    // times_seen counts eval's detections since it exists (the attempt that originated it matched nothing).
    db.prepare(
      "INSERT INTO template_errors (id, template_id, key, description, expr, origin, times_seen) VALUES (?, ?, ?, ?, ?, 'personal', 0)",
    ).run(errorId, template.id, key, hypothesis.description, hypothesis.expr);
    db.prepare("UPDATE unknown_errors SET status = 'promoted' WHERE id = ?").run(ue.id);
  })();
  return "promoted";
}
