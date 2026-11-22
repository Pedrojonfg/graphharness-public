// ADR 105 §6 (19, 20): prior-knowledge report when importing material. Each new proposition is matched against the
// existing ones (candidates by lexical overlap → `cheap` LLM) and classified by the state of the matched concept.
import {
  deriveState,
  isoNow,
  normalizedTokens,
  priorBucket,
  summarizePrior,
  ulid,
  type ConceptState,
} from "@graphharness/core";
import type { PriorReport, PriorReportItem, PriorReportListQuery, PriorReportSummary } from "@graphharness/contracts";
import { fillPrompt, loadPrompt } from "@graphharness/llm";
import { z } from "zod";
import { notFound } from "../errors.ts";
import { stateViews } from "./concepts.ts";
import type { HubContext } from "./context.ts";

const MAX_CANDIDATES = 5;
const BATCH_SIZE = 40;
/** `meta` key with srcId → LH path (written by lh-sync; same as the worker's META_LH_FILE_SOURCES). */
const META_LH_FILE_SOURCES = "lh_file_sources";

const MatchesSchema = z.object({
  matches: z.array(
    z.object({
      propositionId: z.string(),
      matchedPropositionId: z.string().nullable(),
      relation: z.enum(["same", "related", "new"]),
    }),
  ),
});

interface PropRow {
  id: string;
  name: string;
  statement: string;
  provenance_json: string;
}

type Match = { relation: "same" | "related" | "new"; matchedId: string | null };

/**
 * Builds and saves the report for `propositionIds` (those of the import). `excludeSourcePaths` = LH paths of the
 * import: their propositions are not candidates. `id` fixes the id (job idempotency). If the LLM fails, the error
 * propagates and nothing is saved.
 */
export async function buildPriorReport(
  ctx: HubContext,
  input: { subjectId: string; propositionIds: string[]; excludeSourcePaths?: string[]; id?: string },
): Promise<PriorReport> {
  const { db } = ctx;
  const paths = input.excludeSourcePaths ?? [];
  const live = new Map((db.prepare("SELECT id, name, statement, provenance_json FROM lh_propositions WHERE deleted = 0").all() as PropRow[]).map((p) => [p.id, p]));
  const ids = [...new Set(input.propositionIds)].filter((id) => live.has(id));
  const importing = new Set(ids);
  const news = ids.map((id) => live.get(id)!);

  // Candidates: live propositions that belong neither to the import nor to its files.
  const sources = JSON.parse((db.prepare("SELECT value FROM meta WHERE key = ?").pluck().get(META_LH_FILE_SOURCES) as string | undefined) ?? "{}") as Record<string, string>;
  const excludedSrc = new Set(Object.entries(sources).filter(([, path]) => paths.includes(path)).map(([src]) => src));
  const isExcluded = (p: PropRow): boolean => (JSON.parse(p.provenance_json) as { chatId: string }[]).some((x) => excludedSrc.has(x.chatId));
  // in-memory token → propositions index, recomputed on every report (no new FTS).
  const index = new Map<string, string[]>();
  for (const p of live.values()) {
    if (importing.has(p.id) || isExcluded(p)) continue;
    for (const t of normalizedTokens(`${p.name} ${p.statement}`)) index.set(t, [...(index.get(t) ?? []), p.id]);
  }
  const candidatesOf = (p: PropRow): PropRow[] => {
    const score = new Map<string, number>();
    for (const t of normalizedTokens(`${p.name} ${p.statement}`)) for (const c of index.get(t) ?? []) score.set(c, (score.get(c) ?? 0) + 1);
    return [...score]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, MAX_CANDIDATES)
      .map(([id]) => live.get(id)!);
  };

  // Batch matching; the LLM is only asked about those that have candidates.
  const matches = new Map<string, Match>();
  const offered = new Map(news.map((p) => [p.id, candidatesOf(p)]).filter(([, c]) => (c as PropRow[]).length > 0) as [string, PropRow[]][]);
  const asked = news.filter((p) => offered.has(p.id));
  for (let i = 0; i < asked.length; i += BATCH_SIZE) {
    const batch = asked.slice(i, i + BATCH_SIZE);
    const prompt = loadPrompt("prior-match");
    const items = batch.map((p) => ({
      propositionId: p.id,
      name: p.name,
      statement: p.statement,
      candidates: offered.get(p.id)!.map((c) => ({ propositionId: c.id, name: c.name, statement: c.statement })),
    }));
    const res = await ctx.llm.complete({
      task: "prior-match",
      tier: "cheap",
      system: fillPrompt(prompt.text, { items: JSON.stringify(items, null, 2) }),
      messages: [{ role: "user", content: "Return only the requested JSON object, with no surrounding text." }],
      jsonSchema: MatchesSchema,
      promptVersion: prompt.version,
    });
    if (res.json === undefined) throw new Error("prior-match: the LLM returned no JSON");
    const inBatch = new Set(batch.map((p) => p.id));
    for (const m of res.json.matches) {
      if (!inBatch.has(m.propositionId) || matches.has(m.propositionId)) continue;
      const valid = m.relation !== "new" && m.matchedPropositionId !== null && offered.get(m.propositionId)!.some((c) => c.id === m.matchedPropositionId);
      matches.set(m.propositionId, valid ? { relation: m.relation, matchedId: m.matchedPropositionId } : { relation: "new", matchedId: null });
    }
  }

  // Active concept of each matched one, with its effective and stored state (undecayed), as in mastery.ts.
  const conceptOf = db
    .prepare(
      `SELECT c.id, c.name FROM concept_propositions cp
         JOIN concepts c ON c.id = cp.concept_id AND c.status = 'active'
       WHERE cp.proposition_id = ?`,
    );
  const concepts = new Map<string, { id: string; name: string } | undefined>();
  for (const m of matches.values()) if (m.matchedId && !concepts.has(m.matchedId)) concepts.set(m.matchedId, conceptOf.get(m.matchedId) as { id: string; name: string } | undefined);
  const conceptIds = [...new Set([...concepts.values()].flatMap((c) => (c ? [c.id] : [])))];
  const effective = stateViews(ctx, conceptIds);
  const stored = db.prepare("SELECT probability FROM concept_state WHERE concept_id = ?").pluck();
  const rawStateOf = (conceptId: string): ConceptState => {
    const p = stored.get(conceptId) as number | undefined;
    return p === undefined ? "unknown" : deriveState(p);
  };

  const items: PriorReportItem[] = news.map((p) => {
    const m = matches.get(p.id) ?? { relation: "new" as const, matchedId: null };
    const concept = m.matchedId ? concepts.get(m.matchedId) : undefined;
    const matched = concept ? { state: effective.get(concept.id)!.state, rawState: rawStateOf(concept.id) } : null;
    return {
      propositionId: p.id,
      name: p.name,
      bucket: priorBucket(m.relation, matched),
      relation: m.relation,
      matchedConceptId: concept?.id ?? null,
      matchedConceptName: concept?.name ?? null,
    };
  });

  const createdAt = isoNow(ctx.now());
  const summary = summarizePrior(items.map((i) => i.bucket));
  const report: PriorReport = { id: input.id ?? ulid(ctx.now().getTime()), subjectId: input.subjectId, paths, createdAt, ...summary, items };
  db.prepare("INSERT INTO prior_reports (id, subject_id, paths_json, data_json, created_at) VALUES (?, ?, ?, ?, ?)").run(
    report.id,
    report.subjectId,
    JSON.stringify(paths),
    JSON.stringify({ ...summary, items }),
    createdAt,
  );
  return report;
}

interface ReportRow {
  id: string;
  subject_id: string;
  paths_json: string;
  data_json: string;
  created_at: string;
}

function toReport(r: ReportRow): PriorReport {
  const data = JSON.parse(r.data_json) as Pick<PriorReport, "total" | "counts" | "percentages" | "items">;
  return { id: r.id, subjectId: r.subject_id, paths: JSON.parse(r.paths_json) as string[], createdAt: r.created_at, ...data };
}

/** GET /prior-reports: summaries (without items), from newest to oldest. */
export function listPriorReports(ctx: HubContext, q: PriorReportListQuery): { reports: PriorReportSummary[] } {
  const rows = ctx.db
    .prepare(`SELECT * FROM prior_reports ${q.subjectId ? "WHERE subject_id = ?" : ""} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(...(q.subjectId ? [q.subjectId, q.limit] : [q.limit])) as ReportRow[];
  return {
    reports: rows.map((r) => {
      const { items: _items, ...summary } = toReport(r);
      return summary;
    }),
  };
}

/** GET /prior-reports/:id (404 if it does not exist). */
export function getPriorReport(ctx: HubContext, id: string): PriorReport {
  const row = ctx.db.prepare("SELECT * FROM prior_reports WHERE id = ?").get(id) as ReportRow | undefined;
  if (!row) throw notFound();
  return toReport(row);
}

/** The latest report (of the subject, if given) or null. */
export function latestPriorReport(ctx: HubContext, subjectId?: string): PriorReport | null {
  const row = ctx.db
    .prepare(`SELECT * FROM prior_reports ${subjectId ? "WHERE subject_id = ?" : ""} ORDER BY created_at DESC, id DESC LIMIT 1`)
    .get(...(subjectId ? [subjectId] : [])) as ReportRow | undefined;
  return row ? toReport(row) : null;
}
