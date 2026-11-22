// University material and class notes: files from MATERIALS_DIR → LH import.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ImportFileResult, MaterialsList } from "@graphharness/contracts";
import { isoNow } from "@graphharness/core";
import type { ImportResult } from "@graphharness/lh-client";
import type { Db } from "@graphharness/db";
import { HubError, notFound } from "../errors.ts";
import type { HubContext } from "./context.ts";
import { enqueueJob } from "./jobs.ts";

export interface MaterialFile {
  /** Absolute path as received. */
  absolute: string;
  /** Path relative to the materials folder, with "/" (the source's identity in LH, which rejects absolute paths). */
  relative: string;
}

const invalid = (field: (string | number)[], message: string): HubError =>
  new HubError(400, { error: "invalid_request", issues: [{ path: field, message }] });

/**
 * Validates that `path` is a file INSIDE `materialsDir/<folder>/` (the subject's folder, ADR 103): both
 * the path as given (no escaping `..`) and its real target (symlinks resolved). Otherwise, 400 invalid_request.
 * `relative` stays relative to `materialsDir`, so it starts with `<folder>/`.
 */
export function resolveMaterialPath(materialsDir: string, folder: string, path: string, field: (string | number)[] = ["path"]): MaterialFile {
  const root = resolve(materialsDir);
  const subRoot = resolve(root, folder);
  const abs = resolve(path);
  const inside = (base: string, p: string) => {
    const rel = relative(base, p);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  };
  if (!inside(root, subRoot)) throw invalid(field, "The subject's folder is not inside the materials folder.");
  if (!isAbsolute(path) || !inside(subRoot, abs))
    throw invalid(field, `The path is not inside the subject's materials folder (${relative(root, subRoot).split(sep).join("/")}/).`);
  let real: string;
  let realRoot: string;
  let realSubRoot: string;
  try {
    real = realpathSync(abs);
    realRoot = realpathSync(root);
    realSubRoot = realpathSync(subRoot);
  } catch {
    throw invalid(field, "The file does not exist.");
  }
  if (!real.startsWith(realRoot + sep) || !real.startsWith(realSubRoot + sep)) throw invalid(field, "The path points outside the subject's materials folder.");
  if (!statSync(real).isFile()) throw invalid(field, "The path is not a file.");
  return { absolute: path, relative: relative(root, abs).split(sep).join("/") };
}

/**
 * The subject's materials folder (ADR 103): `lh_source_folder`, or its slug if it has none (and it is saved). 404 if it does not exist.
 * No leading or trailing slashes.
 */
export function subjectMaterialsFolder(db: Db, subjectId: string): string {
  const row = db.prepare("SELECT slug, lh_source_folder FROM subjects WHERE id = ?").get(subjectId) as { slug: string; lh_source_folder: string | null } | undefined;
  if (!row) throw notFound();
  const folder = row.lh_source_folder?.replace(/^\/+|\/+$/g, "");
  if (folder) return folder;
  db.prepare("UPDATE subjects SET lh_source_folder = ? WHERE id = ?").run(row.slug, subjectId);
  return row.slug;
}

const toFileResult = (path: string, r: ImportResult): ImportFileResult => ({
  path,
  ok: r.ok,
  outcome: r.outcome,
  error: r.error ?? null,
  code: r.code ?? null,
  notice: r.notice ?? null,
});

async function importToLh(ctx: HubContext, files: MaterialFile[]): Promise<ImportFileResult[]> {
  const results = await ctx.lh.importFiles(
    files.map((f) => ({ path: f.relative, filename: f.relative.split("/").at(-1)!, content: new Uint8Array(readFileSync(f.absolute)) })),
  );
  return results.map((r, i) => toFileResult(files[i]!.absolute, r));
}

/** ADR 105 §6 (19): enqueues the prior-knowledge report with the successfully imported paths (`partial` ones count). */
function enqueuePriorReport(ctx: HubContext, subjectId: string, files: MaterialFile[], results: ImportFileResult[]): void {
  const paths = files.filter((_, i) => results[i]?.ok).map((f) => f.relative);
  if (paths.length > 0) enqueueJob(ctx.db, "prior-report", { subjectId, paths, startedAt: isoNow(ctx.now()) }, { now: ctx.now() });
}

/** GET /materials/:subjectId — files under the subject's folder (relative to MATERIALS_DIR). */
export function listMaterials(ctx: HubContext, subjectId: string): MaterialsList {
  const folder = subjectMaterialsFolder(ctx.db, subjectId);
  const root = resolve(ctx.config.materialsDir);
  const dir = join(root, folder);
  if (!existsSync(dir)) return { files: [] };
  const files: MaterialsList["files"] = [];
  const walk = (d: string) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile()) files.push({ relative: relative(root, p).split(sep).join("/"), name: basename(p) });
    }
  };
  walk(dir);
  files.sort((a, b) => a.relative.localeCompare(b.relative));
  return { files };
}

/** MCP `import_material`: PDFs/MD from the materials folder → LH. Image-only pages are flagged by LH in `notice`. */
export async function importMaterial(ctx: HubContext, input: { subjectId: string; paths: string[] }): Promise<{ results: ImportFileResult[] }> {
  const folder = subjectMaterialsFolder(ctx.db, input.subjectId);
  const files = input.paths.map((p, i) => resolveMaterialPath(ctx.config.materialsDir, folder, p, ["paths", i]));
  const results = await importToLh(ctx, files);
  enqueuePriorReport(ctx, input.subjectId, files, results);
  return { results };
}

/** "Diagonalisation: examples" → "diagonalisation-examples". */
export function slugify(text: string): string {
  const slug = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
  return slug || "notes";
}

/**
 * MCP `import_class_notes` (ADR 103): writes `<materials>/<subject-folder>/agent-notes/YYYY-MM-DD-slug.md`
 * and imports it into LH with the relative path `<subject-folder>/agent-notes/…`.
 * If that file already exists with different content, it is not overwritten: `-2`, `-3`… is used; with identical content it is re-imported.
 */
export async function importClassNotes(
  ctx: HubContext,
  input: { subjectId: string; title: string; markdown: string },
): Promise<{ path: string; result: ImportFileResult }> {
  const folder = subjectMaterialsFolder(ctx.db, input.subjectId);
  const dir = join(resolve(ctx.config.materialsDir), folder, "agent-notes");
  mkdirSync(dir, { recursive: true });
  const base = `${ctx.now().toISOString().slice(0, 10)}-${slugify(input.title)}`;
  let path = join(dir, `${base}.md`);
  for (let n = 2; existsSync(path) && readFileSync(path, "utf8") !== input.markdown; n++) path = join(dir, `${base}-${n}.md`);
  writeFileSync(path, input.markdown, "utf8");
  const files = [resolveMaterialPath(ctx.config.materialsDir, folder, path)];
  const results = await importToLh(ctx, files);
  enqueuePriorReport(ctx, input.subjectId, files, results);
  return { path, result: results[0]! };
}
