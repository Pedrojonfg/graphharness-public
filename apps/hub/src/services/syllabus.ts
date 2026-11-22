// ADR 105 §6 (22): optional syllabus per subject. Stored as parsed text; "seen" is computed on read against the
// subject's active concepts (name + description + statements of their live propositions).
import { parseSyllabus, syllabusCoverage, ulid } from "@graphharness/core";
import type { PutSyllabusResponse, Syllabus } from "@graphharness/contracts";
import { HubError, notFound } from "../errors.ts";
import { stateViews } from "./concepts.ts";
import type { HubContext } from "./context.ts";

function requireSubject(ctx: HubContext, subjectId: string): void {
  if (!ctx.db.prepare("SELECT 1 FROM subjects WHERE id = ?").get(subjectId)) throw notFound();
}

/** PUT /syllabus/:subjectId and MCP `import_syllabus`: replaces the syllabus. With no valid topic → 400 and the previous one is untouched. */
export function putSyllabus(ctx: HubContext, subjectId: string, text: string): PutSyllabusResponse {
  requireSubject(ctx, subjectId);
  const { items, errors } = parseSyllabus(text);
  if (items.length === 0)
    throw new HubError(400, {
      error: "invalid_request",
      issues: [{ path: ["text"], message: errors[0] ?? "The syllabus has no topics." }],
    });
  const insert = ctx.db.prepare("INSERT INTO syllabus_items (id, subject_id, position, level, title) VALUES (?, ?, ?, ?, ?)");
  ctx.db.transaction(() => {
    ctx.db.prepare("DELETE FROM syllabus_items WHERE subject_id = ?").run(subjectId);
    for (const i of items) insert.run(ulid(ctx.now().getTime()), subjectId, i.position, i.level, i.title);
  })();
  return { count: items.length, errors };
}

/** GET /syllabus/:subjectId: each topic with seen/unseen, the concept that covers it and its effective state. */
export function getSyllabus(ctx: HubContext, subjectId: string): Syllabus {
  requireSubject(ctx, subjectId);
  const rows = ctx.db.prepare("SELECT id, position, level, title FROM syllabus_items WHERE subject_id = ? ORDER BY position").all(subjectId) as {
    id: string;
    position: number;
    level: number;
    title: string;
  }[];
  if (rows.length === 0) return { items: [] };
  const concepts = ctx.db.prepare("SELECT id, name, description FROM concepts WHERE subject_id = ? AND status = 'active'").all(subjectId) as {
    id: string;
    name: string;
    description: string;
  }[];
  const statements = new Map<string, string[]>();
  for (const r of ctx.db
    .prepare(
      `SELECT cp.concept_id, p.statement FROM concept_propositions cp JOIN lh_propositions p ON p.id = cp.proposition_id AND p.deleted = 0
       JOIN concepts c ON c.id = cp.concept_id WHERE c.subject_id = ? AND c.status = 'active'`,
    )
    .all(subjectId) as { concept_id: string; statement: string }[])
    statements.set(r.concept_id, [...(statements.get(r.concept_id) ?? []), r.statement]);
  const input = concepts.map((c) => ({ conceptId: c.id, name: c.name, description: c.description, statements: (statements.get(c.id) ?? []).join(" ") }));
  const names = new Map(concepts.map((c) => [c.id, c.name]));
  const covered = rows.map((r) => ({ row: r, cov: syllabusCoverage(r.title, input) }));
  const views = stateViews(ctx, [...new Set(covered.flatMap((c) => (c.cov.conceptId ? [c.cov.conceptId] : [])))]);
  return {
    items: covered.map(({ row, cov }) => {
      const view = cov.conceptId ? views.get(cov.conceptId)! : null;
      return {
        ...row,
        seen: cov.seen,
        conceptId: cov.conceptId,
        conceptName: cov.conceptId ? names.get(cov.conceptId)! : null,
        state: view?.state ?? null,
        stale: view?.stale ?? null,
      };
    }),
  };
}

/** MCP `get_syllabus_gaps`: the unseen topics, in order. */
export function syllabusGaps(ctx: HubContext, subjectId: string): { total: number; seen: number; unseen: { title: string; level: number }[] } {
  const { items } = getSyllabus(ctx, subjectId);
  return {
    total: items.length,
    seen: items.filter((i) => i.seen).length,
    unseen: items.filter((i) => !i.seen).map((i) => ({ title: i.title, level: i.level })),
  };
}
