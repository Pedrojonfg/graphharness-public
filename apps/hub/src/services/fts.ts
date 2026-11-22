// FTS5 index of concepts (concept_fts, updated after each concept change; used by resolve_concepts).
import type { Db } from "@graphharness/db";

export function refreshConceptFts(db: Db, conceptId: string): void {
  const c = db.prepare("SELECT name, description, status FROM concepts WHERE id = ?").get(conceptId) as
    | { name: string; description: string; status: string }
    | undefined;
  db.prepare("DELETE FROM concept_fts WHERE concept_id = ?").run(conceptId);
  if (!c || c.status !== "active") return;
  const statements = (
    db
      .prepare(
        `SELECT p.statement FROM concept_propositions cp JOIN lh_propositions p ON p.id = cp.proposition_id
         WHERE cp.concept_id = ? AND p.deleted = 0 ORDER BY p.id`,
      )
      .pluck()
      .all(conceptId) as string[]
  ).join("\n");
  db.prepare("INSERT INTO concept_fts (concept_id, name, description, statements) VALUES (?, ?, ?, ?)").run(
    conceptId,
    c.name,
    c.description,
    statements,
  );
}

/** Turns free text into a safe FTS5 query (OR of quoted terms). */
export function ftsQuery(text: string): string | null {
  const terms = text
    .normalize("NFKC")
    .toLowerCase()
    .match(/[\p{L}\p{N}]{2,}/gu);
  if (!terms?.length) return null;
  return [...new Set(terms)].map((t) => `"${t}"`).join(" OR ");
}

/** FTS5 candidates with bm25 (lower = better). */
export function searchConceptsFts(db: Db, text: string, opts: { subjectId?: string; limit?: number } = {}): { conceptId: string; rank: number }[] {
  const q = ftsQuery(text);
  if (!q) return [];
  return db
    .prepare(
      `SELECT f.concept_id AS conceptId, bm25(concept_fts, 0, 3.0, 1.5, 1.0) AS rank
       FROM concept_fts f JOIN concepts c ON c.id = f.concept_id
       WHERE concept_fts MATCH ? AND (? IS NULL OR c.subject_id = ?)
       ORDER BY rank LIMIT ?`,
    )
    .all(q, opts.subjectId ?? null, opts.subjectId ?? null, opts.limit ?? 20) as { conceptId: string; rank: number }[];
}
