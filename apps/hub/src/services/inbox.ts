// PWA inbox (concepts without live propositions; ADR 102 §12): GET /inbox.
import type { Inbox } from "@graphharness/contracts";
import { listSuggestions } from "./concepts.ts";
import type { HubContext } from "./context.ts";

/** `validation_json` is eval's /v1/recipes/validate response: `problems` (text). */
function problemsOf(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as { problems?: unknown };
    return Array.isArray(v.problems) ? v.problems.map((p) => (typeof p === "string" ? p : JSON.stringify(p))) : [];
  } catch {
    return [raw]; // if it is not JSON, it is shown as is
  }
}

function hypothesisOf(raw: string | null): Inbox["unknownErrors"][number]["hypothesis"] {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    return typeof v.key === "string" && typeof v.description === "string" && typeof v.expr === "string"
      ? { key: v.key, description: v.description, expr: v.expr }
      : null;
  } catch {
    return null; // unreadable hypothesis = no hypothesis
  }
}

export function inbox(ctx: HubContext): Inbox {
  const db = ctx.db;
  const liveCount = `(SELECT count(*) FROM concept_propositions cp JOIN lh_propositions p ON p.id = cp.proposition_id
                      WHERE cp.concept_id = c.id AND p.deleted = 0)`;
  const unassignedConcepts = db
    .prepare(`SELECT c.id AS conceptId, c.name, c.description, ${liveCount} AS propositionCount FROM concepts c
              WHERE c.status = 'active' AND c.subject_id IS NULL ORDER BY c.created_at, c.id`)
    .all() as Inbox["unassignedConcepts"];
  const failedTemplates = (
    db
      .prepare(
        `SELECT t.id, t.concept_id, c.name AS concept_name, t.validation_json, t.created_at FROM templates t JOIN concepts c ON c.id = t.concept_id
         WHERE t.status = 'failed' AND c.status = 'active' ORDER BY t.created_at DESC, t.id`,
      )
      .all() as { id: string; concept_id: string; concept_name: string; validation_json: string | null; created_at: string }[]
  ).map((t) => ({ templateId: t.id, conceptId: t.concept_id, conceptName: t.concept_name, problems: problemsOf(t.validation_json), createdAt: t.created_at }));
  const unknownErrors = (
    db
      .prepare(
        `SELECT u.id, u.template_id, t.name AS template_name, c.name AS concept_name, u.hypothesis_json, u.status, u.created_at
         FROM unknown_errors u JOIN templates t ON t.id = u.template_id JOIN concepts c ON c.id = t.concept_id
         WHERE u.status IN ('open','rejected') ORDER BY u.created_at DESC, u.id`,
      )
      .all() as {
      id: string;
      template_id: string;
      template_name: string;
      concept_name: string;
      hypothesis_json: string | null;
      status: "open" | "rejected";
      created_at: string;
    }[]
  ).map((u) => ({
    id: u.id,
    templateId: u.template_id,
    templateName: u.template_name,
    conceptName: u.concept_name,
    hypothesis: hypothesisOf(u.hypothesis_json),
    status: u.status,
    createdAt: u.created_at,
  }));
  const orphanConcepts = db
    .prepare(`SELECT c.id AS conceptId, c.name FROM concepts c WHERE c.status = 'active' AND ${liveCount} = 0 ORDER BY c.name, c.id`)
    .all() as Inbox["orphanConcepts"];
  return { unassignedConcepts, suggestions: listSuggestions(ctx, "open"), failedTemplates, unknownErrors, orphanConcepts };
}
