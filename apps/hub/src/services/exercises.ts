// Ported from graphlearn/packages/llm/src/explain.ts (65b56d6).
// Deterministic exercises of the PWA (GL-010, D25). eval decides whether an answer is correct; the LLM only explains.
// splitEquation, verifyFormula and stripMath come from GL; the rest is new.
import { isoNow, ulid, visibleDistractorCount } from "@graphharness/core";
import type {
  AnswerValue,
  CodeComprehensionGiven,
  CreateExerciseBody,
  Exercise,
  ExerciseAttemptBody,
  ExerciseAttemptResponse,
  ExerciseExplainBody,
  ExerciseExplanation,
  ExerciseHintResponse,
} from "@graphharness/contracts";
import { z } from "zod";
import { conflict, notFound } from "../errors.ts";
import { getConceptRow } from "./concepts.ts";
import type { HubContext } from "./context.ts";
import { errorHint, recordUnknownError, touchMatchedError } from "./errors.ts";
import { recordEvidence, weighted } from "./evidence.ts";
import { enqueueJob } from "./jobs.ts";
import { askJson, conceptStateView, withEval, withLlm } from "./practice-common.ts";
import type { CodeComprehensionInstancePayload, RecipeInstancePayload } from "./eval-client.ts";
import { activeTemplateOf, addPreAttemptHint, createInstance, getInstance, getTemplate, methodSteps, type InstanceRow, type TemplateRow } from "./templates.ts";

function isCodePayload(payload: InstanceRow["payload"]): payload is CodeComprehensionInstancePayload {
  return "comprehensionVersion" in payload && payload.comprehensionVersion === 1;
}

function codeCanonicalGiven(p: CodeComprehensionInstancePayload): CodeComprehensionGiven {
  if (p.kind === "parsons" || p.kind === "faded_parsons") {
    const given: CodeComprehensionGiven = { order: [...p.order] };
    if (p.blanks?.length) given.blanks = Object.fromEntries(p.blanks.map((b) => [b.lineKey, b.answer]));
    return given;
  }
  if (p.kind === "predict") return { output: p.expectedOutput! };
  return { lineKey: p.buggyKey! };
}

/** Attempts per exercise (GL-010): the second one comes after the hint; then, the solution. */
export const MAX_EXERCISE_ATTEMPTS = 2;

export const GENERIC_HINT =
  "Hint: your result does not match the solution. Go over the procedure step by step, check your calculations and try again.";

interface AttemptRow {
  id: string;
  instance_id: string;
  user_input_json: string;
  correct: number;
  matched_error_id: string | null;
  unknown_pattern: number;
  hints_used: number;
  learner_explanation: string | null;
  created_at: string;
}

/** Instance of an exercise: exists and belongs to neither a card nor a diagnostic (its solution is not revealed here). */
function exerciseInstance(ctx: HubContext, instanceId: string): { instance: InstanceRow; template: TemplateRow; conceptId: string } {
  const instance = getInstance(ctx.db, instanceId);
  if (!instance) throw notFound();
  const foreign =
    ctx.db.prepare("SELECT 1 FROM cards WHERE instance_id = ?").get(instanceId) !== undefined ||
    ctx.db.prepare("SELECT 1 FROM attempts WHERE instance_id = ? AND context <> 'exercise'").get(instanceId) !== undefined;
  if (foreign) throw notFound();
  const template = getTemplate(ctx.db, instance.template_id)!;
  return { instance, template, conceptId: template.concept_id };
}

function exerciseAttempts(ctx: HubContext, instanceId: string): AttemptRow[] {
  return ctx.db
    .prepare("SELECT * FROM attempts WHERE instance_id = ? AND context = 'exercise' ORDER BY created_at, rowid")
    .all(instanceId) as AttemptRow[];
}

const isFinished = (attempts: readonly AttemptRow[]) => attempts.some((a) => a.correct === 1) || attempts.length >= MAX_EXERCISE_ATTEMPTS;

/** The concept's active template: 404 if the concept does not exist, 409 template_not_active if it has none. */
function activeTemplateId(ctx: HubContext, conceptId: string): string {
  const active = activeTemplateOf(ctx.db, getConceptRow(ctx.db, conceptId).id);
  if (!active) throw conflict("template_not_active");
  return active.id;
}

/** POST /exercises {templateId | conceptId} → new instance (without solution). With conceptId, the concept's active template. */
export async function createExercise(ctx: HubContext, body: CreateExerciseBody): Promise<Exercise> {
  const templateId = body.templateId ?? activeTemplateId(ctx, body.conceptId!);
  const created = await withEval(() => createInstance(ctx, templateId));
  return {
    instanceId: created.id,
    templateId: created.template.id,
    templateName: created.template.name,
    conceptId: created.template.concept_id,
    instance: created.client,
    methodSummary: created.template.method_summary,
  };
}

/** POST /exercises/:instanceId/attempt (GL-010). The `hub_exercise` evidence is that of the first attempt. */
export async function attemptExercise(ctx: HubContext, instanceId: string, body: ExerciseAttemptBody): Promise<ExerciseAttemptResponse> {
  const { instance, template, conceptId } = exerciseInstance(ctx, instanceId);
  const previous = exerciseAttempts(ctx, instanceId);
  if (isFinished(previous)) throw conflict("exercise_finished");
  const code = isCodePayload(instance.payload);
  const graded = await withEval(() =>
    code
      ? ctx.evalApi.gradeCode(instance.payload as CodeComprehensionInstancePayload, body.userInput)
      : ctx.evalApi.grade(instance.payload as RecipeInstancePayload, body.userInput.result!),
  );

  const now = ctx.now();
  const at = isoNow(now);
  const attemptId = ulid(now.getTime());
  const attemptNumber = previous.length + 1;
  const detectorKey = graded.correct ? null : (graded.detectorKey ?? null);
  // No detectorKey = unknown pattern. `unreadable_answer` or `choice_i` are not template errors: unknown_error without a hypothesis.
  const unknownPattern = !graded.correct && !detectorKey;

  const matchedErrorId = ctx.db.transaction(() => {
    const matched = graded.correct ? null : touchMatchedError(ctx.db, template.id, detectorKey, at);
    ctx.db
      .prepare(
        `INSERT INTO attempts (id, instance_id, context, user_input_json, correct, matched_error_id, unknown_pattern, hints_used, response_ms, created_at)
         VALUES (?, ?, 'exercise', ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(attemptId, instanceId, JSON.stringify(body.userInput), graded.correct ? 1 : 0, matched, unknownPattern ? 1 : 0, body.responseMs ?? null, at);
    return matched;
  })();
  if (unknownPattern) recordUnknownError(ctx, { attemptId, templateId: template.id });

  if (attemptNumber === 1) {
    // ADR 103 point 4: a correct answer with ≥ 1 hint requested before this first attempt → mcq (quick).
    recordEvidence(
      ctx.db,
      {
        conceptId,
        at,
        source: "hub_exercise",
        correct: graded.correct,
        responseFormat: graded.correct && instance.hintsBeforeAttempt > 0 ? "mcq" : "open",
        ...weighted(ctx.config.weights, 1, { source: "hub_exercise", correct: graded.correct, responseMs: body.responseMs }),
        responseMs: body.responseMs ?? null,
        ref: { instanceId },
      },
      now,
    );
  }

  const finished = graded.correct || attemptNumber >= MAX_EXERCISE_ATTEMPTS;
  const outcome = graded.correct ? "correct" : matchedErrorId ? "known_error" : "unknown_error";
  const solution = finished
    ? code
      ? codeCanonicalGiven(instance.payload as CodeComprehensionInstancePayload)
      : ((instance.payload as RecipeInstancePayload).answer as AnswerValue)
    : null;
  let visibleDistractors: number | undefined;
  if (!graded.correct && code && (instance.payload as CodeComprehensionInstancePayload).distractorsAdaptive) {
    const total = (instance.payload as CodeComprehensionInstancePayload).distractorCount ?? 0;
    visibleDistractors = visibleDistractorCount(total, attemptNumber);
  }
  return {
    attemptId,
    attemptNumber,
    correct: graded.correct,
    outcome,
    canRetry: !finished,
    finished,
    solution,
    ...(visibleDistractors !== undefined ? { visibleDistractorCount: visibleDistractors } : {}),
    conceptState: conceptStateView(ctx, conceptId),
  };
}

/**
 * POST /exercises/:instanceId/hint. After a known error: its cached hint (cheap LLM). Otherwise (also before the
 * first attempt, ADR 103 point 4): the next step of the method sheet. 409 exercise_finished if it already finished.
 */
export async function exerciseHint(ctx: HubContext, instanceId: string): Promise<ExerciseHintResponse> {
  const { instance, template } = exerciseInstance(ctx, instanceId);
  const attempts = exerciseAttempts(ctx, instanceId);
  if (isFinished(attempts)) throw conflict("exercise_finished");
  const last = attempts[attempts.length - 1];
  const used = instance.hintsBeforeAttempt + attempts.reduce((n, a) => n + a.hints_used, 0);

  let hint: string;
  let kind: ExerciseHintResponse["kind"];
  if (last?.matched_error_id) {
    hint = await withLlm(() => errorHint(ctx, last.matched_error_id!));
    kind = "known_error";
  } else {
    const steps = methodSteps(template.method_summary);
    hint = steps.length ? `Hint (method step ${Math.min(used, steps.length - 1) + 1}): ${steps[Math.min(used, steps.length - 1)]}` : GENERIC_HINT;
    kind = "method";
  }
  // Before the first attempt the hint is recorded on the instance (ADR 103 point 4); afterwards, on the last attempt.
  if (last) ctx.db.prepare("UPDATE attempts SET hints_used = hints_used + 1 WHERE id = ?").run(last.id);
  else addPreAttemptHint(ctx.db, instanceId);
  return { instanceId, hint, kind, hintsUsed: used + 1 };
}

// ---------------------------------------------------------------- explanation (GL-011/044)

/** Splits an equality "a = b = c" into its members (outside braces). */
export function splitEquation(latex: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < latex.length; i++) {
    const ch = latex[i]!;
    if (ch === "{") depth++;
    if (ch === "}") depth--;
    if (ch === "=" && depth === 0 && latex[i + 1] !== "=") {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur.trim());
  return out.filter((p) => p.length > 0);
}

/** A member that is just a name (c_{11}, \det A, x') is not checked: the rest is verified. */
const isName = (s: string) => /^(\\[a-zA-Z]+\s*)?[a-zA-Z](_\{?[\w,]+\}?)?('|\^\{?\\prime\}?)?(\s*\\?[a-zA-Z]+)?$/.test(s.trim());

/** true/false if eval could check `left = right`; null if it cannot be read. */
type VerifyLatex = (left: string, right: string) => Promise<boolean | null>;

/** All checkable equalities of the formula are true (and there is at least one). null = nothing checkable. */
export async function verifyFormula(latex: string, verify: VerifyLatex): Promise<boolean | null> {
  const members = splitEquation(latex);
  const checkable = members.slice(members.length > 0 && isName(members[0]!) ? 1 : 0);
  if (checkable.length < 2) return null;
  for (let i = 0; i + 1 < checkable.length; i++) {
    const ok = await verify(checkable[i]!, checkable[i + 1]!);
    if (ok !== true) return ok;
  }
  return true;
}

/** The text is shown plain: if the AI slipped in $…$, the dollar signs are removed. */
const stripMath = (text: string) => text.replace(/\$+/g, "");

const ExplanationDraftSchema = z.object({
  summary: z.string().min(1).max(600),
  steps: z
    .array(z.object({ text: z.string().min(1).max(900), formulas: z.array(z.string().min(1).max(400)).max(4).default([]) }))
    .min(1)
    .max(10),
});

/**
 * POST /exercises/:instanceId/explain. Saves the student's steps and explanation on their last attempt (they feed
 * error-hypothesize), locates the first step that does not add up (only steps that are equalities eval can check) and
 * asks the strong LLM for the explanation; formulas eval does not verify are omitted (with a notice: `omittedFormulas`).
 */
export async function explainExercise(ctx: HubContext, instanceId: string, body: ExerciseExplainBody): Promise<ExerciseExplanation> {
  const { instance, template } = exerciseInstance(ctx, instanceId);
  if (isCodePayload(instance.payload)) throw conflict("code_explain_unsupported");
  const recipePayload = instance.payload as RecipeInstancePayload;
  const attempts = exerciseAttempts(ctx, instanceId);
  if (attempts.length === 0) throw conflict("no_attempt");
  const last = attempts[attempts.length - 1]!;
  const input = JSON.parse(last.user_input_json) as { result: unknown; steps?: string[] };
  const steps = body.steps ?? input.steps ?? [];
  const learnerExplanation = body.learnerExplanation?.trim() || last.learner_explanation;
  if (body.steps !== undefined || body.learnerExplanation !== undefined) {
    ctx.db
      .prepare("UPDATE attempts SET user_input_json = ?, learner_explanation = ? WHERE id = ?")
      .run(JSON.stringify({ ...input, steps }), learnerExplanation ?? null, last.id);
    // The still-open unknown errors of this exercise are hypothesised with the new steps (idempotent).
    const open = ctx.db
      .prepare(
        `SELECT u.id FROM unknown_errors u JOIN attempts a ON a.id = u.attempt_id WHERE a.instance_id = ? AND u.status = 'open'`,
      )
      .pluck()
      .all(instanceId) as string[];
    for (const id of open) enqueueJob(ctx.db, "error-hypothesize", { unknownErrorId: id }, { now: ctx.now() });
  }

  const verify: VerifyLatex = async (l, r) => {
    try {
      return await ctx.evalApi.verifyLatex(l, r);
    } catch (err) {
      console.warn("[exercises] eval could not check a formula:", err instanceof Error ? err.message : err);
      return null;
    }
  };

  // First student step that does not match (steps that are not checkable equalities are skipped).
  let firstMismatchStep: number | null = null;
  for (let i = 0; i < steps.length && firstMismatchStep === null; i++) {
    if ((await verifyFormula(steps[i]!, verify)) === false) firstMismatchStep = i;
  }

  const matched = [...attempts].reverse().find((a) => a.matched_error_id)?.matched_error_id ?? null;
  const errorDescription = matched
    ? ((ctx.db.prepare("SELECT description FROM template_errors WHERE id = ?").pluck().get(matched) as string | undefined) ?? null)
    : null;
  const notation = ctx.db
    .prepare("SELECT s.course_notation FROM concepts c LEFT JOIN subjects s ON s.id = c.subject_id WHERE c.id = ?")
    .pluck()
    .get(template.concept_id) as string | null | undefined;
  const finished = isFinished(attempts);

  const draft = await withLlm(() =>
    askJson(
      ctx,
      "exercise-explain",
      "strong",
      {
        statement: recipePayload.statement,
        correctAnswer: JSON.stringify(recipePayload.answer),
        userAnswer: JSON.stringify(input.result),
        knownError: errorDescription ?? "does not match any known typical error",
        learnerExplanation: learnerExplanation?.trim() || "(not given)",
        steps: steps.length ? steps.map((s, i) => `${i + 1}. ${s}`).join("\n") : "(not given)",
        methodSummary: template.method_summary ?? "(no summary)",
        methodLimits: template.method_limits ?? "(no limits noted)",
        courseNotation: notation?.trim() || "(no notation notes)",
        revealAnswer: finished
          ? "The exercise has already finished: you may give the final result."
          : "The exercise has NOT finished (the student can still retry): do NOT give the final result nor formulas that contain it.",
      },
      ExplanationDraftSchema,
    ),
  );

  // Only formulas that eval verifies are shown; the others are omitted (counted once), also inside the text.
  const norm = (f: string) => f.replace(/\s+/g, "");
  const verdict = new Map<string, boolean | null>();
  const check = async (f: string): Promise<boolean | null> => {
    if (!verdict.has(norm(f))) verdict.set(norm(f), await verifyFormula(f, verify));
    return verdict.get(norm(f))!;
  };
  /** Text with `$…$` only for verified formulas; a false equality is removed; what cannot be checked stays as plain text. */
  const cleanText = async (text: string): Promise<string> => {
    let out = "";
    let last = 0;
    for (const m of text.matchAll(/\$+([^$]+)\$+/g)) {
      out += stripMath(text.slice(last, m.index));
      const v = await check(m[1]!);
      out += ` ${v === true ? `$${m[1]!.trim()}$` : v === false ? "" : m[1]!.trim()} `;
      last = m.index + m[0].length;
    }
    return (out + stripMath(text.slice(last))).replace(/\s{2,}/g, " ").replace(/\s+([.,;:])/g, "$1").trim();
  };
  const outSteps: ExerciseExplanation["steps"] = [];
  for (const p of draft.steps) {
    const formulas: { latex: string; verified: true }[] = [];
    for (const f of p.formulas) {
      if ((await check(f)) === true) formulas.push({ latex: f, verified: true });
      else verdict.set(norm(f), false);
    }
    outSteps.push({ text: await cleanText(p.text), formulas });
  }
  const omitted = [...verdict.values()].filter((v) => v === false).length;
  return { instanceId, summary: await cleanText(draft.summary), steps: outSteps, omittedFormulas: omitted, firstMismatchStep };
}
