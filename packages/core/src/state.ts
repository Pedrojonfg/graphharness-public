// Ported from graphlearn/packages/contracts/src/graph.ts (65b56d6). nodeId → conceptId; no Supabase or project schemas.
// Constants overridable via env.

export type ConceptState = "solid" | "review" | "weak" | "unknown";
export type EvidenceSource = "grade" | "manual";
export type ManualConfirmation = "pending" | "confirmed";

export interface EdgeLike {
  from: string;
  to: string;
  confidence?: "high" | "medium" | "low";
  relation?: "requires" | "illustrates";
}

export const DEFAULT_SOLID_PROBABILITY_THRESHOLD = 0.75;
export const DEFAULT_REVIEW_PROBABILITY_THRESHOLD = 0.4;
export const DEFAULT_PRIOR_PROBABILITY = 0.5;
export const DEFAULT_GRADE_CORRECT_DELTA = 0.15;
/** Magnitude of the failure delta (subtracted). The env accepts "-0.20" or "0.20". */
export const DEFAULT_GRADE_INCORRECT_DELTA = 0.2;
/** ADR 053 — P increase when skipping prerequisites via upward inference. */
export const DEFAULT_INFERENCE_BUMP_SCALE = 0.45;

function envNumber(raw: string | undefined, fallback: number, ok: (n: number) => boolean): number {
  if (!raw) return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && ok(n) ? n : fallback;
}

export function resolveSolidProbabilityThreshold(raw = process.env.SOLID_PROBABILITY_THRESHOLD): number {
  return envNumber(raw, DEFAULT_SOLID_PROBABILITY_THRESHOLD, (n) => n > 0 && n <= 1);
}

export function resolveReviewProbabilityThreshold(raw = process.env.REVIEW_PROBABILITY_THRESHOLD): number {
  return envNumber(raw, DEFAULT_REVIEW_PROBABILITY_THRESHOLD, (n) => n > 0 && n <= 1);
}

export function resolvePriorProbability(raw = process.env.PRIOR_PROBABILITY): number {
  return envNumber(raw, DEFAULT_PRIOR_PROBABILITY, (n) => n >= 0 && n <= 1);
}

export function resolveGradeCorrectDelta(raw = process.env.GRADE_CORRECT_DELTA): number {
  return envNumber(raw, DEFAULT_GRADE_CORRECT_DELTA, (n) => n > 0 && n <= 1);
}

export function resolveGradeIncorrectDelta(raw = process.env.GRADE_INCORRECT_DELTA): number {
  return Math.abs(envNumber(raw, DEFAULT_GRADE_INCORRECT_DELTA, (n) => n !== 0 && Math.abs(n) <= 1));
}

export function resolveInferenceBumpScale(raw = process.env.INFERENCE_BUMP_SCALE): number {
  return envNumber(raw, DEFAULT_INFERENCE_BUMP_SCALE, (n) => n > 0);
}

export function deriveState(
  probability: number,
  solidThreshold: number = resolveSolidProbabilityThreshold(),
  reviewThreshold: number = resolveReviewProbabilityThreshold(),
): Exclude<ConceptState, "unknown"> {
  const p = Math.min(1, Math.max(0, probability));
  if (p >= solidThreshold) return "solid";
  if (p >= reviewThreshold) return "review";
  return "weak";
}

/** Delta of a grade, scaled by `weight` (D26: flashcards 0.5). `previous` null → prior. */
export function applyGradeToProbability(previous: number | null, correct: boolean, weight = 1): number {
  const base = previous ?? resolvePriorProbability();
  const delta = correct ? resolveGradeCorrectDelta() : -resolveGradeIncorrectDelta();
  return Math.min(1, Math.max(0, base + delta * weight));
}

function inferenceEdgeWeight(confidence?: EdgeLike["confidence"]): number {
  if (confidence === "medium") return 0.65;
  if (confidence === "low") return 0;
  return 1;
}

/** Path P→N (prerequisite → dependent); null if there is no usable path (050: without `low`). */
export function computeInferenceBump(
  graph: { edges: ReadonlyArray<EdgeLike> },
  fromP: string,
  toN: string,
  scale: number = DEFAULT_INFERENCE_BUMP_SCALE,
): number | null {
  const edges = graph.edges.filter((e) => (e.relation ?? "requires") !== "illustrates" && e.confidence !== "low");
  const byFrom = new Map<string, { to: string; weight: number }[]>();
  for (const e of edges) {
    const w = inferenceEdgeWeight(e.confidence);
    if (w <= 0) continue;
    byFrom.set(e.from, [...(byFrom.get(e.from) ?? []), { to: e.to, weight: w }]);
  }
  const distQ: { id: string; d: number }[] = [{ id: fromP, d: 0 }];
  const seen = new Set([fromP]);
  let shortest: number | null = null;
  while (distQ.length) {
    const { id, d } = distQ.shift()!;
    if (id === toN) {
      shortest = d;
      break;
    }
    for (const { to } of byFrom.get(id) ?? []) {
      if (seen.has(to)) continue;
      seen.add(to);
      distQ.push({ id: to, d: d + 1 });
    }
  }
  if (!shortest || shortest <= 0) return null;

  let bestStrength = 0;
  const walk = (cur: string, depth: number, strength: number) => {
    if (depth === shortest) {
      if (cur === toN) bestStrength = Math.max(bestStrength, strength);
      return;
    }
    for (const { to, weight } of byFrom.get(cur) ?? []) walk(to, depth + 1, strength * weight);
  };
  walk(fromP, 0, 1);
  if (bestStrength <= 0) return null;
  return (scale * bestStrength) / shortest;
}

/** P(prepared) V0: mean of the probabilities of the scope's concepts that have evidence. */
export function goalPreparedProbability(conceptIds: string[], probabilitiesByConcept: Map<string, number>): number | null {
  if (conceptIds.length === 0) return null;
  let sum = 0;
  let count = 0;
  for (const id of conceptIds) {
    const p = probabilitiesByConcept.get(id);
    if (p !== undefined) {
      sum += p;
      count += 1;
    }
  }
  if (count === 0) return null;
  return sum / count;
}
