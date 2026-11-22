// Human-readable export of the knowledge base: one Markdown file per subject and per concept.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "@graphharness/db";
import { effectiveStates } from "./evidence.ts";

interface SubjectRow { id: string; name: string; slug: string; kind: string; course_notation: string | null }
interface ConceptRow { id: string; subject_id: string | null; name: string; description: string }
interface PropRow { name: string; statement: string }
interface TemplateRow { id: string; name: string; method_summary: string | null; method_limits: string | null; status: string }
interface ErrorRow { key: string; description: string; origin: string }

/** Stable slug: the normalised name + the last 6 characters of the id (the name may change, the id does not). */
export function stableSlug(name: string, id: string): string {
  const base = name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  return `${base || "unnamed"}-${id.slice(-6).toLowerCase()}`;
}

function walkMd(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkMd(p));
    else if (e.name.endsWith(".md")) out.push(p);
  }
  return out;
}

/** Writes `subjects/<slug>.md` and `concepts/<slug>.md` into `dir` and deletes the .md files that no longer apply. Returns how many it wrote. */
export function exportKnowledge(db: Db, dir: string, now: Date = new Date()): number {
  mkdirSync(join(dir, "subjects"), { recursive: true });
  mkdirSync(join(dir, "concepts"), { recursive: true });
  const files = new Map<string, string>();

  const subjects = db.prepare("SELECT id, name, slug, kind, course_notation FROM subjects ORDER BY name, id").all() as SubjectRow[];
  const concepts = db.prepare("SELECT id, subject_id, name, description FROM concepts WHERE status = 'active' ORDER BY name, id").all() as ConceptRow[];
  const states = effectiveStates(db, now, concepts.map((c) => c.id));
  const subjectOf = new Map(subjects.map((s) => [s.id, s]));
  const conceptSlug = (c: ConceptRow) => stableSlug(c.name, c.id);

  const props = db.prepare(
    `SELECT p.name, p.statement FROM concept_propositions cp JOIN lh_propositions p ON p.id = cp.proposition_id
     WHERE cp.concept_id = ? AND p.deleted = 0 ORDER BY p.name, p.id`,
  );
  const templates = db.prepare("SELECT id, name, method_summary, method_limits, status FROM templates WHERE concept_id = ? ORDER BY name, id");
  const errors = db.prepare("SELECT key, description, origin FROM template_errors WHERE template_id = ? ORDER BY key");

  for (const c of concepts) {
    const st = states.get(c.id);
    const s = c.subject_id ? subjectOf.get(c.subject_id) : undefined;
    const lines = [`# ${c.name}`, ""];
    if (s) lines.push(`Subject: [${s.name}](../subjects/${stableSlug(s.name, s.id)}.md)`, "");
    lines.push(
      `Effective state: **${st?.state ?? "unknown"}**${st?.probability != null ? ` (${Math.round(st.probability * 100)} %)` : ""}${st?.stale ? ", expired" : ""}`,
      "",
      c.description,
      "",
      "## Propositions",
      "",
    );
    const ps = props.all(c.id) as PropRow[];
    lines.push(...(ps.length ? ps.map((p) => `- **${p.name}**: ${p.statement}`) : ["(none)"]), "");
    for (const t of templates.all(c.id) as TemplateRow[]) {
      lines.push(`## Template: ${t.name}${t.status === "active" ? "" : ` (${t.status})`}`, "");
      lines.push("### Method sheet", "", t.method_summary ?? "(no summary)", "", "### Limits", "", t.method_limits ?? "(no limits)", "", "### Errors", "");
      const es = errors.all(t.id) as ErrorRow[];
      lines.push(...(es.length ? es.map((e) => `- \`${e.key}\` (${e.origin}): ${e.description}`) : ["(none)"]), "");
    }
    files.set(join(dir, "concepts", `${conceptSlug(c)}.md`), lines.join("\n"));
  }

  for (const s of subjects) {
    const mine = concepts.filter((c) => c.subject_id === s.id);
    const lines = [`# ${s.name}`, "", `Type: ${s.kind}`, ""];
    if (s.course_notation) lines.push(`Course notation: ${s.course_notation}`, "");
    lines.push("## Concepts", "");
    lines.push(
      ...(mine.length
        ? mine.map((c) => `- [${c.name}](../concepts/${conceptSlug(c)}.md): ${states.get(c.id)?.state ?? "unknown"}`)
        : ["(none)"]),
      "",
    );
    files.set(join(dir, "subjects", `${stableSlug(s.name, s.id)}.md`), lines.join("\n"));
  }

  for (const [path, text] of files) writeFileSync(path, text);
  for (const old of walkMd(dir)) if (!files.has(old)) rmSync(old);
  return files.size;
}
