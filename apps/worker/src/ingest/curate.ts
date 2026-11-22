// Concept curator (concept-curate, cheap LLM) and weekly maintenance (concept-review, suggestions that are not applied).
import { isoNow, ulid } from "@graphharness/core";
import type { Db } from "@graphharness/db";
import { canonicalJson } from "@graphharness/hub/services/evidence";
import { refreshConceptFts } from "@graphharness/hub/services/fts";
import { enqueueJob } from "@graphharness/hub/services/jobs";
import type { HubContext } from "@graphharness/hub/services/context";
import { z } from "zod";
import { askJson, getMeta, META_LH_FILE_SOURCES, pretty } from "./common.ts";

export const CURATE_BATCH = 40;
export const SPLIT_THRESHOLD = 25;

export const CurateOutputSchema = z.object({
  assignments: z.array(
    z.object({
      propositionId: z.string(),
      conceptId: z.string().nullish(),
      newConcept: z
        .object({
          tempId: z.string().min(1),
          name: z.string().min(1),
          description: z.string(),
          subjectId: z.string().nullish(),
          computable: z.boolean(),
        })
        .nullish(),
    }),
  ),
  newEdges: z.array(z.object({ from: z.string(), to: z.string(), relation: z.enum(["requires", "illustrates"]) })).optional(),
});
export type CurateOutput = z.infer<typeof CurateOutputSchema>;

/**
 * Batch schema: besides the shape, every reference (`conceptId`, `from`/`to` of `newEdges`) must be an existing active concept
 * or a `tempId` defined in the output. An invalid reference is invalid LLM output: the client
 * retries with the error and, if it persists, the job fails without writing anything.
 */
export function curateSchemaFor(activeConceptIds: ReadonlySet<string>) {
  return CurateOutputSchema.superRefine((out, ctx) => {
    const temps = new Set(out.assignments.flatMap((a) => (a.newConcept ? [a.newConcept.tempId] : [])));
    const valid = (id: string) => activeConceptIds.has(id) || temps.has(id);
    out.assignments.forEach((a, i) => {
      if (!a.newConcept && a.conceptId && !valid(a.conceptId))
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["assignments", i, "conceptId"], message: `nonexistent concept: ${a.conceptId}` });
    });
    (out.newEdges ?? []).forEach((e, i) => {
      for (const k of ["from", "to"] as const)
        if (!valid(e[k])) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["newEdges", i, k], message: `nonexistent concept: ${e[k]}` });
    });
  });
}

interface PropRow {
  id: string;
  name: string;
  statement: string;
  provenance_json: string;
}
interface SubjectRow {
  id: string;
  name: string;
  kind: string;
  lh_source_folder: string | null;
}

/** File path inside the sources folder (`a/b` contains `a/b/x.md`). */
function inFolder(path: string, folder: string): boolean {
  const f = folder.replace(/^\/+|\/+$/g, "");
  const p = path.replace(/^\/+/, "");
  return f !== "" && (p === f || p.startsWith(`${f}/`));
}

/**
 * Subject inheritance: imported notes → `subjects.lh_source_folder` (the most specific folder);
 * chat → `lh_sessions.subject_id`. If the provenance points to a single subject, that one; otherwise null (ambiguous or unknown).
 */
function inheritedSubject(db: Db, provenance: { chatId: string }[], subjects: SubjectRow[], fileSources: Record<string, string>): string | null {
  const found = new Set<string>();
  const sessionSubject = db.prepare("SELECT subject_id FROM lh_sessions WHERE chat_id = ?").pluck();
  for (const { chatId } of provenance) {
    const path = fileSources[chatId];
    if (path !== undefined) {
      const matches = subjects.filter((s) => s.lh_source_folder && inFolder(path, s.lh_source_folder));
      matches.sort((a, b) => b.lh_source_folder!.length - a.lh_source_folder!.length);
      if (matches[0]) found.add(matches[0].id);
      continue;
    }
    const s = sessionSubject.get(chatId) as string | null | undefined;
    if (s) found.add(s);
  }
  return found.size === 1 ? [...found][0]! : null;
}

export async function runConceptCurate(ctx: HubContext): Promise<{ assigned: number; createdConceptIds: string[] }> {
  const { db } = ctx;
  const pending = db
    .prepare(
      `SELECT p.id, p.name, p.statement, p.provenance_json FROM lh_propositions p
       LEFT JOIN concept_propositions cp ON cp.proposition_id = p.id
       WHERE p.deleted = 0 AND cp.proposition_id IS NULL ORDER BY p.first_seen_at, p.id`,
    )
    .all() as PropRow[];
  let assigned = 0;
  const createdConceptIds: string[] = [];
  for (let i = 0; i < pending.length; i += CURATE_BATCH) {
    const r = await curateBatch(ctx, pending.slice(i, i + CURATE_BATCH));
    assigned += r.assigned;
    createdConceptIds.push(...r.created);
  }
  if (assigned > 0) enqueueJob(db, "edges-derive", {}, { now: ctx.now() });
  return { assigned, createdConceptIds };
}

async function curateBatch(ctx: HubContext, batch: PropRow[]): Promise<{ assigned: number; created: string[] }> {
  const { db } = ctx;
  const subjects = db.prepare("SELECT id, name, kind, lh_source_folder FROM subjects WHERE archived_at IS NULL ORDER BY name").all() as SubjectRow[];
  const fileSources = JSON.parse(getMeta(db, META_LH_FILE_SOURCES) ?? "{}") as Record<string, string>;
  const chatTitle = db.prepare("SELECT title FROM lh_sessions WHERE chat_id = ?").pluck();

  const props = batch.map((p) => {
    const provenance = JSON.parse(p.provenance_json) as { chatId: string; messageId: string }[];
    const sources = [...new Set(provenance.map((x) => fileSources[x.chatId]).filter((x): x is string => x !== undefined))];
    const chats = [
      ...new Set(provenance.filter((x) => fileSources[x.chatId] === undefined).map((x) => (chatTitle.get(x.chatId) as string | undefined) ?? x.chatId)),
    ];
    return { id: p.id, name: p.name, statement: p.statement, subjectId: inheritedSubject(db, provenance, subjects, fileSources), sources, chats };
  });

  // Candidate subjects: the inherited ones; if any proposition is ambiguous, all of them (and the concepts without a subject).
  const ambiguous = props.some((p) => p.subjectId === null);
  const candidateSubjects = ambiguous ? subjects.map((s) => s.id) : [...new Set(props.map((p) => p.subjectId!))];
  const concepts = (
    db
      .prepare(`SELECT id, name, description, subject_id AS subjectId FROM concepts WHERE status = 'active' ORDER BY name`)
      .all() as { id: string; name: string; description: string; subjectId: string | null }[]
  ).filter((c) => (c.subjectId === null ? ambiguous : candidateSubjects.includes(c.subjectId)));
  const examples = db.prepare(
    `SELECT p.statement FROM concept_propositions cp JOIN lh_propositions p ON p.id = cp.proposition_id
     WHERE cp.concept_id = ? AND p.deleted = 0 ORDER BY p.first_seen_at, p.id LIMIT 3`,
  );

  const out = await askJson(
    ctx,
    "concept-curate",
    {
      subjects: pretty(subjects.map((s) => ({ id: s.id, name: s.name, kind: s.kind }))),
      concepts: pretty(concepts.map((c) => ({ ...c, examples: examples.pluck().all(c.id) }))),
      propositions: pretty(props),
    },
    curateSchemaFor(new Set(db.prepare("SELECT id FROM concepts WHERE status = 'active'").pluck().all() as string[])),
  );
  return applyCuration(ctx, out, props);
}

/** Writes the curator output (validating references) in one transaction. Exported for edge-case tests. */
export function applyCuration(
  ctx: HubContext,
  out: CurateOutput,
  props: { id: string; subjectId: string | null }[],
): { assigned: number; created: string[] } {
  const { db } = ctx;
  const now = isoNow(ctx.now());
  const inBatch = new Map(props.map((p) => [p.id, p]));
  const subjectIds = new Set(db.prepare("SELECT id FROM subjects").pluck().all() as string[]);
  const isActiveConcept = db.prepare("SELECT 1 FROM concepts WHERE id = ? AND status = 'active'").pluck();
  const isAssigned = db.prepare("SELECT 1 FROM concept_propositions WHERE proposition_id = ?").pluck();

  // tempId → definition + propositions; assignments to existing concepts are kept apart.
  const temps = new Map<string, { def: NonNullable<CurateOutput["assignments"][number]["newConcept"]>; props: string[] }>();
  const toExisting: { propositionId: string; conceptId: string }[] = [];
  const seen = new Set<string>();
  for (const a of out.assignments) {
    if (!inBatch.has(a.propositionId) || seen.has(a.propositionId)) continue;
    if (a.newConcept) {
      seen.add(a.propositionId);
      const t = temps.get(a.newConcept.tempId) ?? { def: a.newConcept, props: [] };
      t.props.push(a.propositionId);
      temps.set(a.newConcept.tempId, t);
    } else if (a.conceptId) {
      seen.add(a.propositionId);
      toExisting.push({ propositionId: a.propositionId, conceptId: a.conceptId });
    }
  }
  // A `conceptId` that names a tempId of this batch goes to that new concept.
  for (let k = toExisting.length - 1; k >= 0; k--) {
    const a = toExisting[k]!;
    const t = temps.get(a.conceptId);
    if (t) {
      t.props.push(a.propositionId);
      toExisting.splice(k, 1);
    }
  }

  return db.transaction(() => {
    const created: string[] = [];
    const resolved = new Map<string, string>(); // tempId → id real
    const touched = new Set<string>();
    let assigned = 0;
    const assign = db.prepare("INSERT OR IGNORE INTO concept_propositions (proposition_id, concept_id, assigned_by, assigned_at) VALUES (?, ?, 'curator', ?)");

    for (const [tempId, { def, props: ids }] of temps) {
      const free = ids.filter((id) => !isAssigned.get(id));
      if (free.length === 0) continue;
      // Subject: the inherited one if all its propositions agree; otherwise the one the LLM picks among the existing ones; otherwise null.
      const inherited = new Set(free.map((id) => inBatch.get(id)!.subjectId));
      const only = inherited.size === 1 ? [...inherited][0]! : null;
      const subjectId = only ?? (def.subjectId && subjectIds.has(def.subjectId) ? def.subjectId : null);
      const id = ulid(ctx.now().getTime());
      db.prepare(
        `INSERT INTO concepts (id, subject_id, name, description, computable, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'curator', ?, ?)`,
      ).run(id, subjectId, def.name.trim(), def.description.trim(), def.computable ? 1 : 0, now, now);
      resolved.set(tempId, id);
      created.push(id);
      touched.add(id);
      for (const p of free) assigned += assign.run(p, id, now).changes;
    }
    for (const a of toExisting) {
      if (!isActiveConcept.get(a.conceptId)) continue;
      const n = assign.run(a.propositionId, a.conceptId, now).changes;
      assigned += n;
      if (n) touched.add(a.conceptId);
    }

    // Curator edges: confidence 'low' until edges-derive finds support for them (ADR 102 point 8).
    const ref = (x: string): string | null => resolved.get(x) ?? (isActiveConcept.get(x) ? x : null);
    const addEdge = db.prepare(
      `INSERT OR IGNORE INTO concept_edges (from_concept, to_concept, relation, confidence, chain_support, source) VALUES (?, ?, ?, 'low', 0, 'curator')`,
    );
    for (const e of out.newEdges ?? []) {
      const from = ref(e.from);
      const to = ref(e.to);
      if (from && to && from !== to) addEdge.run(from, to, e.relation);
    }

    for (const id of touched) refreshConceptFts(db, id);
    for (const id of created) {
      const computable = db.prepare("SELECT computable FROM concepts WHERE id = ?").pluck().get(id) as number;
      if (computable === 1) enqueueJob(db, "template-generate", { conceptId: id }, { now: ctx.now() });
    }
    return { assigned, created };
  })();
}

// ─── concept-review (weekly) ────────────────────────────────────────────────

export const ReviewOutputSchema = z.object({
  suggestions: z.array(
    z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("merge"), sourceIds: z.array(z.string()).min(1), targetId: z.string(), rationale: z.string() }),
      z.object({
        kind: z.literal("split"),
        conceptId: z.string(),
        parts: z
          .array(z.object({ name: z.string().min(1), description: z.string(), propositionIds: z.array(z.string()).min(1) }))
          .min(2),
        rationale: z.string(),
      }),
    ]),
  ),
});

/**
 * Maintenance: per subject (and the "no subject" group), the LLM proposes merges of near-duplicates and
 * splits of concepts with more than 25 propositions. They are stored in `concept_suggestions` (open); they are NOT applied.
 */
export async function runConceptReview(ctx: HubContext): Promise<{ suggestions: number }> {
  const { db } = ctx;
  const groups = db.prepare("SELECT DISTINCT subject_id FROM concepts WHERE status = 'active'").pluck().all() as (string | null)[];
  const countProps = db.prepare(
    `SELECT count(*) FROM concept_propositions cp JOIN lh_propositions p ON p.id = cp.proposition_id WHERE cp.concept_id = ? AND p.deleted = 0`,
  );
  const propsOf = db.prepare(
    `SELECT p.id, p.name FROM concept_propositions cp JOIN lh_propositions p ON p.id = cp.proposition_id
     WHERE cp.concept_id = ? AND p.deleted = 0 ORDER BY p.id`,
  );
  let suggestions = 0;
  for (const subjectId of groups) {
    const concepts = (
      db
        .prepare("SELECT id, name, description FROM concepts WHERE status = 'active' AND subject_id IS ? ORDER BY name")
        .all(subjectId) as { id: string; name: string; description: string }[]
    ).map((c) => ({ ...c, propositionCount: countProps.pluck().get(c.id) as number }));
    const big = concepts.filter((c) => c.propositionCount > SPLIT_THRESHOLD);
    if (concepts.length < 2 && big.length === 0) continue;
    const out = await askJson(
      ctx,
      "concept-review",
      {
        concepts: pretty(concepts),
        splitCandidates: pretty(big.map((c) => ({ id: c.id, name: c.name, propositions: propsOf.all(c.id) }))),
        splitThreshold: SPLIT_THRESHOLD,
      },
      ReviewOutputSchema,
    );
    const ids = new Set(concepts.map((c) => c.id));
    const bigIds = new Set(big.map((c) => c.id));
    suggestions += db.transaction(() => {
      let n = 0;
      for (const s of out.suggestions) {
        let payload: Record<string, unknown>;
        if (s.kind === "merge") {
          const sourceIds = [...new Set(s.sourceIds)].filter((x) => x !== s.targetId);
          if (!ids.has(s.targetId) || sourceIds.length === 0 || !sourceIds.every((x) => ids.has(x))) continue;
          payload = { sourceIds, targetId: s.targetId };
        } else {
          if (!bigIds.has(s.conceptId)) continue;
          const own = new Set((propsOf.all(s.conceptId) as { id: string }[]).map((p) => p.id));
          const parts = s.parts.map((p) => ({ name: p.name, description: p.description, propositionIds: p.propositionIds.filter((x) => own.has(x)) }));
          if (parts.filter((p) => p.propositionIds.length > 0).length < 2) continue;
          payload = { conceptId: s.conceptId, parts: parts.filter((p) => p.propositionIds.length > 0) };
        }
        const json = canonicalJson(payload);
        const dup = db.prepare("SELECT 1 FROM concept_suggestions WHERE kind = ? AND payload_json = ? AND status = 'open'").get(s.kind, json);
        if (dup) continue;
        db.prepare("INSERT INTO concept_suggestions (id, kind, payload_json, rationale, status, created_at) VALUES (?, ?, ?, ?, 'open', ?)").run(
          ulid(ctx.now().getTime()),
          s.kind,
          json,
          s.rationale,
          isoNow(ctx.now()),
        );
        n++;
      }
      return n;
    })();
  }
  return { suggestions };
}
