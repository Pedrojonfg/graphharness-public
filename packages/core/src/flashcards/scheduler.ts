// Ported from graphlearn/packages/flashcards/src (65b56d6). Unchanged.
// Flashcard scheduler: ordinal SM-2 (025), no LLM. Pure logic, times in ms.

export const DEFAULT_EASE = 2.5;
export const MIN_EASE = 1.3;
export const MAX_EASE = 3.0;
/** Fast / slow response (adjusts ease, as in simple_study). Calibratable in a pilot. */
export const FAST_MS = 8_000;
export const SLOW_MS = 25_000;
/** Window for "it actually went well" in cloze/text. */
export const OVERRIDE_WINDOW_MS = 60_000;

const DAY = 86_400_000;

export interface CardSchedule {
  ease: number;
  intervalDays: number;
  repetitions: number;
  /** Last review or, if never reviewed, when it was created or imported. */
  tRef: number;
  /** Never reviewed: the first review always takes the "real" path (025). */
  reviewed: boolean;
}

/** 057: first review based on the goal's exam date. No date → 1 day. */
export function firstReviewDelayDays(now: Date, examDate: string | null): number {
  if (!examDate) return 1;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const days = Math.max(0, Math.ceil((Date.parse(`${examDate}T00:00:00Z`) - today) / DAY));
  return Math.max(1, Math.min(30, Math.floor(days / 4)));
}

export function newSchedule(now: number, firstDelayDays: number): CardSchedule {
  return { ease: DEFAULT_EASE, intervalDays: firstDelayDays, repetitions: 0, tRef: now, reviewed: false };
}

/** Queue priority (025): how overdue it is (≥ 1 = due for review). */
export function priority(s: CardSchedule, now: number): number {
  return (now - s.tRef) / (Math.max(s.intervalDays, 1 / 24) * DAY);
}

export function isDue(s: CardSchedule, now: number): boolean {
  return priority(s, now) >= 1;
}

/** SM-2 quality (0–5) from correctness and response time. */
export function quality(correct: boolean, responseMs: number | null): number {
  if (!correct) return 1;
  if (responseMs !== null && responseMs <= FAST_MS) return 5;
  if (responseMs !== null && responseMs >= SLOW_MS) return 3;
  return 4;
}

const clampEase = (e: number) => Math.min(MAX_EASE, Math.max(MIN_EASE, e));

export interface ReviewInput {
  correct: boolean;
  responseMs: number | null;
  now: number;
}

export interface ReviewResult {
  schedule: CardSchedule;
  /** Reviewed before it was due (priority < 1) and not the first review. */
  early: boolean;
}

/**
 * A review (025):
 * - failure (early or not): ease lowered, interval set to 1 day, repetitions set to 0;
 * - early success: ease and interval do NOT grow; only the clock is reset;
 * - on-time success (or first review): normal SM-2.
 */
export function review(s: CardSchedule, input: ReviewInput): ReviewResult {
  const early = s.reviewed && priority(s, input.now) < 1;
  const q = quality(input.correct, input.responseMs);
  if (!input.correct) {
    return {
      early,
      schedule: { ease: clampEase(s.ease - 0.2), intervalDays: 1, repetitions: 0, tRef: input.now, reviewed: true },
    };
  }
  if (early) return { early, schedule: { ...s, tRef: input.now, reviewed: true } };
  const ease = clampEase(s.ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
  const repetitions = s.repetitions + 1;
  const intervalDays =
    repetitions === 1 ? Math.max(1, s.intervalDays) : Math.max(1, Math.round(s.intervalDays * ease * 10) / 10);
  return { early, schedule: { ease, intervalDays, repetitions, tRef: input.now, reviewed: true } };
}

/**
 * "Actually it went well" (cloze/text): undoes a recent failure and counts it as a success
 * from the previous state. Only within the short window.
 */
export function overrideToCorrect(before: CardSchedule, failedAt: number, now: number, responseMs: number | null): ReviewResult | null {
  if (now - failedAt > OVERRIDE_WINDOW_MS) return null;
  return review(before, { correct: true, responseMs, now: failedAt });
}

/** Infinite queue (025): all non-retired cards, from highest to lowest priority. */
export function orderQueue<T extends { schedule: CardSchedule; retired?: boolean }>(cards: T[], now: number): T[] {
  return cards.filter((c) => !c.retired).sort((a, b) => priority(b.schedule, now) - priority(a.schedule, now));
}
