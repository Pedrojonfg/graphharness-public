// ADR 105 §6 (19, 20): classification of prior knowledge of a new proposition.
import type { ConceptState } from "./state.ts";

export type PriorRelation = "same" | "related" | "new";
export type PriorBucket = "known" | "stale" | "weak" | "new";

/** Fixed bucket order: also the tie-break when distributing percentages. */
const BUCKETS: readonly PriorBucket[] = ["known", "stale", "weak", "new"];

/**
 * `state` = EFFECTIVE state of the matched concept (with decay); `rawState` = `deriveState` of the stored P, without decay.
 * new: no match, relation "new", or concept without evidence · known: effectively solid · stale: was solid and no longer is · weak: never was.
 */
export function priorBucket(relation: PriorRelation, matched: { state: ConceptState; rawState: ConceptState } | null): PriorBucket {
  if (relation === "new" || matched === null || matched.state === "unknown") return "new";
  if (matched.state === "solid") return "known";
  return matched.rawState === "solid" ? "stale" : "weak";
}

/** Integer counts and percentages that sum to 100 (largest remainder method; tie-break: known, stale, weak, new). */
export function summarizePrior(buckets: PriorBucket[]): { total: number; counts: Record<PriorBucket, number>; percentages: Record<PriorBucket, number> } {
  const total = buckets.length;
  const counts: Record<PriorBucket, number> = { known: 0, stale: 0, weak: 0, new: 0 };
  for (const b of buckets) counts[b]++;
  const percentages: Record<PriorBucket, number> = { known: 0, stale: 0, weak: 0, new: 0 };
  if (total === 0) return { total, counts, percentages };
  for (const b of BUCKETS) percentages[b] = Math.floor((counts[b] * 100) / total);
  let left = 100 - BUCKETS.reduce((s, b) => s + percentages[b], 0);
  const byRemainder = BUCKETS.map((b, i) => ({ b, i, rem: (counts[b] * 100) % total })).sort((x, y) => y.rem - x.rem || x.i - y.i);
  for (const { b } of byRemainder) {
    if (left === 0) break;
    percentages[b]++;
    left--;
  }
  return { total, counts, percentages };
}
