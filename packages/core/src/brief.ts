// `suggestedToday` is deterministic, with no LLM. Concrete interpretation in ADR 102.

/**
 * Priority = closeness × (1 − P') × (1 + dependents in scope).
 * - closeness = 1 / (1 + max(0, daysToExam)); no exam → 1 / 31 (as if 30 days were missing).
 * - P' null (no evidence) → 0.5 is used.
 * - negative dependents do not exist; 0 dependents → factor 1.
 */
export function suggestedTodayPriority(input: {
  daysToExam: number | null;
  effectiveProbability: number | null;
  dependentsInScope: number;
}): number {
  const closeness = input.daysToExam === null ? 1 / 31 : 1 / (1 + Math.max(0, input.daysToExam));
  const p = input.effectiveProbability ?? 0.5;
  return closeness * (1 - p) * (1 + Math.max(0, input.dependentsInScope));
}

/** Calendar days (UTC) from `now` to `date` (YYYY-MM-DD); negative if already past. */
export function daysUntil(date: string, now: Date): number {
  const day = (ms: number) => Math.floor(ms / 86_400_000);
  return day(Date.parse(`${date}T00:00:00Z`)) - day(now.getTime());
}

/** What to do with a suggested concept: active template → exercises; review cards → cards; otherwise → session in LH. */
export function suggestedKind(input: { hasTemplate: boolean; hasCards: boolean }): "session" | "cards" | "exercises" {
  return input.hasTemplate ? "exercises" : input.hasCards ? "cards" : "session";
}

/** Label for the state of a suggested concept (solid ones only arrive when they are aged). */
export const SUGGESTED_STATE_LABEL = { solid: "solid but aged", review: "to review", weak: "weak", unknown: "no record" } as const;

/** "today", "tomorrow" or "in N days". */
export function whenLabel(days: number): string {
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  return `in ${days} days`;
}
