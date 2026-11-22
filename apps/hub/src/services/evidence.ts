// Evidence writing. The `evidence_events` log is the truth; `concept_state` is
// ALWAYS recomputed by rebuilding the concept's log, so incremental ≡ rebuilt by construction
// (even with late-arriving events, e.g. an LH session ingested after a review).
import {
  effectiveState,
  evidenceWeightMultiplier,
  isoNow,
  rebuildState,
  ulid,
  type EffectiveState,
  type EvidenceEvent,
  type EvidenceEventSource,
  type ManualTargetState,
  type MissClass,
  type ResponseFormat,
  type WeightConfig,
  type WeightInput,
} from "@graphharness/core";
import type { Db } from "@graphharness/db";

export interface NewEvidence {
  conceptId: string;
  at: string;
  source: EvidenceEventSource;
  correct: boolean | null;
  responseFormat: ResponseFormat | null;
  inferred?: boolean;
  weight?: number;
  confidence?: number | null;
  /** ADR 106: origin data of the multiplier (for analysis; they do not go into `ref`). */
  missClass?: MissClass | null;
  responseMs?: number | null;
  weightMultiplier?: number | null;
  targetState?: ManualTargetState | null;
  justification?: string | null;
  /** Identity of the ingestion (UNIQUE(source, ref_json)): {chatId,toolCallId} | {instanceId,attemptId} | {cardId,reviewId} | {declarationId}. */
  ref: Record<string, unknown>;
}

/** ADR 106: final weight = base × m, and the m applied (for `weight_multiplier`). */
export function weighted(cfg: WeightConfig, base: number, input: WeightInput): { weight: number; weightMultiplier: number } {
  const weightMultiplier = evidenceWeightMultiplier(input, cfg);
  return { weight: base * weightMultiplier, weightMultiplier };
}

/** JSON with sorted keys: the same ref always serialises the same way (idempotency). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Inserts (idempotent) and recomputes the concept's state. Returns whether it was inserted. */
export function recordEvidence(db: Db, ev: NewEvidence, now: Date = new Date()): { inserted: boolean; id: string | null } {
  return db.transaction(() => {
    const id = ulid(now.getTime());
    const res = db
      .prepare(
        `INSERT OR IGNORE INTO evidence_events
         (id, concept_id, at, source, correct, response_format, inferred, weight, confidence, target_state, justification, ref_json, ingested_at,
          miss_class, response_ms, weight_multiplier)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        ev.conceptId,
        ev.at,
        ev.source,
        ev.correct === null ? null : ev.correct ? 1 : 0,
        ev.responseFormat,
        ev.inferred ? 1 : 0,
        ev.weight ?? 1,
        ev.confidence ?? null,
        ev.targetState ?? null,
        ev.justification ?? null,
        canonicalJson(ev.ref),
        isoNow(now),
        ev.missClass ?? null,
        ev.responseMs ?? null,
        ev.weightMultiplier ?? null,
      );
    if (res.changes === 0) return { inserted: false, id: null };
    recomputeConceptState(db, ev.conceptId);
    return { inserted: true, id };
  })();
}

interface EventRow {
  at: string;
  source: EvidenceEventSource;
  correct: number | null;
  response_format: ResponseFormat | null;
  weight: number;
  target_state: ManualTargetState | null;
}

export function conceptEvents(db: Db, conceptId: string): EvidenceEvent[] {
  // Stable order: `at`, and on a tie, insertion order (rowid): the ULID breaks ties randomly within the same ms.
  const rows = db
    .prepare(
      `SELECT at, source, correct, response_format, weight, target_state FROM evidence_events
       WHERE concept_id = ? ORDER BY at, rowid`,
    )
    .all(conceptId) as EventRow[];
  return rows.map((r) => ({
    at: r.at,
    source: r.source,
    correct: r.correct === null ? null : r.correct === 1,
    responseFormat: r.response_format,
    weight: r.weight,
    targetState: r.target_state,
  }));
}

/** Rebuilds a concept's `concept_state` from its log (also used by `hub rebuild-states`). */
export function recomputeConceptState(db: Db, conceptId: string): void {
  const rec = rebuildState(conceptEvents(db, conceptId));
  if (!rec) {
    db.prepare("DELETE FROM concept_state WHERE concept_id = ?").run(conceptId);
    return;
  }
  db.prepare(
    `INSERT INTO concept_state (concept_id, probability, decay_class, source, manual_confirmation, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(concept_id) DO UPDATE SET probability = excluded.probability, decay_class = excluded.decay_class,
       source = excluded.source, manual_confirmation = excluded.manual_confirmation, updated_at = excluded.updated_at`,
  ).run(conceptId, rec.probability, rec.decayClass, rec.source, rec.manualConfirmation, rec.updatedAt);
}

/** `hub rebuild-states`: recomputes every concept with evidence and deletes orphan states. */
export function rebuildAllStates(db: Db): number {
  const ids = db.prepare("SELECT DISTINCT concept_id FROM evidence_events").pluck().all() as string[];
  db.transaction(() => {
    db.prepare("DELETE FROM concept_state WHERE concept_id NOT IN (SELECT DISTINCT concept_id FROM evidence_events)").run();
    for (const id of ids) recomputeConceptState(db, id);
  })();
  return ids.length;
}

interface StateRow {
  concept_id: string;
  probability: number;
  decay_class: "reasoned" | "quick" | "strain" | "manual_pending" | "manual_confirmed";
  source: "grade" | "manual";
  manual_confirmation: "pending" | "confirmed" | null;
  updated_at: string;
}

/** Effective state (read path) of the requested concepts (or of all). Those without evidence → unknown. */
export function effectiveStates(db: Db, now: Date, conceptIds?: readonly string[]): Map<string, EffectiveState & { manualConfirmation: "pending" | "confirmed" | null; updatedAt: string | null }> {
  const rows = db.prepare("SELECT * FROM concept_state").all() as StateRow[];
  const byId = new Map(rows.map((r) => [r.concept_id, r]));
  const ids = conceptIds ?? (db.prepare("SELECT id FROM concepts WHERE status = 'active'").pluck().all() as string[]);
  const out = new Map<string, EffectiveState & { manualConfirmation: "pending" | "confirmed" | null; updatedAt: string | null }>();
  for (const id of ids) {
    const r = byId.get(id);
    const rec = r
      ? { probability: r.probability, decayClass: r.decay_class, source: r.source, manualConfirmation: r.manual_confirmation, updatedAt: r.updated_at }
      : null;
    out.set(id, { ...effectiveState(rec, now), manualConfirmation: r?.manual_confirmation ?? null, updatedAt: r?.updated_at ?? null });
  }
  return out;
}

/** Re-points evidence when merging concepts and recomputes both. */
export function moveEvidence(db: Db, fromConceptId: string, toConceptId: string): void {
  db.transaction(() => {
    db.prepare("UPDATE evidence_events SET concept_id = ? WHERE concept_id = ?").run(toConceptId, fromConceptId);
    recomputeConceptState(db, fromConceptId);
    recomputeConceptState(db, toConceptId);
  })();
}
