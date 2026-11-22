// Concepts: detail, editing, merge, split, manual edges and curator suggestions
// (`/concepts`, `/concept-edges`, `/concept-suggestions`; ADR 102 §1).
import { isoNow, ulid } from "@graphharness/core";
import type {
  AcceptSuggestionResponse,
  ConceptDetail,
  ConceptStateView,
  ConceptSuggestion,
  MergeConceptsResponse,
  PatchConceptBody,
  PatchConceptEdgesBody,
  PatchConceptEdgesResponse,
  SplitConceptResponse,
  SplitPart,
} from "@graphharness/contracts";
import type { Db } from "@graphharness/db";
import { conflict, HubError, notFound } from "../errors.ts";
import type { HubContext } from "./context.ts";
import { effectiveStates, moveEvidence } from "./evidence.ts";
import { refreshConceptFts } from "./fts.ts";
import { enqueueJob } from "./jobs.ts";
import { toEdge } from "./subjects.ts";

export type Actor = "agent" | "pwa";

/** Effective state in the contracts shape, for each requested id. */
export function stateViews(ctx: HubContext, ids: readonly string[]): Map<string, ConceptStateView> {
  const out = new Map<string, ConceptStateView>();
  if (ids.length === 0) return out;
  for (const [id, s] of effectiveStates(ctx.db, ctx.now(), ids))
    out.set(id, {
      conceptId: id,
      state: s.state,
      probability: s.probability,
      stale: s.stale,
      manualConfirmation: s.manualConfirmation,
      lastEvidenceAt: s.updatedAt,
    });
  return out;
}

export const stateView = (ctx: HubContext, id: string): ConceptStateView => stateViews(ctx, [id]).get(id)!;

interface ConceptRow {
  id: string;
  subject_id: string | null;
  name: string;
  description: string;
  computable: number;
  optional: number;
  status: "active" | "merged" | "retired";
  merged_into: string | null;
  created_by: "curator" | "agent" | "pwa";
  created_at: string;
  updated_at: string;
}

export function getConceptRow(db: Db, id: string): ConceptRow {
  const row = db.prepare("SELECT * FROM concepts WHERE id = ?").get(id) as ConceptRow | undefined;
  if (!row) throw notFound();
  return row;
}

const parseJson = <T>(raw: string | null, fallback: T): T => {
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback; // a corrupt row does not bring down the detail
  }
};

/** GET /concepts/:id and MCP `get_concept`. */
export function conceptDetail(ctx: HubContext, id: string): ConceptDetail {
  const db = ctx.db;
  const c = getConceptRow(db, id);
  const subjectName = c.subject_id ? ((db.prepare("SELECT name FROM subjects WHERE id = ?").pluck().get(c.subject_id) as string | undefined) ?? null) : null;
  const propositions = (
    db
      .prepare(
        `SELECT p.id, p.name, p.statement, p.aliases_json FROM concept_propositions cp JOIN lh_propositions p ON p.id = cp.proposition_id
         WHERE cp.concept_id = ? AND p.deleted = 0 ORDER BY p.name, p.id`,
      )
      .all(id) as { id: string; name: string; statement: string; aliases_json: string }[]
  ).map((p) => ({ id: p.id, name: p.name, statement: p.statement, aliases: parseJson<string[]>(p.aliases_json, []) }));
  const templates = (
    db.prepare("SELECT * FROM templates WHERE concept_id = ? ORDER BY created_at, id").all(id) as {
      id: string;
      slug: string;
      name: string;
      level: string;
      status: "active" | "failed" | "retired";
      method_summary: string | null;
      method_limits: string | null;
      general_template_id: string | null;
    }[]
  ).map((t) => ({
    id: t.id,
    slug: t.slug,
    name: t.name,
    level: t.level,
    status: t.status,
    methodSummary: t.method_summary,
    methodLimits: t.method_limits,
    generalTemplateId: t.general_template_id,
  }));
  const recentEvidence = (
    db.prepare("SELECT * FROM evidence_events WHERE concept_id = ? ORDER BY at DESC, ingested_at DESC, id DESC LIMIT 20").all(id) as {
      id: string;
      at: string;
      source: ConceptDetail["recentEvidence"][number]["source"];
      correct: number | null;
      response_format: "open" | "mcq" | null;
      inferred: number;
      weight: number;
      confidence: number | null;
      target_state: "solid" | "review" | "weak" | null;
      justification: string | null;
      ref_json: string;
    }[]
  ).map((e) => ({
    id: e.id,
    at: e.at,
    source: e.source,
    correct: e.correct === null ? null : e.correct === 1,
    responseFormat: e.response_format,
    inferred: e.inferred === 1,
    weight: e.weight,
    confidence: e.confidence === null ? null : Math.round(e.confidence),
    targetState: e.target_state,
    justification: e.justification,
    // The contract asks for text values: refs are ids, converted to text in case one arrived as a number.
    ref: Object.fromEntries(Object.entries(parseJson<Record<string, unknown>>(e.ref_json, {})).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])),
  }));
  const notes = (
    db.prepare("SELECT * FROM notes WHERE concept_id = ? ORDER BY created_at DESC, id DESC").all(id) as {
      id: string;
      concept_id: string | null;
      text: string;
      origin: string;
      created_at: string;
    }[]
  ).map((n) => ({ id: n.id, conceptId: n.concept_id, text: n.text, origin: n.origin === "pwa" ? ("pwa" as const) : ("agent" as const), createdAt: n.created_at }));
  const errors = (
    db
      .prepare(
        `SELECT e.* FROM template_errors e JOIN templates t ON t.id = e.template_id
         WHERE t.concept_id = ? ORDER BY e.times_seen DESC, e.key, e.id`,
      )
      .all(id) as {
      id: string;
      template_id: string;
      key: string;
      description: string;
      origin: "recipe" | "personal";
      times_seen: number;
      last_seen_at: string | null;
    }[]
  ).map((e) => ({
    id: e.id,
    templateId: e.template_id,
    key: e.key,
    description: e.description,
    origin: e.origin,
    timesSeen: e.times_seen,
    lastSeenAt: e.last_seen_at,
  }));
  return {
    id: c.id,
    subjectId: c.subject_id,
    subjectName,
    name: c.name,
    description: c.description,
    computable: c.computable === 1,
    optional: c.optional === 1,
    status: c.status,
    mergedInto: c.merged_into,
    createdBy: c.created_by,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
    state: stateView(ctx, id),
    propositions,
    templates,
    recentEvidence,
    notes,
    errors,
  };
}

function hasActiveTemplate(db: Db, conceptId: string): boolean {
  return db.prepare("SELECT 1 FROM templates WHERE concept_id = ? AND status = 'active'").get(conceptId) !== undefined;
}

const invalidField = (path: string, message: string): HubError =>
  new HubError(400, { error: "invalid_request", issues: [{ path: [path], message }] });

/** PATCH /concepts/:id. `addPropositionIds` re-assigns (assigned_by = 'pwa'); concepts that lose them stay active. */
export function patchConcept(ctx: HubContext, id: string, body: PatchConceptBody): ConceptDetail {
  const db = ctx.db;
  const now = isoNow(ctx.now());
  const touched = new Set<string>([id]);
  db.transaction(() => {
    const c = getConceptRow(db, id);
    if (body.status !== undefined && c.status === "merged") throw invalidField("status", "A merged concept cannot change state.");
    if (body.subjectId && !db.prepare("SELECT 1 FROM subjects WHERE id = ?").get(body.subjectId)) throw notFound();
    db.prepare(
      "UPDATE concepts SET name = ?, description = ?, subject_id = ?, computable = ?, optional = ?, status = ?, updated_at = ? WHERE id = ?",
    ).run(
      body.name ?? c.name,
      body.description ?? c.description,
      body.subjectId === undefined ? c.subject_id : body.subjectId,
      body.computable === undefined ? c.computable : body.computable ? 1 : 0,
      body.optional === undefined ? c.optional : body.optional ? 1 : 0,
      body.status ?? c.status,
      now,
      id,
    );
    if (body.addPropositionIds) {
      for (const pid of new Set(body.addPropositionIds)) {
        if (!db.prepare("SELECT 1 FROM lh_propositions WHERE id = ?").get(pid)) throw notFound();
        const prev = db.prepare("SELECT concept_id FROM concept_propositions WHERE proposition_id = ?").pluck().get(pid) as string | undefined;
        if (prev === id) continue;
        if (prev) touched.add(prev);
        db.prepare(
          `INSERT INTO concept_propositions (proposition_id, concept_id, assigned_by, assigned_at) VALUES (?, ?, 'pwa', ?)
           ON CONFLICT(proposition_id) DO UPDATE SET concept_id = excluded.concept_id, assigned_by = 'pwa', assigned_at = excluded.assigned_at`,
        ).run(pid, id, now);
      }
      // The LH chains that support edges depend on which proposition belongs to which concept.
      enqueueJob(db, "edges-derive", {}, { now: ctx.now() });
    }
    // Just marked computable and without a template: same as a new concept from the curator.
    if (body.computable === true && c.computable === 0 && (body.status ?? c.status) === "active" && !hasActiveTemplate(db, id))
      enqueueJob(db, "template-generate", { conceptId: id }, { now: ctx.now() });
    for (const t of touched) refreshConceptFts(db, t);
  })();
  return conceptDetail(ctx, id);
}

// ---------------------------------------------------------------- merge (re-point evidence and recompute)

/** Applies the merge of `sourceIds` INTO `targetId`. Synchronous and transactional (reused by accepting a suggestion). */
export function applyMerge(ctx: HubContext, targetId: string, sourceIds: readonly string[]): string[] {
  const db = ctx.db;
  const now = isoNow(ctx.now());
  const sources = [...new Set(sourceIds)];
  return db.transaction(() => {
    const target = getConceptRow(db, targetId);
    const rows = sources.map((s) => getConceptRow(db, s));
    if (sources.includes(targetId)) throw conflict("invalid_merge", { message: "A concept cannot be merged into itself." });
    if (target.status !== "active") throw conflict("invalid_merge", { message: "The target concept is not active." });
    const inactive = rows.find((r) => r.status !== "active");
    if (inactive) throw conflict("invalid_merge", { message: `"${inactive.name}" is not active.` });

    const exams = db.prepare("SELECT id, scope_concept_ids_json FROM exams").all() as { id: string; scope_concept_ids_json: string }[];
    for (const src of sources) {
      db.prepare("UPDATE concept_propositions SET concept_id = ? WHERE concept_id = ?").run(targetId, src);
      moveEvidence(db, src, targetId);
      // Edges: re-pointed to the target (no loops; if the target already has one, the existing one wins).
      const edges = db.prepare("SELECT * FROM concept_edges WHERE from_concept = ? OR to_concept = ?").all(src, src) as {
        from_concept: string;
        to_concept: string;
        relation: string;
        confidence: string;
        chain_support: number;
        source: string;
        removed: number;
        justification: string | null;
      }[];
      for (const e of edges) {
        const from = e.from_concept === src ? targetId : e.from_concept;
        const to = e.to_concept === src ? targetId : e.to_concept;
        if (from === to) continue;
        db.prepare(
          `INSERT OR IGNORE INTO concept_edges (from_concept, to_concept, relation, confidence, chain_support, source, removed, justification)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(from, to, e.relation, e.confidence, e.chain_support, e.source, e.removed, e.justification);
      }
      db.prepare("DELETE FROM concept_edges WHERE from_concept = ? OR to_concept = ?").run(src, src);
      // What hangs off the concept moves to the target (methods, cards, notes, declarations, plan-node mapping).
      for (const table of ["templates", "cards", "notes", "declarations", "plan_node_map"])
        db.prepare(`UPDATE ${table} SET concept_id = ? WHERE concept_id = ?`).run(targetId, src);
      db.prepare("UPDATE concepts SET merged_into = ?, updated_at = ? WHERE merged_into = ?").run(targetId, now, src);
      db.prepare("UPDATE concepts SET status = 'merged', merged_into = ?, updated_at = ? WHERE id = ?").run(targetId, now, src);
      for (const ex of exams) {
        const scope = parseJson<string[]>(ex.scope_concept_ids_json, []);
        if (!scope.includes(src)) continue;
        ex.scope_concept_ids_json = JSON.stringify([...new Set(scope.map((c) => (c === src ? targetId : c)))]);
        db.prepare("UPDATE exams SET scope_concept_ids_json = ? WHERE id = ?").run(ex.scope_concept_ids_json, ex.id);
      }
      refreshConceptFts(db, src);
    }
    db.prepare("UPDATE concepts SET updated_at = ? WHERE id = ?").run(now, targetId);
    refreshConceptFts(db, targetId);
    enqueueJob(db, "edges-derive", {}, { now: ctx.now() });
    return sources;
  })();
}

export function mergeConcepts(ctx: HubContext, targetId: string, sourceIds: readonly string[]): MergeConceptsResponse {
  const mergedIds = applyMerge(ctx, targetId, sourceIds);
  return { targetId, mergedIds, concept: conceptDetail(ctx, targetId) };
}

// ---------------------------------------------------------------- split

/**
 * Each part is a new concept (same subject and flags) with those propositions, which must all belong to the original.
 * The original stays `active` if live propositions remain; otherwise `retired`. Its evidence stays with it
 * (there is no honest way to split it among the parts).
 */
export function applySplit(ctx: HubContext, conceptId: string, parts: readonly SplitPart[], createdBy: Actor): SplitConceptResponse {
  const db = ctx.db;
  const now = isoNow(ctx.now());
  return db.transaction(() => {
    const c = getConceptRow(db, conceptId);
    if (c.status !== "active") throw conflict("invalid_split", { message: "The concept is not active." });
    const own = new Set(db.prepare("SELECT proposition_id FROM concept_propositions WHERE concept_id = ?").pluck().all(conceptId) as string[]);
    const seen = new Set<string>();
    for (const p of parts)
      for (const pid of p.propositionIds) {
        if (!own.has(pid)) throw conflict("invalid_split", { message: `Proposition ${pid} does not belong to the concept.` });
        if (seen.has(pid)) throw conflict("invalid_split", { message: `Proposition ${pid} is in more than one part.` });
        seen.add(pid);
      }
    const createdIds: string[] = [];
    for (const p of parts) {
      const id = ulid(ctx.now().getTime());
      createdIds.push(id);
      db.prepare(
        `INSERT INTO concepts (id, subject_id, name, description, computable, optional, status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      ).run(id, c.subject_id, p.name, p.description, c.computable, c.optional, createdBy, now, now);
      const move = db.prepare("UPDATE concept_propositions SET concept_id = ?, assigned_by = ?, assigned_at = ? WHERE proposition_id = ?");
      for (const pid of p.propositionIds) move.run(id, createdBy, now, pid);
      refreshConceptFts(db, id);
      if (c.computable === 1) enqueueJob(db, "template-generate", { conceptId: id }, { now: ctx.now() });
    }
    const alive = db
      .prepare(
        `SELECT count(*) FROM concept_propositions cp JOIN lh_propositions p ON p.id = cp.proposition_id
         WHERE cp.concept_id = ? AND p.deleted = 0`,
      )
      .pluck()
      .get(conceptId) as number;
    const sourceStatus: "active" | "retired" = alive > 0 ? "active" : "retired";
    db.prepare("UPDATE concepts SET status = ?, updated_at = ? WHERE id = ?").run(sourceStatus, now, conceptId);
    refreshConceptFts(db, conceptId);
    enqueueJob(db, "edges-derive", {}, { now: ctx.now() });
    return { sourceId: conceptId, createdIds, sourceStatus };
  })();
}

// ---------------------------------------------------------------- manual edges

/** Is there a path `from` ⇒ `to` through non-removed `requires` edges? */
function reaches(db: Db, from: string, to: string): boolean {
  const edges = db.prepare("SELECT from_concept AS f, to_concept AS t FROM concept_edges WHERE removed = 0 AND relation = 'requires'").all() as {
    f: string;
    t: string;
  }[];
  const seen = new Set([from]);
  const queue = [from];
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    if (id === to) return true;
    for (const e of edges)
      if (e.f === id && !seen.has(e.t)) {
        seen.add(e.t);
        queue.push(e.t);
      }
  }
  return false;
}

/**
 * PATCH /concept-edges. First the removed ones (`removed = 1`; if it did not exist, it is created already removed so edges-derive
 * does not derive it), then the added ones (`source = 'manual'`, confidence `high`). 409 `cycle` if a `requires` would close a cycle.
 */
export function patchEdges(ctx: HubContext, body: PatchConceptEdgesBody): PatchConceptEdgesResponse {
  const db = ctx.db;
  return db.transaction(() => {
    for (const e of [...body.add, ...body.remove]) {
      getConceptRow(db, e.from);
      getConceptRow(db, e.to);
    }
    for (const e of body.remove)
      db.prepare(
        `INSERT INTO concept_edges (from_concept, to_concept, relation, confidence, chain_support, source, removed, justification)
         VALUES (?, ?, 'requires', 'low', 0, 'manual', 1, ?)
         ON CONFLICT(from_concept, to_concept) DO UPDATE SET removed = 1, justification = excluded.justification`,
      ).run(e.from, e.to, e.justification);
    for (const e of body.add) {
      if (e.relation === "requires" && reaches(db, e.to, e.from))
        throw conflict("cycle", { message: `Adding ${e.from} → ${e.to} would close a prerequisite cycle.`, from: e.from, to: e.to });
      db.prepare(
        `INSERT INTO concept_edges (from_concept, to_concept, relation, confidence, chain_support, source, removed, justification)
         VALUES (?, ?, ?, 'high', 0, 'manual', 0, ?)
         ON CONFLICT(from_concept, to_concept) DO UPDATE SET relation = excluded.relation, confidence = 'high', source = 'manual',
           removed = 0, justification = excluded.justification`,
      ).run(e.from, e.to, e.relation, e.justification);
    }
    const added = body.add.map((e) =>
      toEdge(db.prepare("SELECT * FROM concept_edges WHERE from_concept = ? AND to_concept = ?").get(e.from, e.to) as Parameters<typeof toEdge>[0]),
    );
    return { added, removed: body.remove.map((e) => ({ from: e.from, to: e.to })) };
  })();
}

// ---------------------------------------------------------------- curator suggestions (ADR 102 §1)

interface SuggestionRow {
  id: string;
  kind: "merge" | "split";
  payload_json: string;
  rationale: string | null;
  status: "open" | "accepted" | "dismissed";
  created_at: string;
  resolved_at: string | null;
}

function toSuggestion(db: Db, r: SuggestionRow): ConceptSuggestion {
  const payload = parseJson<Record<string, unknown>>(r.payload_json, {});
  const base = { id: r.id, rationale: r.rationale, status: r.status, createdAt: r.created_at, resolvedAt: r.resolved_at };
  const names = (ids: string[]): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const id of ids) {
      const name = db.prepare("SELECT name FROM concepts WHERE id = ?").pluck().get(id) as string | undefined;
      if (name !== undefined) out[id] = name;
    }
    return out;
  };
  if (r.kind === "merge") {
    const sourceIds = (payload.sourceIds as string[] | undefined) ?? [];
    const targetId = String(payload.targetId ?? "");
    return { ...base, kind: "merge", sourceIds, targetId, conceptNames: names([targetId, ...sourceIds]) };
  }
  const conceptId = String(payload.conceptId ?? "");
  return { ...base, kind: "split", conceptId, parts: (payload.parts as SplitPart[] | undefined) ?? [], conceptNames: names([conceptId]) };
}

export function listSuggestions(ctx: HubContext, status: "open" | "accepted" | "dismissed" = "open"): ConceptSuggestion[] {
  return (ctx.db.prepare("SELECT * FROM concept_suggestions WHERE status = ? ORDER BY created_at, id").all(status) as SuggestionRow[]).map((r) =>
    toSuggestion(ctx.db, r),
  );
}

function openSuggestion(db: Db, id: string): SuggestionRow {
  const row = db.prepare("SELECT * FROM concept_suggestions WHERE id = ?").get(id) as SuggestionRow | undefined;
  if (!row) throw notFound();
  if (row.status !== "open") throw conflict("not_open", { message: "The suggestion was already resolved." });
  return row;
}

/** Accept = apply the merge or the split and mark it `accepted`, all or nothing. */
export function acceptSuggestion(ctx: HubContext, id: string, actor: Actor): AcceptSuggestionResponse {
  const db = ctx.db;
  return db.transaction(() => {
    const row = openSuggestion(db, id);
    const s = toSuggestion(db, row);
    const conceptIds =
      s.kind === "merge"
        ? (applyMerge(ctx, s.targetId, s.sourceIds), [s.targetId])
        : applySplit(ctx, s.conceptId, s.parts, actor).createdIds;
    db.prepare("UPDATE concept_suggestions SET status = 'accepted', resolved_at = ? WHERE id = ?").run(isoNow(ctx.now()), id);
    return { suggestionId: id, kind: s.kind, conceptIds };
  })();
}

export function dismissSuggestion(ctx: HubContext, id: string): ConceptSuggestion {
  const db = ctx.db;
  db.transaction(() => {
    openSuggestion(db, id);
    db.prepare("UPDATE concept_suggestions SET status = 'dismissed', resolved_at = ? WHERE id = ?").run(isoNow(ctx.now()), id);
  })();
  return toSuggestion(db, db.prepare("SELECT * FROM concept_suggestions WHERE id = ?").get(id) as SuggestionRow);
}
