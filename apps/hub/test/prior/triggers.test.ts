// ADR 105 §6 (19) — import_material and import_class_notes enqueue `prior-report` with the successfully imported paths.
// Test decision: the payload's `paths` are the paths RELATIVE to the materials folder (the source's identity in
// LH, the same as `fileSources`), because the job looks them up there.
import type { ImportFile, ImportResult } from "@graphharness/lh-client";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { sessionsTools } from "../../src/mcp/sessions.ts";
import { fakeLh, seedSubject } from "../../src/testing.ts";
import { world, type Ctx } from "../knowledge/helpers.ts";

let dir: string;

const ok = (f: ImportFile, i: number): ImportResult => ({ requestIndex: i, filePath: f.path, outcome: "completed", ok: true, stats: { nodes: 2 } });
const failed = (f: ImportFile, i: number): ImportResult => ({ requestIndex: i, filePath: f.path, outcome: "failed", ok: false, error: "boom" });
const partial = (f: ImportFile, i: number): ImportResult => ({ requestIndex: i, filePath: f.path, outcome: "partial", ok: true, notice: "Skipped 2 image-only pages" });
const aborted = (f: ImportFile, i: number): ImportResult => ({ requestIndex: i, filePath: f.path, outcome: "aborted", ok: false });

/** `outcome(filename)` decides LH's result for each file. */
function setup(outcome: (filename: string) => typeof ok = () => ok) {
  const lh = fakeLh({ importFiles: async (files: ImportFile[]) => files.map((f, i) => outcome(f.filename)(f, i)) });
  const w = world({ lh, config: { materialsDir: dir } });
  const s = seedSubject(w.ctx.db, { name: "Linear Algebra", lhSourceFolder: "algebra" });
  return { ...w, s };
}

const priorJobs = (ctx: Ctx) =>
  (ctx.db.prepare("SELECT payload_json FROM jobs WHERE type = 'prior-report' AND status = 'queued'").pluck().all() as string[]).map((x) => JSON.parse(x));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gh-prior-"));
  mkdirSync(join(dir, "algebra"), { recursive: true });
  for (const f of ["topic1.md", "topic2.md", "topic3.md"]) writeFileSync(join(dir, "algebra", f), `# ${f}`);
});

describe("import_material enqueues prior-report", () => {
  it("with the successfully imported paths, without those that failed or were aborted (a single job)", async () => {
    const { ctx, s } = setup((name) => (name === "topic1.md" ? ok : name === "topic2.md" ? failed : aborted));
    await sessionsTools.import_material!(ctx, { subjectId: s, paths: ["topic1.md", "topic2.md", "topic3.md"].map((f) => join(dir, "algebra", f)) });
    const jobs = priorJobs(ctx);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ subjectId: s, paths: ["algebra/topic1.md"] });
    // the trigger always sets startedAt (the job's idempotency key): the import time
    expect(jobs[0].startedAt).toBe(ctx.now().toISOString());
  });

  it("a partial result (ok: true) counts as a success", async () => {
    const { ctx, s } = setup((name) => (name === "topic1.md" ? partial : failed));
    await sessionsTools.import_material!(ctx, { subjectId: s, paths: [join(dir, "algebra", "topic1.md"), join(dir, "algebra", "topic2.md")] });
    expect(priorJobs(ctx)).toEqual([expect.objectContaining({ subjectId: s, paths: ["algebra/topic1.md"] })]);
  });

  it("all successful → all the paths, in the requested order", async () => {
    const { ctx, s } = setup();
    await sessionsTools.import_material!(ctx, { subjectId: s, paths: [join(dir, "algebra", "topic3.md"), join(dir, "algebra", "topic1.md")] });
    expect(priorJobs(ctx)).toEqual([expect.objectContaining({ subjectId: s, paths: ["algebra/topic3.md", "algebra/topic1.md"] })]);
  });

  it("totally failed import → nothing is enqueued", async () => {
    const { ctx, s } = setup(() => failed);
    await sessionsTools.import_material!(ctx, { subjectId: s, paths: [join(dir, "algebra", "topic1.md"), join(dir, "algebra", "topic2.md")] });
    expect(priorJobs(ctx)).toEqual([]);
  });
});

describe("import_class_notes enqueues prior-report", () => {
  it("notes imported successfully → job with the notes' relative path", async () => {
    const { ctx, s } = setup();
    const out = (await sessionsTools.import_class_notes!(ctx, { subjectId: s, title: "Diagonalization", markdown: "# Diagonalization" })) as { path: string };
    const rel = out.path.slice(dir.length + 1);
    expect(rel).toMatch(/^algebra\/agent-notes\/2026-11-10-/);
    expect(priorJobs(ctx)).toEqual([expect.objectContaining({ subjectId: s, paths: [rel], startedAt: ctx.now().toISOString() })]);
  });

  it("notes whose import fails → nothing is enqueued", async () => {
    const { ctx, s } = setup(() => failed);
    await sessionsTools.import_class_notes!(ctx, { subjectId: s, title: "Diagonalization", markdown: "# Diagonalization" });
    expect(priorJobs(ctx)).toEqual([]);
  });
});
