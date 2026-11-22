// N-day plan between sessions (ADR 105 §7, point 23; GET /plan and MCP `get_week_plan`). Loads the same candidates
// as the brief's `suggestedToday` and delegates the distribution to core's `buildWeekPlan`. No LLM.
import { buildWeekPlan, dependentsCount } from "@graphharness/core";
import type { WeekPlanView } from "@graphharness/contracts";
import { examScope, graphEdges, parseIds, suggestedKindFlags, type ExamRow } from "./brief.ts";
import type { HubContext } from "./context.ts";
import { effectiveStates } from "./evidence.ts";

/** `from` (YYYY-MM-DD, UTC) defaults to today; for another day, states are computed at noon of that day (like the brief). */
export function getWeekPlan(ctx: HubContext, opts: { days?: number; from?: string } = {}): WeekPlanView {
  const db = ctx.db;
  const realNow = ctx.now();
  const today = realNow.toISOString().slice(0, 10);
  const from = opts.from ?? today;
  const now = from === today ? realNow : new Date(`${from}T12:00:00.000Z`);

  // Active concepts outside archived subjects; exams of those subjects from `from`.
  const concepts = db
    .prepare(
      `SELECT c.id, c.name, c.subject_id FROM concepts c LEFT JOIN subjects s ON s.id = c.subject_id
       WHERE c.status = 'active' AND s.archived_at IS NULL ORDER BY c.id`,
    )
    .all() as { id: string; name: string; subject_id: string | null }[];
  const states = effectiveStates(db, now, concepts.map((c) => c.id));
  const examRows = db
    .prepare(
      `SELECT e.* FROM exams e JOIN subjects s ON s.id = e.subject_id
       WHERE s.archived_at IS NULL AND e.date >= ? ORDER BY e.date, e.id`,
    )
    .all(from) as ExamRow[];

  // Dependents in scope, as in `suggestedToday`: that of the nearest exam that includes the concept; otherwise, its subject.
  const edges = graphEdges(db);
  const examScopes = examRows.map((e) => new Set(examScope(db, e))); // already sorted by date
  const bySubject = new Map<string | null, Set<string>>();
  for (const c of concepts) {
    if (!bySubject.has(c.subject_id)) bySubject.set(c.subject_id, new Set());
    bySubject.get(c.subject_id)!.add(c.id);
  }
  const kindFlags = suggestedKindFlags(db);

  const plan = buildWeekPlan({
    today: from,
    days: opts.days ?? 7,
    itemsPerDay: ctx.config.planItemsPerDay,
    concepts: concepts.map((c) => {
      const s = states.get(c.id)!;
      const scope = examScopes.find((x) => x.has(c.id)) ?? bySubject.get(c.subject_id)!;
      return { conceptId: c.id, subjectId: c.subject_id, state: s.state, probability: s.probability, stale: s.stale, dependents: dependentsCount(c.id, edges, scope), ...kindFlags(c.id) };
    }),
    exams: examRows.map((e) => {
      const ids = parseIds(e.scope_concept_ids_json);
      return { id: e.id, subjectId: e.subject_id, date: e.date, scopeConceptIds: ids.length ? ids : null };
    }),
  });

  const byId = new Map(concepts.map((c) => [c.id, c]));
  return {
    from,
    days: plan.days.map((d) => ({
      date: d.date,
      items: d.items.map((i) => {
        const c = byId.get(i.conceptId)!;
        return { conceptId: i.conceptId, conceptName: c.name, subjectId: c.subject_id, kind: i.kind, why: i.why };
      }),
    })),
    unscheduledCount: plan.unscheduledConceptIds.length,
  };
}
