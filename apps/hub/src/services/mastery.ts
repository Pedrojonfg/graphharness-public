// GET /mastery: what LH's `hub_mastery` tool (P3a) needs to know about the domain. ADR 104.
import type { Mastery, MasteryQuery } from "@graphharness/contracts";
import { HubError } from "../errors.ts";
import { stateViews } from "./concepts.ts";
import type { HubContext } from "./context.ts";
import { searchConceptsFts } from "./fts.ts";

const DAY_MS = 86_400_000;
const QUERY_LIMIT = 10;

export function mastery(ctx: HubContext, q: MasteryQuery): Mastery {
  if (q.propositionIds.length === 0 && q.query === undefined)
    throw new HubError(400, { error: "invalid_request", message: "provide propositionIds or query" });

  // live proposition → active concept (merged concepts have already re-pointed their propositions)
  const byConcept = new Map<string, string[]>();
  const mapped = new Set<string>();
  const find = ctx.db.prepare(
    `SELECT c.id FROM concept_propositions cp
       JOIN lh_propositions p ON p.id = cp.proposition_id AND p.deleted = 0
       JOIN concepts c ON c.id = cp.concept_id AND c.status = 'active'
     WHERE cp.proposition_id = ?`,
  ).pluck();
  for (const pid of q.propositionIds) {
    const conceptId = find.get(pid) as string | undefined;
    if (!conceptId) continue;
    mapped.add(pid);
    byConcept.set(conceptId, [...(byConcept.get(conceptId) ?? []), pid]);
  }
  if (q.query !== undefined)
    for (const h of searchConceptsFts(ctx.db, q.query, { limit: QUERY_LIMIT }))
      if (!byConcept.has(h.conceptId)) byConcept.set(h.conceptId, []);

  const ids = [...byConcept.keys()];
  const views = stateViews(ctx, ids);
  const names = ctx.db.prepare("SELECT name FROM concepts WHERE id = ? AND status = 'active'").pluck();
  const now = ctx.now().getTime();
  const concepts = ids
    .map((conceptId) => {
      const v = views.get(conceptId)!;
      return {
        conceptId,
        name: names.get(conceptId) as string | undefined,
        state: v.state,
        stale: v.stale,
        lastEvidenceAt: v.lastEvidenceAt,
        ageDays: v.lastEvidenceAt === null ? null : Math.max(0, Math.floor((now - Date.parse(v.lastEvidenceAt)) / DAY_MS)),
        propositionIds: byConcept.get(conceptId)!,
      };
    })
    .filter((c): c is typeof c & { name: string } => c.name !== undefined) // an FTS hit of a non-active concept
    .sort((a, b) => a.name.localeCompare(b.name) || a.conceptId.localeCompare(b.conceptId));
  return { concepts, unmappedPropositionIds: q.propositionIds.filter((p) => !mapped.has(p)) };
}
