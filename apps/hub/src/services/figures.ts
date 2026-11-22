// Didactic TikZ figures (ADR 108): compile in a sandbox, persist PDF/SVG and the `figures` row.
import { isoNow, ulid } from "@graphharness/core";
import type { CompileTikzBody, CompileTikzResult, Figure, SaveFigureBody } from "@graphharness/contracts";
import { compileFragment } from "@graphharness/latex";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { badRequest, conflict, notFound } from "../errors.ts";
import type { HubContext } from "./context.ts";

interface FigureRow {
  id: string;
  concept_id: string | null;
  family: Figure["family"];
  mode: Figure["mode"];
  title: string | null;
  source_tikz: string;
  svg_path: string | null;
  pdf_path: string | null;
  libraries_json: string;
  created_by: Figure["createdBy"];
  created_at: string;
}

function rowToFigure(row: FigureRow): Figure {
  return {
    id: row.id,
    conceptId: row.concept_id,
    family: row.family,
    mode: row.mode,
    title: row.title,
    sourceTikz: row.source_tikz,
    svgPath: row.svg_path,
    pdfPath: row.pdf_path,
    libraries: JSON.parse(row.libraries_json) as string[],
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function compileFailed(result: { ok: false; log: string; timedOut?: boolean }): never {
  const extra = { log: result.log };
  if (result.timedOut) throw conflict("tikz_compile_failed", extra);
  throw badRequest("tikz_compile_failed", extra);
}

function fragmentOpts(ctx: HubContext, outDir: string) {
  return {
    outDir,
    timeoutSec: ctx.config.tikzCompileTimeoutSec,
    retries: ctx.config.tikzCompileMaxRetries,
  };
}

/** Compiles TikZ in `figuresDir/_tmp/<ulid>/` without persisting to the table. */
export async function compileTikz(ctx: HubContext, body: CompileTikzBody): Promise<CompileTikzResult> {
  const tmpId = ulid(ctx.now().getTime());
  const outDir = join(ctx.config.figuresDir, "_tmp", tmpId);
  mkdirSync(outDir, { recursive: true });
  const result = await compileFragment(body.tikz, fragmentOpts(ctx, outDir));
  return {
    ok: result.ok,
    log: result.log,
    pdfPath: result.ok ? result.pdfPath : undefined,
    svgPath: result.ok ? result.svgPath : undefined,
    timedOut: result.timedOut,
  };
}

/** Compiles, writes to `figuresDir/<id>/` and INSERTs into `figures`. */
export async function saveFigure(ctx: HubContext, body: SaveFigureBody): Promise<Figure> {
  if (body.conceptId !== undefined && !ctx.db.prepare("SELECT 1 FROM concepts WHERE id = ?").get(body.conceptId)) throw notFound();

  const id = ulid(ctx.now().getTime());
  const tmpDir = join(ctx.config.figuresDir, "_tmp", id);
  const permDir = join(ctx.config.figuresDir, id);
  mkdirSync(tmpDir, { recursive: true });

  const compiled = await compileFragment(body.tikz, fragmentOpts(ctx, tmpDir));
  if (!compiled.ok) {
    rmSync(tmpDir, { recursive: true, force: true });
    compileFailed({ ok: false, log: compiled.log, timedOut: compiled.timedOut });
  }

  mkdirSync(permDir, { recursive: true });
  const pdfPath = join(permDir, "figure.pdf");
  copyFileSync(compiled.pdfPath!, pdfPath);
  let svgPath: string | null = null;
  if (compiled.svgPath) {
    svgPath = join(permDir, "figure.svg");
    copyFileSync(compiled.svgPath, svgPath);
  }
  rmSync(tmpDir, { recursive: true, force: true });

  const createdAt = isoNow(ctx.now());
  ctx.db
    .prepare(
      `INSERT INTO figures (id, concept_id, family, mode, title, source_tikz, svg_path, pdf_path, libraries_json, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      body.conceptId ?? null,
      body.family,
      body.mode,
      body.title ?? null,
      body.tikz,
      svgPath,
      pdfPath,
      JSON.stringify(body.libraries),
      body.createdBy,
      createdAt,
    );

  return {
    id,
    conceptId: body.conceptId ?? null,
    family: body.family,
    mode: body.mode,
    title: body.title ?? null,
    sourceTikz: body.tikz,
    svgPath,
    pdfPath,
    libraries: body.libraries,
    createdBy: body.createdBy,
    createdAt,
  };
}

export function getFigure(ctx: HubContext, id: string): Figure {
  const row = ctx.db.prepare("SELECT * FROM figures WHERE id = ?").get(id) as FigureRow | undefined;
  if (!row) throw notFound();
  return rowToFigure(row);
}

export { listTemplates } from "./figure-templates.ts";
