// Ported from graphlearn/packages/flashcards/src (65b56d6) + ADR 108 (parsons/predict/spot_bug).
// Local card grading (025: no LLM).

export function normalizeAnswer(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[−–]/g, "-")
    .replace(/·|×/g, "*")
    .replace(/\*\*/g, "^")
    .replace(/,(?=\d)/g, ".")
    .replace(/[()[\]{}]/g, "");
}

export function gradeText(expected: string, given: string): boolean {
  return normalizeAnswer(expected) === normalizeAnswer(given);
}

/** Exact id order (Parsons). `given` = array of ids in the student's order (without distractors). */
export function gradeParsons(expectedOrder: readonly string[], given: unknown): boolean {
  if (!Array.isArray(given) || given.length !== expectedOrder.length) return false;
  return expectedOrder.every((id, i) => given[i] === id);
}

/** Predict / cloze-like: text or variants. */
export function gradePredict(expected: string, accepted: readonly string[], given: unknown): boolean {
  if (typeof given !== "string" && typeof given !== "number") return false;
  const g = String(given);
  return [expected, ...accepted].some((a) => gradeText(a, g));
}

/** Spot-the-bug: the student picks the id of the defective line. */
export function gradeSpotBug(expectedLineId: string, given: unknown): boolean {
  return typeof given === "string" && given === expectedLineId;
}

/**
 * After `failCount` failures, how many distractors to keep visible (adaptive intra-problem).
 * 0–1 failures → all; 2 → half (ceil); ≥3 → none.
 */
export function visibleDistractorCount(totalDistractors: number, failCount: number): number {
  if (totalDistractors <= 0) return 0;
  if (failCount < 2) return totalDistractors;
  if (failCount === 2) return Math.ceil(totalDistractors / 2);
  return 0;
}
