// LH agent tools over the Hub (ADR 105 §5): hub_errors, hub_profile and hub_capture.
import { firstReviewDelayDays, isoNow, newSchedule } from "@graphharness/core";
import type { CaptureBody, CaptureResponse, ErrorsQuery, ErrorView, MissClass, Profile } from "@graphharness/contracts";
import { HubError, notFound } from "../errors.ts";
import { insertCard } from "./cards.ts";
import { nearestExamDate, validateDraft } from "./card-generation.ts";
import { getConceptRow } from "./concepts.ts";
import type { HubContext } from "./context.ts";
import { searchConceptsFts } from "./fts.ts";
import { addConceptNote } from "./notes.ts";
import { resolveConcepts } from "./search.ts";

const DAY_MS = 86_400_000;
/** Analytics window of hub_profile. */
const WINDOW_DAYS = 90;
const QUERY_LIMIT = 10;
const RECURRING_TOP = 5;
const RECURRING_MIN_SEEN = 2;
/** hub_capture: minimum score of the best candidate (and no tie) so the user is not asked. */
const CAPTURE_MIN_SCORE = 0.6;
const CAPTURE_CANDIDATES = 5;
const OVERCONFIDENT = 75;
const UNDERCONFIDENT = 25;

interface ErrorRow {
  conceptId: string;
  conceptName: string;
  templateId: string;
  errorKey: string;
  description: string;
  origin: "recipe" | "personal";
  timesSeen: number;
  lastSeenAt: string | null;
}

/** Errors of active templates of live concepts. `personalFirst` (hub_errors): personal first, then most seen; otherwise (recurring), most seen first, then personal. */
function errorViews(ctx: HubContext, o: { conceptIds?: readonly string[]; minSeen?: number; personalFirst: boolean; limit: number }): ErrorView[] {
  const ids = o.conceptIds ? JSON.stringify(o.conceptIds) : null;
  return ctx.db
    .prepare(
      `SELECT c.id AS conceptId, c.name AS conceptName, t.id AS templateId, e.key AS errorKey, e.description,
              e.origin, e.times_seen AS timesSeen, e.last_seen_at AS lastSeenAt
       FROM template_errors e
       JOIN templates t ON t.id = e.template_id AND t.status = 'active'
       JOIN concepts c ON c.id = t.concept_id AND c.status = 'active'
       WHERE (? IS NULL OR c.id IN (SELECT value FROM json_each(?))) AND e.times_seen >= ?
       ORDER BY ${o.personalFirst ? "e.origin = 'personal' DESC, e.times_seen DESC" : "e.times_seen DESC, e.origin = 'personal' DESC"}, e.key, c.id
       LIMIT ?`,
    )
    .all(ids, ids, o.minSeen ?? 0, o.limit) as ErrorRow[];
}

export function conceptErrors(ctx: HubContext, q: ErrorsQuery): { errors: ErrorView[] } {
  if (q.conceptIds.length === 0 && q.query === undefined)
    throw new HubError(400, { error: "invalid_request", message: "provide conceptIds or query" });
  const ids = new Set(q.conceptIds);
  if (q.query !== undefined) for (const h of searchConceptsFts(ctx.db, q.query, { limit: QUERY_LIMIT })) ids.add(h.conceptId);
  return { errors: errorViews(ctx, { conceptIds: [...ids], personalFirst: true, limit: q.limit }) };
}

export function profile(ctx: HubContext): Profile {
  const since = isoNow(new Date(ctx.now().getTime() - WINDOW_DAYS * DAY_MS));

  const missClassCounts: Profile["missClassCounts"] = { cue: 0, discrimination: 0, execution: 0, careless: 0, structural: 0 };
  const misses = ctx.db
    .prepare(
      `SELECT miss_class AS missClass, count(*) AS n FROM evidence_events
       WHERE source = 'lh_practice' AND miss_class IS NOT NULL AND at >= ? GROUP BY miss_class`,
    )
    .all(since) as { missClass: MissClass; n: number }[];
  for (const m of misses) missClassCounts[m.missClass] = m.n;

  const rows = ctx.db
    .prepare(
      `SELECT s.id AS subjectId, s.name AS subjectName, count(*) AS n, avg(ev.confidence) AS meanConfidence,
              avg(ev.correct) AS accuracy,
              sum(ev.correct = 0 AND ev.confidence >= ?) AS overconfidentWrong,
              sum(ev.correct = 1 AND ev.confidence <= ?) AS underconfidentRight
       FROM evidence_events ev
       JOIN concepts c ON c.id = ev.concept_id AND c.status = 'active'
       JOIN subjects s ON s.id = c.subject_id
       WHERE ev.confidence IS NOT NULL AND ev.at >= ?
       GROUP BY s.id ORDER BY s.name, s.id`,
    )
    .all(OVERCONFIDENT, UNDERCONFIDENT, since) as Profile["calibration"];
  const calibration = rows.map((r) => ({
    ...r,
    meanConfidence: Math.round(r.meanConfidence * 10) / 10,
    accuracy: Math.round(r.accuracy * 1000) / 1000,
  }));

  return { recurringErrors: errorViews(ctx, { minSeen: RECURRING_MIN_SEEN, personalFirst: false, limit: RECURRING_TOP }), missClassCounts, calibration };
}

/** conceptId or conceptQuery → concept; 404 if there are no candidates, 409 with candidates if there is no clear winner (never guessed). */
export async function resolveTarget(ctx: HubContext, body: { conceptId?: string | undefined; conceptQuery?: string | undefined }): Promise<{ id: string; name: string; subjectId: string | null }> {
  if (body.conceptId !== undefined) {
    const c = getConceptRow(ctx.db, body.conceptId);
    return { id: c.id, name: c.name, subjectId: c.subject_id };
  }
  const { candidates } = await resolveConcepts(ctx, { text: body.conceptQuery!, limit: CAPTURE_CANDIDATES });
  if (candidates.length === 0) throw notFound();
  const [best, second] = candidates;
  if (best!.score < CAPTURE_MIN_SCORE || (second !== undefined && second.score === best!.score))
    throw new HubError(409, {
      error: "ambiguous_concept",
      candidates: candidates.map((c) => ({ conceptId: c.conceptId, name: c.name, score: c.score })),
    });
  const c = getConceptRow(ctx.db, best!.conceptId);
  return { id: c.id, name: c.name, subjectId: c.subject_id };
}

export async function capture(ctx: HubContext, body: CaptureBody): Promise<CaptureResponse> {
  const concept = await resolveTarget(ctx, body);
  if (body.kind === "note") {
    const note = addConceptNote(ctx, { conceptId: concept.id, text: body.text, origin: "lh" });
    return { kind: "note", id: note.id, conceptId: concept.id, conceptName: concept.name };
  }
  // The same rules as generation; no associated propositions. Capture only cloze|text.
  const card = validateDraft(
    body.type === "cloze"
      ? { kind: "cloze", front: body.front, answer: body.answer, accepted: [], propositionIds: [] }
      : { kind: "text", front: body.front, answer: body.answer, accepted: [], propositionIds: [] },
    [],
  );
  if (!card) throw new HubError(400, { error: "invalid_request", message: "invalid card: empty answer, answer longer than 60 characters, or unclosed `$`" });
  const now = ctx.now();
  const schedule = newSchedule(now.getTime(), firstReviewDelayDays(now, nearestExamDate(ctx.db, concept.subjectId, now)));
  const id = insertCard(ctx.db, { ...card, conceptId: concept.id, purpose: "review", schedule }, now);
  return { kind: "card", id, conceptId: concept.id, conceptName: concept.name };
}
