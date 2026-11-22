// edges-derive (no LLM): prerequisite edges derived from the live LH chains.
import { deriveEdges } from "@graphharness/core";
import type { HubContext } from "@graphharness/hub/services/context";

interface EdgeRow {
  from_concept: string;
  to_concept: string;
  source: "derived" | "curator" | "manual";
  removed: number;
}

export async function runEdgesDerive(ctx: HubContext): Promise<{ edges: number; removedForCycles: number }> {
  const { db } = ctx;
  const chains = (db.prepare("SELECT id, premises_json, conclusion FROM lh_chains WHERE deleted = 0 ORDER BY id").all() as {
    id: string;
    premises_json: string;
    conclusion: string;
  }[]).map((c) => ({ id: c.id, premises: JSON.parse(c.premises_json) as string[], conclusion: c.conclusion }));
  // Only live propositions in active concepts.
  const conceptOf = new Map(
    (
      db
        .prepare(
          `SELECT cp.proposition_id AS p, cp.concept_id AS c FROM concept_propositions cp
           JOIN lh_propositions lp ON lp.id = cp.proposition_id JOIN concepts k ON k.id = cp.concept_id
           WHERE lp.deleted = 0 AND k.status = 'active'`,
        )
        .all() as { p: string; c: string }[]
    ).map((r) => [r.p, r.c]),
  );
  const existing = db.prepare("SELECT from_concept, to_concept, source, removed FROM concept_edges").all() as EdgeRow[];
  const key = (from: string, to: string) => `${from}->${to}`;
  // Fixed (the job does not touch them): manual, or removed by hand.
  const fixed = existing.filter((e) => e.source === "manual" || e.removed === 1);
  const fixedKeys = new Set(fixed.map((e) => key(e.from_concept, e.to_concept)));

  const { edges, removedForCycles } = deriveEdges({
    chains,
    conceptOf: (id) => conceptOf.get(id),
    fixed: fixed.map((e) => ({ from: e.from_concept, to: e.to_concept })),
  });
  for (const e of removedForCycles)
    console.warn(`[edges-derive] cycle: removing derived edge ${e.from} → ${e.to} (support ${e.chainSupport})`);

  return db.transaction(() => {
    const upsert = db.prepare(
      `INSERT INTO concept_edges (from_concept, to_concept, relation, confidence, chain_support, source) VALUES (?, ?, 'requires', ?, ?, 'derived')
       ON CONFLICT(from_concept, to_concept) DO UPDATE SET relation = 'requires', confidence = excluded.confidence,
         chain_support = excluded.chain_support, source = 'derived'`,
    );
    const written = new Set<string>();
    for (const e of edges) {
      if (fixedKeys.has(key(e.from, e.to))) continue;
      upsert.run(e.from, e.to, e.confidence, e.chainSupport);
      written.add(key(e.from, e.to));
    }
    // Derived edges that no longer have support (or were dropped by a cycle) are removed. Curator edges without support stay at 'low'.
    const del = db.prepare("DELETE FROM concept_edges WHERE from_concept = ? AND to_concept = ? AND source = 'derived' AND removed = 0");
    for (const e of existing)
      if (e.source === "derived" && e.removed === 0 && !written.has(key(e.from_concept, e.to_concept))) del.run(e.from_concept, e.to_concept);
    return { edges: written.size, removedForCycles: removedForCycles.length };
  })();
}
