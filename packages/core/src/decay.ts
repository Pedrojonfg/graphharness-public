// Ported from graphlearn/packages/contracts/src/evidence-decay.ts (65b56d6). Constants unchanged.
/** ADR 040 — exponential decay of P by the quality of the last event (005 / S14). */

import { deriveState, resolveSolidProbabilityThreshold } from "./state.ts";
import type { ConceptState, ManualConfirmation } from "./state.ts";

export type ResponseFormat = "open" | "mcq";

export type EvidenceDecayClass =
  | "reasoned"
  | "quick"
  | "strain"
  | "manual_pending"
  | "manual_confirmed";

export const DEFAULT_EVIDENCE_HALFLIFE_REASONED_DAYS = 60;
export const DEFAULT_EVIDENCE_HALFLIFE_QUICK_DAYS = 30;
export const DEFAULT_EVIDENCE_HALFLIFE_STRAIN_DAYS = 21;
export const DEFAULT_EVIDENCE_HALFLIFE_MANUAL_PENDING_DAYS = 5;
export const DEFAULT_EVIDENCE_HALFLIFE_MANUAL_CONFIRMED_DAYS = 45;

export const DEFAULT_DIAGNOSTIC_STALE_PROBABILITY = 0.55;

export function resolveDiagnosticStaleProbability(raw: string | undefined = process.env.DIAGNOSTIC_STALE_PROBABILITY): number {
  if (!raw) return DEFAULT_DIAGNOSTIC_STALE_PROBABILITY;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : DEFAULT_DIAGNOSTIC_STALE_PROBABILITY;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return n;
}

export function resolveEvidenceHalfLifeReasonedDays(
  raw: string | undefined = process.env.EVIDENCE_HALFLIFE_REASONED_DAYS,
): number {
  return parsePositiveInt(raw, DEFAULT_EVIDENCE_HALFLIFE_REASONED_DAYS);
}

export function resolveEvidenceHalfLifeQuickDays(
  raw: string | undefined = process.env.EVIDENCE_HALFLIFE_QUICK_DAYS,
): number {
  return parsePositiveInt(raw, DEFAULT_EVIDENCE_HALFLIFE_QUICK_DAYS);
}

export function resolveEvidenceHalfLifeStrainDays(
  raw: string | undefined = process.env.EVIDENCE_HALFLIFE_STRAIN_DAYS,
): number {
  return parsePositiveInt(raw, DEFAULT_EVIDENCE_HALFLIFE_STRAIN_DAYS);
}

export function resolveEvidenceHalfLifeManualPendingDays(
  raw: string | undefined = process.env.EVIDENCE_HALFLIFE_MANUAL_PENDING_DAYS,
): number {
  return parsePositiveInt(raw, DEFAULT_EVIDENCE_HALFLIFE_MANUAL_PENDING_DAYS);
}

export function resolveEvidenceHalfLifeManualConfirmedDays(
  raw: string | undefined = process.env.EVIDENCE_HALFLIFE_MANUAL_CONFIRMED_DAYS,
): number {
  return parsePositiveInt(raw, DEFAULT_EVIDENCE_HALFLIFE_MANUAL_CONFIRMED_DAYS);
}

export type EvidenceHalfLifeDays = Record<EvidenceDecayClass, number>;

export function evidenceHalfLifeDaysFromEnv(): EvidenceHalfLifeDays {
  return {
    reasoned: resolveEvidenceHalfLifeReasonedDays(),
    quick: resolveEvidenceHalfLifeQuickDays(),
    strain: resolveEvidenceHalfLifeStrainDays(),
    manual_pending: resolveEvidenceHalfLifeManualPendingDays(),
    manual_confirmed: resolveEvidenceHalfLifeManualConfirmedDays(),
  };
}

/** Decay class for a grade (last exercise event). */
export function classifyGradeEvent(input: {
  correct: boolean;
  responseFormat: ResponseFormat;
}): Exclude<EvidenceDecayClass, "manual_pending" | "manual_confirmed"> {
  if (!input.correct) return "strain";
  return input.responseFormat === "open" ? "reasoned" : "quick";
}

export function classifyManualDecayClass(
  manualConfirmation: ManualConfirmation,
): "manual_pending" | "manual_confirmed" {
  return manualConfirmation === "pending" ? "manual_pending" : "manual_confirmed";
}

export function ageDaysSince(updatedAt: string, now: Date): number {
  return (now.getTime() - Date.parse(updatedAt)) / 86_400_000;
}

/** P' = P * 0.5^(ageDays / halfLifeDays). */
export function decayedProbability(
  probability: number,
  decayClass: EvidenceDecayClass,
  ageDays: number,
  halfLifeDays: EvidenceHalfLifeDays = evidenceHalfLifeDaysFromEnv(),
): number {
  const halfLife = halfLifeDays[decayClass];
  if (halfLife <= 0 || ageDays <= 0) return Math.min(1, Math.max(0, probability));
  const p = Math.min(1, Math.max(0, probability));
  return p * 0.5 ** (ageDays / halfLife);
}

export function effectiveEvidenceState(input: {
  probability: number;
  decayClass: EvidenceDecayClass;
  updatedAt: string;
  now: Date;
  halfLifeDays?: EvidenceHalfLifeDays;
  solidThreshold?: number;
}): { probability: number; state: Exclude<ConceptState, "unknown"> } {
  const ageDays = ageDaysSince(input.updatedAt, input.now);
  const halfLife = input.halfLifeDays ?? evidenceHalfLifeDaysFromEnv();
  const solidThreshold = input.solidThreshold ?? resolveSolidProbabilityThreshold();
  const probability = decayedProbability(input.probability, input.decayClass, ageDays, halfLife);
  return { probability, state: deriveState(probability, solidThreshold) };
}

/** ADR 040 — stale for diagnosis: age > half-life or P' < threshold. */
export function isEvidenceStaleForDiagnostic(input: {
  probability: number;
  decayClass: EvidenceDecayClass;
  updatedAt: string;
  now: Date;
  halfLifeDays?: EvidenceHalfLifeDays;
  staleProbabilityThreshold?: number;
}): boolean {
  const ageDays = ageDaysSince(input.updatedAt, input.now);
  const halfLife = input.halfLifeDays ?? evidenceHalfLifeDaysFromEnv();
  const halfLifeDays = halfLife[input.decayClass];
  if (ageDays > halfLifeDays) return true;
  const staleP = input.staleProbabilityThreshold ?? resolveDiagnosticStaleProbability();
  const pPrime = decayedProbability(input.probability, input.decayClass, ageDays, halfLife);
  return pPrime < staleP;
}
