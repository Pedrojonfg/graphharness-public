// Card generation (D14; job cards-generate and the session-close pipeline step). Cheap LLM for the text; the template MCQ
// comes from eval (instance + typical errors), never from the LLM. Anything failing code validation is discarded.
import { randomUUID } from "node:crypto";
import { firstReviewDelayDays, isoNow, newSchedule, normalizeAnswer } from "@graphharness/core";
import type { CardAnswer, CardKind, McqOption, ParsonsLine } from "@graphharness/contracts";
import type { Db } from "@graphharness/db";
import { z } from "zod";
import { insertCard, type NewCard } from "./cards.ts";
import type { HubContext } from "./context.ts";
import { askJson, mcqOptionsFromPayload, publicOptions, shuffle } from "./practice-common.ts";
import { activeTemplateOf, createInstance } from "./templates.ts";

/** Generated cloze/text answer, at most 60 characters. */
export const MAX_GENERATED_ANSWER_CHARS = 60;
/** predict: the output may be longer (prompt cards-generate.v1). */
export const MAX_PREDICT_ANSWER_CHARS = 120;
/** 1 to 4 cards per concept. */
export const MAX_CARDS_PER_CONCEPT = 4;

/**
 * Draft written by the LLM. The schema fixes the shape of each type (cloze/text with an answer; mcq with 2–8 options);
 * the rules (a single correct option, distinct options, ≤ 60 characters, `$` in pairs) are applied by `validateDraft`
 * in code: a card that fails them is discarded on its own, with no retry.
 */
const draftBase = { front: z.string(), propositionIds: z.array(z.string()).default([]) };
const answerDraft = { answer: z.string().min(1), accepted: z.array(z.string()).default([]) };
const ClozeDraftSchema = z.object({ kind: z.literal("cloze"), ...draftBase, ...answerDraft });
const TextDraftSchema = z.object({ kind: z.literal("text"), ...draftBase, ...answerDraft });
const McqDraftSchema = z.object({
  kind: z.literal("mcq"),
  ...draftBase,
  options: z.array(z.object({ text: z.string(), correct: z.boolean() })).min(2).max(8),
});
const LineDraftSchema = z.object({
  id: z.string().min(1),
  text: z.string(),
  indent: z.number().int().min(0).max(8).default(0),
  distractor: z.boolean().optional(),
});
const ParsonsDraftSchema = z.object({
  kind: z.literal("parsons"),
  ...draftBase,
  lines: z.array(LineDraftSchema).min(3).max(10),
  order: z.array(z.string().min(1)).min(1),
  figureId: z.string().min(1).optional(),
});
const PredictDraftSchema = z.object({
  kind: z.literal("predict"),
  ...draftBase,
  ...answerDraft,
  figureId: z.string().min(1).optional(),
});
const SpotBugDraftSchema = z.object({
  kind: z.literal("spot_bug"),
  ...draftBase,
  lines: z.array(LineDraftSchema.omit({ distractor: true })).min(4).max(10),
  lineId: z.string().min(1),
  figureId: z.string().min(1).optional(),
});
export const CardDraftSchema = z.discriminatedUnion("kind", [
  ClozeDraftSchema,
  TextDraftSchema,
  McqDraftSchema,
  ParsonsDraftSchema,
  PredictDraftSchema,
  SpotBugDraftSchema,
]);
export type CardDraft = z.infer<typeof CardDraftSchema>;
export const CardDraftsSchema = z.object({ cards: z.array(CardDraftSchema).max(8) });
/** Confirmation: only MCQ or cloze. */
export const ConfirmationDraftsSchema = z.object({ cards: z.array(z.discriminatedUnion("kind", [ClozeDraftSchema, McqDraftSchema])).max(4) });

/** Card ready to insert (without scheduling or concept). */
export interface ValidCard {
  kind: CardKind;
  frontText: string;
  options: McqOption[] | null;
  parsonsLines?: ParsonsLine[] | null;
  figureId?: string | null;
  answer: CardAnswer;
  propositionIds: string[];
}

const balancedDollars = (s: string) => ((s.match(/(?<!\\)\$/g) ?? []).length % 2 === 0);

function draftLines(d: { lines: { id: string; text: string; indent?: number; distractor?: boolean }[] }): ParsonsLine[] | null {
  const lines = d.lines.map((l) => ({
    id: l.id.trim(),
    text: l.text.trim(),
    indent: l.indent ?? 0,
    ...(l.distractor ? { distractor: true as const } : {}),
  }));
  const ids = new Set(lines.map((l) => l.id));
  if (ids.size !== lines.length || lines.some((l) => !l.id || !l.text || l.text.length > 500 || !balancedDollars(l.text))) return null;
  return lines;
}

/**
 * Validation in code: non-empty answer; MCQ with exactly 1 correct option and distinct options after
 * `normalizeAnswer`; cloze/text with an answer ≤ 60 characters; balanced LaTeX (even number of `$`). null = discard.
 */
export function validateDraft(d: CardDraft, allowedPropositionIds: readonly string[]): ValidCard | null {
  const front = d.front.trim();
  if (!front || front.length > 2000 || !balancedDollars(front)) return null;
  const propositionIds = d.propositionIds.filter((id) => allowedPropositionIds.includes(id));
  const props = propositionIds.length ? [...new Set(propositionIds)] : [...allowedPropositionIds];
  if (d.kind === "parsons") {
    const lines = draftLines(d);
    if (!lines || lines.length < 2) return null;
    const solutionIds = new Set(lines.filter((l) => !l.distractor).map((l) => l.id));
    const order = [...new Set(d.order.map((id) => id.trim()))];
    if (order.length !== solutionIds.size || order.some((id) => !solutionIds.has(id))) return null;
    return {
      kind: "parsons",
      frontText: front,
      options: null,
      parsonsLines: lines,
      figureId: d.figureId ?? null,
      answer: { order },
      propositionIds: props,
    };
  }
  if (d.kind === "spot_bug") {
    const lines = draftLines(d);
    if (!lines || lines.length < 4) return null;
    const lineId = d.lineId.trim();
    if (!lines.some((l) => l.id === lineId)) return null;
    return {
      kind: "spot_bug",
      frontText: front,
      options: null,
      parsonsLines: lines,
      figureId: d.figureId ?? null,
      answer: { lineId },
      propositionIds: props,
    };
  }
  if (d.kind === "predict") {
    const answer = d.answer.trim();
    if (!answer || answer.length > MAX_PREDICT_ANSWER_CHARS || !balancedDollars(answer)) return null;
    const accepted = [...new Set(d.accepted.map((a) => a.trim()))].filter(
      (a) => a && a !== answer && a.length <= MAX_PREDICT_ANSWER_CHARS && balancedDollars(a),
    );
    return {
      kind: "predict",
      frontText: front,
      options: null,
      figureId: d.figureId ?? null,
      answer: { text: answer, accepted },
      propositionIds: props,
    };
  }
  if (d.kind === "mcq") {
    const opts = d.options.map((o) => ({ text: o.text.trim(), correct: o.correct }));
    if (opts.length < 2 || opts.length > 8) return null;
    if (opts.filter((o) => o.correct).length !== 1) return null;
    if (opts.some((o) => !o.text || o.text.length > 200 || !balancedDollars(o.text))) return null;
    if (new Set(opts.map((o) => normalizeAnswer(o.text))).size !== opts.length) return null;
    const options = shuffle(opts.map((o) => ({ id: randomUUID(), value: o.text, correct: o.correct })));
    return {
      kind: "mcq",
      frontText: front,
      options: options.map((o) => ({ id: o.id, value: o.value })),
      answer: { optionId: options.find((o) => o.correct)!.id },
      propositionIds: props,
    };
  }
  const answer = d.answer.trim();
  if (!answer || answer.length > MAX_GENERATED_ANSWER_CHARS || !balancedDollars(answer)) return null;
  const accepted = [...new Set(d.accepted.map((a) => a.trim()))].filter(
    (a) => a && a !== answer && a.length <= MAX_GENERATED_ANSWER_CHARS && balancedDollars(a),
  );
  return { kind: d.kind, frontText: front, options: null, answer: { text: answer, accepted }, propositionIds: props };
}

interface ConceptInfo {
  id: string;
  name: string;
  description: string;
  subject_id: string | null;
}

function conceptInfo(db: Db, conceptId: string): ConceptInfo | undefined {
  return db.prepare("SELECT id, name, description, subject_id FROM concepts WHERE id = ? AND status = 'active'").get(conceptId) as ConceptInfo | undefined;
}

/** Date (YYYY-MM-DD) of the subject's nearest exam (today or later), for the first interval (GL-057). */
export function nearestExamDate(db: Db, subjectId: string | null, now: Date): string | null {
  if (!subjectId) return null;
  return (
    (db.prepare("SELECT min(date) FROM exams WHERE subject_id = ? AND date >= ?").pluck().get(subjectId, isoNow(now).slice(0, 10)) as string | null) ?? null
  );
}

/** Neighbouring concepts in the graph (for plausible distractors). */
function neighbours(db: Db, conceptId: string): { name: string; description: string }[] {
  return db
    .prepare(
      `SELECT DISTINCT c.name, c.description FROM concept_edges e
       JOIN concepts c ON c.id = CASE WHEN e.from_concept = ? THEN e.to_concept ELSE e.from_concept END
       WHERE (e.from_concept = ? OR e.to_concept = ?) AND e.removed = 0 AND c.status = 'active' LIMIT 8`,
    )
    .all(conceptId, conceptId, conceptId) as { name: string; description: string }[];
}

/** Cheap-LLM drafting of up to `max` cards for a concept, already validated. */
export async function draftCards(
  ctx: HubContext,
  task: "cards-generate" | "confirmation-card",
  concept: ConceptInfo,
  propositions: readonly { id: string; statement: string }[],
  max: number,
): Promise<ValidCard[]> {
  if (max <= 0) return [];
  const near = neighbours(ctx.db, concept.id);
  const { cards } = await askJson<{ cards: CardDraft[] }>(
    ctx,
    task,
    "cheap",
    {
      conceptName: concept.name,
      conceptDescription: concept.description,
      propositions: propositions.length ? propositions.map((p) => `- [${p.id}] ${p.statement}`).join("\n") : "(none)",
      neighbours: near.length ? near.map((n) => `- ${n.name}: ${n.description}`).join("\n") : "(none)",
      maxCards: max,
    },
    task === "confirmation-card" ? ConfirmationDraftsSchema : CardDraftsSchema,
  );
  const ids = propositions.map((p) => p.id);
  return cards
    .map((d) => validateDraft(d, ids))
    .filter((c): c is ValidCard => c !== null)
    .slice(0, max);
}

/** MCQ from an instance of the active template (D14): options = correct + typical errors computed by eval. */
async function templateMcq(ctx: HubContext, conceptId: string): Promise<Omit<NewCard, "schedule" | "conceptId"> | null> {
  const template = activeTemplateOf(ctx.db, conceptId);
  if (!template) return null;
  const inst = await createInstance(ctx, template.id);
  if ("comprehensionVersion" in inst.payload) return null;
  const options = mcqOptionsFromPayload(inst.payload as import("./eval-client.ts").RecipeInstancePayload);
  if (!options) return null;
  return {
    kind: "mcq",
    frontText: null,
    instanceId: inst.id,
    options: publicOptions(options),
    answer: { optionId: options.find((o) => o.errorKey === null)!.id },
  };
}

/** 1–4 cards for a concept (template MCQ if any + the LLM's), inserted in one transaction. */
async function generateForConcept(
  ctx: HubContext,
  concept: ConceptInfo,
  propositions: readonly { id: string; statement: string }[],
  sourceChatId: string | null,
): Promise<string[]> {
  const fromTemplate = await templateMcq(ctx, concept.id);
  const drafted = await draftCards(ctx, "cards-generate", concept, propositions, MAX_CARDS_PER_CONCEPT - (fromTemplate ? 1 : 0));
  const now = ctx.now();
  const schedule = newSchedule(now.getTime(), firstReviewDelayDays(now, nearestExamDate(ctx.db, concept.subject_id, now)));
  const all: Omit<NewCard, "schedule" | "conceptId">[] = [
    ...(fromTemplate ? [{ ...fromTemplate, propositionIds: propositions.map((p) => p.id) }] : []),
    ...drafted,
  ];
  return ctx.db.transaction(() =>
    all.map((c) => insertCard(ctx.db, { ...c, conceptId: concept.id, purpose: "review", sourceChatId, schedule }, now)),
  )();
}

/**
 * New propositions of the session (provenance with that chatId) that do not yet have a card,
 * grouped by concept. Idempotent: a concept that already has cards from this session is not repeated.
 * Returns the ids of the cards created.
 */
export async function generateCardsForSession(ctx: HubContext, chatId: string): Promise<string[]> {
  const rows = ctx.db
    .prepare(
      `SELECT p.id, p.statement, cp.concept_id FROM lh_propositions p
       JOIN concept_propositions cp ON cp.proposition_id = p.id
       JOIN concepts c ON c.id = cp.concept_id AND c.status = 'active'
       WHERE p.deleted = 0
         AND EXISTS (SELECT 1 FROM json_each(p.provenance_json) j WHERE json_extract(j.value, '$.chatId') = ?)
         AND NOT EXISTS (SELECT 1 FROM cards k, json_each(k.proposition_ids_json) e WHERE e.value = p.id)
       ORDER BY cp.concept_id, p.id`,
    )
    .all(chatId) as { id: string; statement: string; concept_id: string }[];
  const byConcept = new Map<string, { id: string; statement: string }[]>();
  for (const r of rows) byConcept.set(r.concept_id, [...(byConcept.get(r.concept_id) ?? []), { id: r.id, statement: r.statement }]);

  const created: string[] = [];
  for (const [conceptId, props] of byConcept) {
    const already = ctx.db.prepare("SELECT 1 FROM cards WHERE concept_id = ? AND source_chat_id = ?").get(conceptId, chatId);
    const concept = conceptInfo(ctx.db, conceptId);
    if (already || !concept) continue;
    created.push(...(await generateForConcept(ctx, concept, props, chatId)));
  }
  return created;
}

/** On demand (`cards-generate {conceptId}`): the concept's live propositions that do not yet have a card. Returns ids. */
export async function generateCardsForConcept(ctx: HubContext, conceptId: string): Promise<string[]> {
  const concept = conceptInfo(ctx.db, conceptId);
  if (!concept) return [];
  const props = ctx.db
    .prepare(
      `SELECT p.id, p.statement FROM lh_propositions p JOIN concept_propositions cp ON cp.proposition_id = p.id
       WHERE cp.concept_id = ? AND p.deleted = 0
         AND NOT EXISTS (SELECT 1 FROM cards k, json_each(k.proposition_ids_json) e WHERE e.value = p.id)
       ORDER BY p.id`,
    )
    .all(conceptId) as { id: string; statement: string }[];
  // Idempotent: with no new propositions there is nothing to generate (nor the template MCQ).
  if (props.length === 0) return [];
  return generateForConcept(ctx, concept, props, null);
}
