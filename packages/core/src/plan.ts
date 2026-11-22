// N-day plan between sessions (ADR 105 §7, point 23): deterministic, no LLM. Distributes the candidates of
// `suggestedToday` (same priority and same `kind` rule, ADR 102 §9) over days with fixed capacity,
// from highest to lowest priority, each one before its nearest applicable exam.
import { SUGGESTED_STATE_LABEL, daysUntil, suggestedKind, suggestedTodayPriority, whenLabel } from "./brief.ts";

export interface PlanConcept {
  conceptId: string;
  subjectId: string | null;
  state: "solid" | "review" | "weak" | "unknown";
  /** Effective P'; null without evidence. */
  probability: number | null;
  stale: boolean;
  dependents: number;
  /** `kind` rule of `suggestedToday`: active template → exercises. */
  hasTemplate: boolean;
  /** Non-retired review cards → cards (if there is no template). */
  hasCards: boolean;
}

export interface PlanExam {
  id: string;
  subjectId: string;
  /** YYYY-MM-DD */
  date: string;
  scopeConceptIds: string[] | null;
}

export interface PlanInput {
  today: string;
  days: number;
  itemsPerDay: number;
  concepts: PlanConcept[];
  exams: PlanExam[];
}

export interface PlanItem {
  conceptId: string;
  kind: "session" | "cards" | "exercises";
  why: string;
  priority: number;
}

export interface WeekPlan {
  days: { date: string; items: PlanItem[] }[];
  unscheduledConceptIds: string[];
}

const DAY_MS = 86_400_000;

export function buildWeekPlan(input: PlanInput): WeekPlan {
  if (!Number.isInteger(input.days) || input.days < 1 || input.days > 14) throw new RangeError(`days out of range 1..14: ${input.days}`);
  const start = Date.parse(`${input.today}T00:00:00Z`);
  const days = Array.from({ length: input.days }, (_, i) => ({ date: new Date(start + i * DAY_MS).toISOString().slice(0, 10), items: [] as PlanItem[] }));
  const todayNoon = new Date(start + DAY_MS / 2);
  // Exams from today onwards (past ones are ignored), with their remaining days.
  const exams = input.exams.map((e) => ({ e, left: daysUntil(e.date, todayNoon) })).filter((x) => x.left >= 0);

  const ranked = input.concepts
    .filter((c) => !(c.state === "solid" && !c.stale))
    .map((c) => {
      const applies = (e: PlanExam) => (e.scopeConceptIds ? e.scopeConceptIds.includes(c.conceptId) : c.subjectId !== null && e.subjectId === c.subjectId);
      const near = exams.filter((x) => applies(x.e)).reduce<number | null>((min, x) => (min === null || x.left < min ? x.left : min), null);
      const priority = suggestedTodayPriority({ daysToExam: near, effectiveProbability: c.probability, dependentsInScope: c.dependents });
      const parts: string[] = [SUGGESTED_STATE_LABEL[c.state]];
      if (near !== null) parts.push(`exam ${whenLabel(near)}`);
      if (c.dependents > 0) parts.push(`${c.dependents} ${c.dependents === 1 ? "concept depends" : "concepts depend"} on it`);
      const item: PlanItem = { conceptId: c.conceptId, kind: suggestedKind(c), why: `${parts.join("; ")}.`, priority };
      // Last day it may go: the one before the exam (exam today or tomorrow → today); without an exam, the horizon.
      return { item, lastDay: near === null ? input.days - 1 : Math.min(input.days - 1, Math.max(0, near - 1)) };
    })
    .filter((x) => x.item.priority > 0)
    .sort((a, b) => b.item.priority - a.item.priority || (a.item.conceptId < b.item.conceptId ? -1 : 1));

  // Greedy placement: the first day with room within the deadline; if there is none, it stays unscheduled.
  const unscheduledConceptIds: string[] = [];
  for (const { item, lastDay } of ranked) {
    const day = days.slice(0, lastDay + 1).find((d) => d.items.length < input.itemsPerDay);
    if (day) day.items.push(item);
    else unscheduledConceptIds.push(item.conceptId);
  }
  return { days, unscheduledConceptIds };
}
