// Subjects and Map (`subjects`, `/subjects`, Map page; MCP `create_subject`, `get_subject_overview`).
import { isoNow, ulid } from "@graphharness/core";
import type { CreateSubjectBody, PatchSubjectBody, Subject, SubjectMap } from "@graphharness/contracts";
import type { Db } from "@graphharness/db";
import { conflict, notFound } from "../errors.ts";
import { examViews, recurringErrorRows, type ExamRow } from "./brief.ts";
import { stateViews } from "./concepts.ts";
import type { HubContext } from "./context.ts";

interface SubjectRow {
  id: string;
  name: string;
  slug: string;
  kind: "computable_math" | "general";
  course_notation: string | null;
  lh_source_folder: string | null;
  created_at: string;
  archived_at: string | null;
}

export const toSubject = (r: SubjectRow): Subject => ({
  id: r.id,
  name: r.name,
  slug: r.slug,
  kind: r.kind,
  courseNotation: r.course_notation,
  lhSourceFolder: r.lh_source_folder,
  createdAt: r.created_at,
  archivedAt: r.archived_at,
});

/** "Linear Algebra II" → "linear-algebra-ii"; accents are stripped. No letters or digits → "subject". */
export function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "subject";
}

export function getSubjectRow(db: Db, id: string): SubjectRow {
  const row = db.prepare("SELECT * FROM subjects WHERE id = ?").get(id) as SubjectRow | undefined;
  if (!row) throw notFound();
  return row;
}

export function listSubjects(ctx: HubContext): Subject[] {
  return (ctx.db.prepare("SELECT * FROM subjects ORDER BY name, id").all() as SubjectRow[]).map(toSubject);
}

function assertSlugFree(db: Db, slug: string, exceptId: string | null): void {
  const other = db.prepare("SELECT id FROM subjects WHERE slug = ? AND id IS NOT ?").pluck().get(slug, exceptId);
  if (other) throw conflict("slug_taken", { message: `A subject with the identifier "${slug}" already exists.` });
}

export function createSubject(ctx: HubContext, body: Omit<CreateSubjectBody, "kind"> & { kind?: CreateSubjectBody["kind"] }): Subject {
  const slug = slugify(body.name);
  const id = ulid(ctx.now().getTime());
  ctx.db.transaction(() => {
    assertSlugFree(ctx.db, slug, null);
    ctx.db
      .prepare("INSERT INTO subjects (id, name, slug, kind, course_notation, lh_source_folder, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, body.name, slug, body.kind ?? "general", body.courseNotation ?? null, body.lhSourceFolder ?? null, isoNow(ctx.now()));
  })();
  return toSubject(getSubjectRow(ctx.db, id));
}

/** Renaming re-derives the slug (409 `slug_taken` if it collides with another). */
export function patchSubject(ctx: HubContext, id: string, body: PatchSubjectBody): Subject {
  ctx.db.transaction(() => {
    const row = getSubjectRow(ctx.db, id);
    const name = body.name ?? row.name;
    const slug = body.name !== undefined ? slugify(body.name) : row.slug;
    if (slug !== row.slug) assertSlugFree(ctx.db, slug, id);
    const archivedAt = body.archived === undefined ? row.archived_at : body.archived ? (row.archived_at ?? isoNow(ctx.now())) : null;
    ctx.db
      .prepare("UPDATE subjects SET name = ?, slug = ?, kind = ?, course_notation = ?, lh_source_folder = ?, archived_at = ? WHERE id = ?")
      .run(
        name,
        slug,
        body.kind ?? row.kind,
        body.courseNotation === undefined ? row.course_notation : body.courseNotation,
        body.lhSourceFolder === undefined ? row.lh_source_folder : body.lhSourceFolder,
        archivedAt,
        id,
      );
  })();
  return toSubject(getSubjectRow(ctx.db, id));
}

interface MapConceptRow {
  id: string;
  name: string;
  description: string;
  computable: number;
  optional: number;
  template_count: number;
  proposition_count: number;
}

interface EdgeRow {
  from_concept: string;
  to_concept: string;
  relation: "requires" | "illustrates";
  confidence: "high" | "medium" | "low";
  chain_support: number;
  source: "derived" | "curator" | "manual";
  justification: string | null;
}

export const toEdge = (e: EdgeRow) => ({
  from: e.from_concept,
  to: e.to_concept,
  relation: e.relation,
  confidence: e.confidence,
  chainSupport: e.chain_support,
  source: e.source,
  justification: e.justification,
});

/** GET /subjects/:id/map: active concepts with their effective state + non-removed edges between them. */
export function subjectMap(ctx: HubContext, id: string): SubjectMap {
  const subject = toSubject(getSubjectRow(ctx.db, id));
  const rows = ctx.db
    .prepare(
      `SELECT c.id, c.name, c.description, c.computable, c.optional,
         (SELECT count(*) FROM templates t WHERE t.concept_id = c.id AND t.status = 'active') AS template_count,
         (SELECT count(*) FROM concept_propositions cp JOIN lh_propositions p ON p.id = cp.proposition_id
            WHERE cp.concept_id = c.id AND p.deleted = 0) AS proposition_count
       FROM concepts c WHERE c.subject_id = ? AND c.status = 'active' ORDER BY c.name, c.id`,
    )
    .all(id) as MapConceptRow[];
  const views = stateViews(ctx, rows.map((r) => r.id));
  const edges = ctx.db
    .prepare(
      `SELECT e.* FROM concept_edges e
       JOIN concepts a ON a.id = e.from_concept AND a.subject_id = ? AND a.status = 'active'
       JOIN concepts b ON b.id = e.to_concept AND b.subject_id = ? AND b.status = 'active'
       WHERE e.removed = 0 ORDER BY e.from_concept, e.to_concept`,
    )
    .all(id, id) as EdgeRow[];
  return {
    subject,
    concepts: rows.map((r) => {
      const v = views.get(r.id)!;
      return {
        id: r.id,
        name: r.name,
        description: r.description,
        computable: r.computable === 1,
        optional: r.optional === 1,
        state: v.state,
        probability: v.probability,
        stale: v.stale,
        manualConfirmation: v.manualConfirmation,
        templateCount: r.template_count,
        propositionCount: r.proposition_count,
      };
    }),
    edges: edges.map(toEdge),
  };
}

/** MCP `get_subject_overview`: concepts by state, exams from today onwards and recurring errors. */
export function subjectOverview(ctx: HubContext, id: string) {
  const subject = toSubject(getSubjectRow(ctx.db, id));
  const concepts = ctx.db
    .prepare("SELECT id, name FROM concepts WHERE subject_id = ? AND status = 'active' ORDER BY name, id")
    .all(id) as { id: string; name: string }[];
  const views = stateViews(ctx, concepts.map((c) => c.id));
  const byState = { solid: [], review: [], weak: [], unknown: [] } as Record<
    "solid" | "review" | "weak" | "unknown",
    { conceptId: string; name: string; probability: number | null; stale: boolean; manualConfirmation: "pending" | "confirmed" | null }[]
  >;
  for (const c of concepts) {
    const v = views.get(c.id)!;
    byState[v.state].push({ conceptId: c.id, name: c.name, probability: v.probability, stale: v.stale, manualConfirmation: v.manualConfirmation });
  }
  const today = isoNow(ctx.now()).slice(0, 10);
  const exams = examViews(ctx, ctx.db.prepare("SELECT * FROM exams WHERE subject_id = ? AND date >= ? ORDER BY date, id").all(id, today) as ExamRow[], ctx.now());
  const recurringErrors = recurringErrorRows(ctx.db, { subjectId: id, minTimesSeen: 1, limit: 10 }).map((r) => ({
    templateId: r.templateId,
    template: r.templateName,
    errorKey: r.key,
    error: r.description,
    timesSeen: r.timesSeen,
  }));
  return { subject, conceptsByState: byState, exams, recurringErrors };
}
