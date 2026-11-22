// Evidence application. A single pure function applies evidence; the same one is used when rebuilding state.
import {
  ageDaysSince,
  classifyGradeEvent,
  decayedProbability,
  evidenceHalfLifeDaysFromEnv,
  isEvidenceStaleForDiagnostic,
  type EvidenceDecayClass,
  type EvidenceHalfLifeDays,
  type ResponseFormat,
} from "./decay.ts";
import { manualTargetProbability, type ManualTargetState } from "./manual.ts";
import { applyGradeToProbability, deriveState, type ConceptState, type EvidenceSource, type ManualConfirmation } from "./state.ts";

export type EvidenceEventSource =
  | "lh_quiz"
  | "lh_probe"
  | "lh_recall"
  | "lh_practice"
  | "hub_exercise"
  | "hub_diagnostic"
  | "flashcard"
  | "declaration"
  | "confirmation";

/** What `applyEvidence` needs from a row of `evidence_events`. */
export interface EvidenceEvent {
  /** ISO 8601 UTC — when it happened. */
  at: string;
  source: EvidenceEventSource;
  /** null only for declarations. */
  correct: boolean | null;
  /** null for declarations. */
  responseFormat: ResponseFormat | null;
  /** 1 by default; 0.5 for flashcards (D26); bump/0.15 in diagnostic inference. */
  weight: number;
  /** Declarations only. */
  targetState?: ManualTargetState | null;
}

/** Mirror of a row of `concept_state`. */
export interface ConceptStateRecord {
  /** P without decay, after the last event. */
  probability: number;
  decayClass: EvidenceDecayClass;
  source: EvidenceSource;
  manualConfirmation: ManualConfirmation | null;
  /** `at` of the last applied event. */
  updatedAt: string;
}

export interface EvidenceOptions {
  halfLifeDays?: EvidenceHalfLifeDays;
}

/**
 * Steps 1–4 (with ADR 101: decay is applied BEFORE adding the delta).
 * - declaration: P := manualTargetProbability(target); decay 'manual_pending'; source 'manual'; confirmation 'pending'.
 * - confirmation: base := P decayed from prev to ev.at; P := base ± Δ·weight;
 *     correct → 'confirmed' + 'manual_confirmed'; failure → stays 'pending' + 'strain'. `source` does not change (prev.source, or 'grade' if there is no prev).
 * - rest (grades): base := prev ? P decayed from prev.updatedAt to ev.at : PRIOR; P := clamp(base ± Δ·weight);
 *     decay := classifyGradeEvent({correct, responseFormat}); source 'grade';
 *     confirmation := prev 'pending' && correct ? 'confirmed' : prev?.manualConfirmation ?? null.
 * - updatedAt := ev.at. Negative age (event earlier than prev.updatedAt) counts as 0.
 */
export function applyEvidence(prev: ConceptStateRecord | null, ev: EvidenceEvent, opts?: EvidenceOptions): ConceptStateRecord {
  const halfLifeDays = opts?.halfLifeDays;
  if (ev.source === "declaration") {
    if (!ev.targetState) throw new Error("applyEvidence: a declaration requires targetState");
    return { probability: manualTargetProbability(ev.targetState), decayClass: "manual_pending", source: "manual", manualConfirmation: "pending", updatedAt: ev.at };
  }
  if (ev.correct === null) throw new Error("applyEvidence: correct is required except for declarations");
  // ADR 101: first decay the previous P up to ev.at; negative age counts as 0 (decayedProbability already handles this).
  const base = prev ? decayedProbability(prev.probability, prev.decayClass, ageDaysSince(prev.updatedAt, new Date(ev.at)), halfLifeDays) : null;
  const probability = applyGradeToProbability(base, ev.correct, ev.weight);
  if (ev.source === "confirmation") {
    return {
      probability,
      decayClass: ev.correct ? "manual_confirmed" : "strain",
      source: prev?.source ?? "grade",
      manualConfirmation: ev.correct ? "confirmed" : "pending",
      updatedAt: ev.at,
    };
  }
  if (ev.responseFormat === null) throw new Error("applyEvidence: responseFormat is required for a grade");
  return {
    probability,
    decayClass: classifyGradeEvent({ correct: ev.correct, responseFormat: ev.responseFormat }),
    source: "grade",
    manualConfirmation: prev?.manualConfirmation === "pending" && ev.correct ? "confirmed" : (prev?.manualConfirmation ?? null),
    updatedAt: ev.at,
  };
}

/**
 * Invariant: the state is rebuilt by applying the events in `at` order
 * (ties: input order, i.e. stable order). No events → null.
 */
export function rebuildState(events: readonly EvidenceEvent[], opts?: EvidenceOptions): ConceptStateRecord | null {
  // Array.prototype.sort is stable: ties on `at` keep the input order.
  const sorted = [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  let rec: ConceptStateRecord | null = null;
  for (const ev of sorted) rec = applyEvidence(rec, ev, opts);
  return rec;
}

export interface EffectiveState {
  state: ConceptState;
  /** P' decayed to `now`; null if there is no evidence. */
  probability: number | null;
  /** isEvidenceStaleForDiagnostic from GL; false if there is no evidence. */
  stale: boolean;
}

/** Read: P' = decayedProbability(P, class, age) → deriveState(P'). No record → 'unknown'. */
export function effectiveState(rec: ConceptStateRecord | null, now: Date, opts?: EvidenceOptions): EffectiveState {
  if (!rec) return { state: "unknown", probability: null, stale: false };
  const halfLifeDays = opts?.halfLifeDays ?? evidenceHalfLifeDaysFromEnv();
  const probability = decayedProbability(rec.probability, rec.decayClass, ageDaysSince(rec.updatedAt, now), halfLifeDays);
  const stale = isEvidenceStaleForDiagnostic({ probability: rec.probability, decayClass: rec.decayClass, updatedAt: rec.updatedAt, now, halfLifeDays });
  return { state: deriveState(probability), probability, stale };
}

/** An early, correct flashcard review does NOT generate evidence. */
export function flashcardGeneratesEvidence(input: { early: boolean; correct: boolean }): boolean {
  return !(input.early && input.correct);
}
