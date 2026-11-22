// Resolve free text → concepts (FTS5 + `cheap` LLM rerank) and search (MCP `search_knowledge`).
import { fillPrompt, loadPrompt } from "@graphharness/llm";
import { z } from "zod";
import { stateViews } from "./concepts.ts";
import type { HubContext } from "./context.ts";
import { searchConceptsFts } from "./fts.ts";

const RerankSchema = z.object({
  scores: z.array(z.object({ conceptId: z.string(), score: z.number().min(0).max(1) })),
});

interface CandidateRow {
  id: string;
  name: string;
  description: string;
  subject: string | null;
}

const candidateQuery = `SELECT c.id, c.name, c.description, s.name AS subject FROM concepts c LEFT JOIN subjects s ON s.id = c.subject_id WHERE c.id = ?`;

/**
 * Without rerank (the LLM failed or returned garbage): score derived from the FTS order, always < 0.6 (0.5 for the first and
 * decreasing), so the agent asks the user (resolve-concepts rule).
 */
const FTS_ONLY_TOP_SCORE = 0.5;

export async function resolveConcepts(ctx: HubContext, input: { text: string; subjectId?: string; limit: number }) {
  const hits = searchConceptsFts(ctx.db, input.text, { subjectId: input.subjectId, limit: Math.min(40, input.limit * 3) });
  if (hits.length === 0) return { candidates: [] };
  const getRow = ctx.db.prepare(candidateQuery);
  const statements = ctx.db
    .prepare(
      `SELECT p.statement FROM concept_propositions cp JOIN lh_propositions p ON p.id = cp.proposition_id
       WHERE cp.concept_id = ? AND p.deleted = 0 ORDER BY p.id LIMIT 3`,
    )
    .pluck();
  const rows = hits.map((h) => getRow.get(h.conceptId) as CandidateRow);
  const prompt = loadPrompt("resolve-rerank");
  const candidates = rows.map((r) => ({ conceptId: r.id, name: r.name, subject: r.subject, description: r.description, examples: statements.all(r.id) }));
  let scores: z.infer<typeof RerankSchema>;
  try {
    const res = await ctx.llm.complete({
      task: "resolve-rerank",
      tier: "cheap",
      system: "You respond only with valid JSON.",
      messages: [{ role: "user", content: fillPrompt(prompt.text, { text: input.text, candidates: JSON.stringify(candidates, null, 1) }) }],
      jsonSchema: RerankSchema,
      promptVersion: prompt.version,
    });
    scores = res.json ?? RerankSchema.parse(JSON.parse(res.text));
  } catch (err) {
    console.error("[hub] resolve_concepts rerank failed; using the FTS order:", err);
    scores = { scores: rows.map((r, i) => ({ conceptId: r.id, score: FTS_ONLY_TOP_SCORE * (1 - i / rows.length) })) };
  }
  const scoreOf = new Map<string, number>();
  for (const s of scores.scores) if (!scoreOf.has(s.conceptId)) scoreOf.set(s.conceptId, s.score);
  const views = stateViews(ctx, rows.map((r) => r.id));
  // Order: LLM score; on a tie, FTS (bm25). A candidate the LLM does not score counts as 0.
  const ranked = rows
    .map((r, ftsOrder) => ({ r, ftsOrder, score: scoreOf.get(r.id) ?? 0 }))
    .sort((a, b) => b.score - a.score || a.ftsOrder - b.ftsOrder)
    .slice(0, input.limit);
  return {
    candidates: ranked.map(({ r, score }) => ({ conceptId: r.id, name: r.name, subject: r.subject, score, state: views.get(r.id)!.state })),
  };
}

/** Lower-cased and accent-free, to compare terms. */
const fold = (s: string): string => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

/**
 * MCP `search_knowledge`: concepts by FTS5 (name, description, statements) and live propositions that contain
 * query terms (propositions have no FTS index of their own; they are ordered by number of matching terms).
 */
export function searchKnowledge(ctx: HubContext, input: { query: string; subjectId?: string; limit: number }) {
  const hits = searchConceptsFts(ctx.db, input.query, { subjectId: input.subjectId, limit: input.limit });
  const getRow = ctx.db.prepare(candidateQuery);
  const rows = hits.map((h) => getRow.get(h.conceptId) as CandidateRow);
  const views = stateViews(ctx, rows.map((r) => r.id));
  const concepts = rows.map((r) => ({ conceptId: r.id, name: r.name, description: r.description, subject: r.subject, state: views.get(r.id)!.state }));

  const terms = [...new Set(fold(input.query).match(/[\p{L}\p{N}]{2,}/gu) ?? [])];
  // walks all live propositions in memory; for a single person that is a few thousand.
  const props = ctx.db
    .prepare(
      `SELECT p.id, p.name, p.statement, c.id AS concept_id, c.name AS concept_name
       FROM lh_propositions p
       LEFT JOIN concept_propositions cp ON cp.proposition_id = p.id
       LEFT JOIN concepts c ON c.id = cp.concept_id
       WHERE p.deleted = 0 AND (? IS NULL OR c.subject_id = ?)`,
    )
    .all(input.subjectId ?? null, input.subjectId ?? null) as { id: string; name: string; statement: string; concept_id: string | null; concept_name: string | null }[];
  const propositions = terms.length
    ? props
        .map((p) => {
          const hay = fold(`${p.name}\n${p.statement}`);
          return { p, n: terms.filter((t) => hay.includes(t)).length };
        })
        .filter((x) => x.n > 0)
        .sort((a, b) => b.n - a.n || (a.p.id < b.p.id ? -1 : 1))
        .slice(0, input.limit)
        .map(({ p }) => ({ propositionId: p.id, name: p.name, statement: p.statement, conceptId: p.concept_id, conceptName: p.concept_name }))
    : [];
  return { concepts, propositions };
}
