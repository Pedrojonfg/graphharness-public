// L4 — import_material and import_class_notes (MCP): confinement to materialsDir and RELATIVE paths towards LH.
import { ImportClassNotesOutputSchema, ImportMaterialOutputSchema } from "@graphharness/contracts";
import type { ImportFile, ImportResult } from "@graphharness/lh-client";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { toErrorResponse } from "../../src/errors.ts";
import { sessionsTools } from "../../src/mcp/sessions.ts";
import { fakeLh, seedSubject } from "../../src/testing.ts";
import { world } from "../knowledge/helpers.ts";

let dir: string;
let outside: string;
let calls: ImportFile[][];

function setup(results?: (files: ImportFile[]) => ImportResult[]) {
  calls = [];
  const lh = fakeLh({
    async importFiles(files: ImportFile[]) {
      calls.push(files);
      return results ? results(files) : files.map((f, i) => ({ requestIndex: i, filePath: f.path, outcome: "completed" as const, ok: true, stats: { nodes: 2 } }));
    },
  });
  const w = world({ lh, config: { materialsDir: dir } });
  // ADR 103: each subject has its own subfolder of MATERIALS_DIR (lh_source_folder). Algebra → "algebra", Physics → "physics".
  const s = seedSubject(w.ctx.db, { name: "Linear Algebra", lhSourceFolder: "algebra" });
  const physics = seedSubject(w.ctx.db, { name: "Physics", lhSourceFolder: "physics" });
  return { ...w, s, physics };
}
const folderOf = (ctx: { db: any }, id: string): string | null => ctx.db.prepare("SELECT lh_source_folder FROM subjects WHERE id = ?").pluck().get(id);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gh-materials-"));
  outside = mkdtempSync(join(tmpdir(), "gh-outside-"));
  mkdirSync(join(dir, "algebra"), { recursive: true });
  writeFileSync(join(dir, "algebra", "topic3.md"), "# Topic 3\nEigenvalues.");
  mkdirSync(join(dir, "physics"), { recursive: true });
  writeFileSync(join(dir, "physics", "law.md"), "# Hooke's law");
  writeFileSync(join(outside, "secret.md"), "must not leak out");
});

describe("import_material", () => {
  it("path inside materialsDir → importFiles with a RELATIVE path and the file's content", async () => {
    const { ctx, s } = setup();
    const out = ImportMaterialOutputSchema.parse(await sessionsTools.import_material!(ctx, { subjectId: s, paths: [join(dir, "algebra", "topic3.md")] }));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(1);
    const f = calls[0]![0]!;
    expect(f.path).toBe("algebra/topic3.md");
    expect(f.filename).toBe("topic3.md");
    expect(Buffer.from(f.content as string | Uint8Array).toString("utf8")).toBe("# Topic 3\nEigenvalues.");
    expect(out.results).toHaveLength(1);
    expect(out.results[0]).toMatchObject({ ok: true, outcome: "completed", error: null, code: null, notice: null });
    expect(out.results[0]!.path.endsWith("algebra/topic3.md")).toBe(true);
  });

  it("path outside materialsDir → 400 error and LH is NOT called (also with a deceptive prefix and with ..)", async () => {
    const { ctx, s } = setup();
    for (const p of [join(outside, "secret.md"), "/etc/passwd", `${dir}-evil/x.md`, `${dir}/../${outside.split("/").at(-1)}/secret.md`]) {
      await expect((async () => sessionsTools.import_material!(ctx, { subjectId: s, paths: [p] }))(), p).rejects.toSatisfy((e) => toErrorResponse(e).status === 400);
    }
    // a single bad path is enough to reject the whole batch
    await expect((async () => sessionsTools.import_material!(ctx, { subjectId: s, paths: [join(dir, "algebra", "topic3.md"), join(outside, "secret.md")] }))()).rejects.toSatisfy((e) => toErrorResponse(e).status === 400);
    expect(calls).toEqual([]);
  });

  it("ADR 103: path of ANOTHER subject (or of the materials root) → 400 and LH is NOT called", async () => {
    writeFileSync(join(dir, "loose.md"), "# at the root, without a subject");
    const { ctx, s } = setup();
    for (const p of [join(dir, "physics", "law.md"), join(dir, "loose.md"), `${dir}/algebra/../physics/law.md`, join(dir, "algebra-other", "x.md")]) {
      await expect((async () => sessionsTools.import_material!(ctx, { subjectId: s, paths: [p] }))(), p).rejects.toSatisfy((e) => toErrorResponse(e).status === 400);
    }
    // a batch with a path of another subject is rejected entirely
    await expect(sessionsTools.import_material!(ctx, { subjectId: s, paths: [join(dir, "algebra", "topic3.md"), join(dir, "physics", "law.md")] })).rejects.toSatisfy((e) => toErrorResponse(e).status === 400);
    expect(calls).toEqual([]);
  });

  it("ADR 103: each subject imports under ITS folder (the path to LH is <folder>/…)", async () => {
    const { ctx, physics } = setup();
    await sessionsTools.import_material!(ctx, { subjectId: physics, paths: [join(dir, "physics", "law.md")] });
    expect(calls[0]![0]!.path).toBe("physics/law.md");
  });

  it("ADR 103: a nested subfolder of the subject is valid and is kept in the relative path", async () => {
    mkdirSync(join(dir, "algebra", "midterm"), { recursive: true });
    writeFileSync(join(dir, "algebra", "midterm", "p1.md"), "# P1");
    const { ctx, s } = setup();
    await sessionsTools.import_material!(ctx, { subjectId: s, paths: [join(dir, "algebra", "midterm", "p1.md")] });
    expect(calls[0]![0]!.path).toBe("algebra/midterm/p1.md");
  });

  it("ADR 103: subject without lh_source_folder → on import it keeps its slug, and the valid folder is <slug>/", async () => {
    const { ctx } = setup();
    const id = seedSubject(ctx.db, { name: "Numerical Calculus" }); // without lhSourceFolder
    const slug = ctx.db.prepare("SELECT slug FROM subjects WHERE id = ?").pluck().get(id) as string;
    expect(folderOf(ctx, id)).toBeNull();
    mkdirSync(join(dir, slug));
    writeFileSync(join(dir, slug, "t1.md"), "# T1");
    // outside <slug>/ → 400
    await expect(sessionsTools.import_material!(ctx, { subjectId: id, paths: [join(dir, "algebra", "topic3.md")] })).rejects.toSatisfy((e) => toErrorResponse(e).status === 400);
    await sessionsTools.import_material!(ctx, { subjectId: id, paths: [join(dir, slug, "t1.md")] });
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]!.path).toBe(`${slug}/t1.md`);
    expect(folderOf(ctx, id)).toBe(slug);
  });

  it("LH rejections (models_not_configured, image-only PDF notice) arrive in the result, not as an exception", async () => {
    writeFileSync(join(dir, "algebra", "sheet1.pdf"), "%PDF-1.4 fake");
    const { ctx, s } = setup((files) => [
      { requestIndex: 0, filePath: files[0]!.path, outcome: "failed", ok: false, error: "No model configured", code: "models_not_configured", missing: ["strong"] },
      { requestIndex: 1, filePath: files[1]!.path, outcome: "completed", ok: true, notice: "Skipped 2 image-only pages; OCR is not supported." },
    ]);
    const out = ImportMaterialOutputSchema.parse(
      await sessionsTools.import_material!(ctx, { subjectId: s, paths: [join(dir, "algebra", "topic3.md"), join(dir, "algebra", "sheet1.pdf")] }),
    );
    expect(out.results[0]).toMatchObject({ ok: false, outcome: "failed", code: "models_not_configured", error: "No model configured" });
    expect(out.results[1]).toMatchObject({ ok: true, notice: expect.stringContaining("OCR") });
  });

  it("non-existent subject → 404 without calling LH", async () => {
    const { ctx } = setup();
    await expect(sessionsTools.import_material!(ctx, { subjectId: "nope", paths: [join(dir, "algebra", "topic3.md")] })).rejects.toMatchObject({ status: 404 });
    expect(calls).toEqual([]);
  });
});

describe("import_class_notes", () => {
  it("ADR 103: writes <folder>/agent-notes/YYYY-MM-DD-slug.md and imports with that relative path", async () => {
    const { ctx, s } = setup();
    const markdown = "# Diagonalization\n- $A = PDP^{-1}$";
    const out = ImportClassNotesOutputSchema.parse(await sessionsTools.import_class_notes!(ctx, { subjectId: s, title: "Diagonalization — class 3", markdown }));
    const files = readdirSync(join(dir, "algebra", "agent-notes"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^2026-11-10-[a-z0-9]+(-[a-z0-9]+)*\.md$/);
    expect(out.path).toBe(join(dir, "algebra", "agent-notes", files[0]!));
    expect(readFileSync(out.path, "utf8")).toContain(markdown);
    expect(existsSync(join(dir, "agent-notes"))).toBe(false); // there is no flat path any more
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]!.path).toBe(`algebra/agent-notes/${files[0]}`);
    expect(calls[0]![0]!.filename).toBe(files[0]);
    expect(out.result).toMatchObject({ ok: true, outcome: "completed", error: null, code: null });
  });

  it("ADR 103: the notes of another subject go to ITS folder", async () => {
    const { ctx, physics } = setup();
    await sessionsTools.import_class_notes!(ctx, { subjectId: physics, title: "Hooke", markdown: "# Hooke" });
    expect(readdirSync(join(dir, "physics", "agent-notes"))).toHaveLength(1);
    expect(existsSync(join(dir, "algebra", "agent-notes"))).toBe(false);
    expect(calls[0]![0]!.path).toMatch(/^physics\/agent-notes\/2026-11-10-/);
  });

  it("ADR 103: subject without lh_source_folder → the notes go to <slug>/agent-notes/ and it keeps its slug", async () => {
    const { ctx } = setup();
    const id = seedSubject(ctx.db, { name: "Statistics" });
    const slug = ctx.db.prepare("SELECT slug FROM subjects WHERE id = ?").pluck().get(id) as string;
    const out = ImportClassNotesOutputSchema.parse(await sessionsTools.import_class_notes!(ctx, { subjectId: id, title: "Mean", markdown: "# Mean" }));
    expect(out.path.startsWith(join(dir, slug, "agent-notes") + "/")).toBe(true);
    expect(existsSync(out.path)).toBe(true);
    expect(calls[0]![0]!.path).toMatch(new RegExp(`^${slug}/agent-notes/2026-11-10-`));
    expect(folderOf(ctx, id)).toBe(slug);
  });

  it("a title with ../ does not escape <folder>/agent-notes/", async () => {
    const { ctx, s } = setup();
    const out = ImportClassNotesOutputSchema.parse(await sessionsTools.import_class_notes!(ctx, { subjectId: s, title: "../../evil /x", markdown: "# hello" }));
    expect(out.path.startsWith(join(dir, "algebra", "agent-notes") + "/")).toBe(true);
    expect(existsSync(out.path)).toBe(true);
    expect(readdirSync(dir).sort()).toEqual(["algebra", "physics"]);
    expect(readdirSync(join(dir, "algebra")).sort()).toEqual(["agent-notes", "topic3.md"]);
    expect(calls[0]![0]!.path).not.toContain("..");
  });

  it("non-existent subject → 404 and nothing is written", async () => {
    const { ctx } = setup();
    await expect(sessionsTools.import_class_notes!(ctx, { subjectId: "nope", title: "T", markdown: "# x" })).rejects.toMatchObject({ status: 404 });
    expect(existsSync(join(dir, "agent-notes"))).toBe(false);
    expect(existsSync(join(dir, "algebra", "agent-notes"))).toBe(false);
    expect(calls).toEqual([]);
  });
});
