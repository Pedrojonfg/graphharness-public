// ADR 105 §6 (22) — optional syllabus per subject: PUT/GET /syllabus/:subjectId and MCP import_syllabus / get_syllabus_gaps.
import { MCP_TOOLS } from "@graphharness/contracts";
import { describe, expect, it } from "vitest";
import { MCP_HANDLERS } from "../../src/mcp/server.ts";
import { seedProposition } from "../../src/testing.ts";
import { call, conceptIn, daysFromNow, mastery, subject, world, type Ctx } from "../knowledge/helpers.ts";

async function tool(ctx: Ctx, name: string, input: object): Promise<any> {
  const def = MCP_TOOLS.find((t) => t.name === name);
  expect(def, `${name} missing in MCP_TOOLS`).toBeDefined();
  const handler = MCP_HANDLERS[name];
  expect(handler, `MCP handler ${name} missing`).toBeDefined();
  return def!.output.parse(await handler!(ctx, def!.input.parse(input)));
}

const SYLLABUS = ["1. Matrices", "  - Determinants cofactors", "2. Diagonalization", "  - Eigenvalues eigenvectors", "3. Quadratic forms"].join("\n");

describe("PUT /syllabus/:subjectId", () => {
  it("saves the syllabus and returns how many topics and the parser's errors", async () => {
    const { ctx, app } = world();
    const s = subject(ctx);
    const res = await call(app, "put", `/syllabus/${s}`, { text: `${SYLLABUS}\n${"x".repeat(201)}` });
    expect(res.status).toBe(200);
    expect(res.json.count).toBe(5);
    expect(res.json.errors).toHaveLength(1);
    expect(ctx.db.prepare("SELECT position, level, title FROM syllabus_items WHERE subject_id = ? ORDER BY position").all(s)).toEqual([
      { position: 0, level: 0, title: "Matrices" },
      { position: 1, level: 1, title: "Determinants cofactors" },
      { position: 2, level: 0, title: "Diagonalization" },
      { position: 3, level: 1, title: "Eigenvalues eigenvectors" },
      { position: 4, level: 0, title: "Quadratic forms" },
    ]);
  });

  it("replaces the whole syllabus (does not accumulate)", async () => {
    const { ctx, app } = world();
    const s = subject(ctx);
    await call(app, "put", `/syllabus/${s}`, { text: SYLLABUS });
    const res = await call(app, "put", `/syllabus/${s}`, { text: "Vector spaces\nLinear maps" });
    expect(res.json).toEqual({ count: 2, errors: [] });
    const got = await call(app, "get", `/syllabus/${s}`);
    expect(got.json.items.map((i: { title: string }) => i.title)).toEqual(["Vector spaces", "Linear maps"]);
  });

  it("does not touch the syllabus of other subjects", async () => {
    const { ctx, app } = world();
    const a = subject(ctx, "Algebra");
    const b = subject(ctx, "Physics");
    await call(app, "put", `/syllabus/${a}`, { text: SYLLABUS });
    await call(app, "put", `/syllabus/${b}`, { text: "Kinematics" });
    expect((await call(app, "get", `/syllabus/${a}`)).json.items).toHaveLength(5);
  });

  it("non-existent subject → 404 not_found", async () => {
    const { app } = world();
    const res = await call(app, "put", "/syllabus/does-not-exist", { text: SYLLABUS });
    expect(res.status).toBe(404);
    expect(res.json).toMatchObject({ error: "not_found" });
  });

  it("no valid topic → 400 and the previous syllabus is kept", async () => {
    const { ctx, app } = world();
    const s = subject(ctx);
    await call(app, "put", `/syllabus/${s}`, { text: SYLLABUS });
    expect((await call(app, "put", `/syllabus/${s}`, { text: "\n   \n" })).status).toBe(400);
    expect((await call(app, "put", `/syllabus/${s}`, { text: "y".repeat(201) })).status).toBe(400);
    expect((await call(app, "get", `/syllabus/${s}`)).json.items).toHaveLength(5);
  });

  it("body without text → 400", async () => {
    const { ctx, app } = world();
    const s = subject(ctx);
    expect((await call(app, "put", `/syllabus/${s}`, {})).status).toBe(400);
  });
});

describe("GET /syllabus/:subjectId", () => {
  function setup() {
    const w = world();
    const s = subject(w.ctx, "Algebra");
    const other = subject(w.ctx, "Physics");
    // "Determinants cofactors": seen by name + statement of its proposition
    const det = conceptIn(w.ctx, s, "Determinants", ["Expansion by cofactors along a row"]);
    // "Eigenvalues eigenvectors": seen, but the concept is stale
    const auto = conceptIn(w.ctx, s, "Eigenvalues", [], "Eigenvalues and eigenvectors of a matrix");
    // "Quadratic forms": only covered by a concept of ANOTHER subject → not seen
    conceptIn(w.ctx, other, "Quadratic forms", [], "Quadratic forms");
    // "Diagonalization": only covered by a retired concept → not seen
    const ret = conceptIn(w.ctx, s, "Diagonalization", [], "Diagonalization of matrices");
    w.ctx.db.prepare("UPDATE concepts SET status = 'retired' WHERE id = ?").run(ret);
    mastery(w.ctx, det, "solid");
    mastery(w.ctx, auto, "solid", daysFromNow(-200));
    return { ...w, s, det, auto };
  }

  it("each topic with seen/unseen, the concept that covers it and its effective state", async () => {
    const { app, s, det, auto } = setup();
    await call(app, "put", `/syllabus/${s}`, { text: SYLLABUS });
    const res = await call(app, "get", `/syllabus/${s}`);
    expect(res.status).toBe(200);
    const items = res.json.items as any[];
    expect(items.map((i) => [i.position, i.level, i.title, i.seen])).toEqual([
      [0, 0, "Matrices", false],
      [1, 1, "Determinants cofactors", true],
      [2, 0, "Diagonalization", false],
      [3, 1, "Eigenvalues eigenvectors", true],
      [4, 0, "Quadratic forms", false],
    ]);
    for (const i of items) expect(typeof i.id).toBe("string");
    expect(items[1]).toMatchObject({ conceptId: det, conceptName: "Determinants", state: "solid", stale: false });
    expect(items[3]).toMatchObject({ conceptId: auto, conceptName: "Eigenvalues", stale: true });
    // unseen: without concept or state, even if a concept shares some token
    for (const i of [items[0], items[2], items[4]]) expect(i).toMatchObject({ conceptId: null, conceptName: null, state: null, stale: null });
  });

  it("non-existent subject → 404 not_found", async () => {
    const { app } = world();
    const res = await call(app, "get", "/syllabus/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.json).toMatchObject({ error: "not_found" });
  });

  it("subject without a syllabus → empty items", async () => {
    const { ctx, app } = world();
    const s = subject(ctx);
    const res = await call(app, "get", `/syllabus/${s}`);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ items: [] });
  });

  it("a deleted proposition does not count towards covering a topic", async () => {
    const { ctx, app } = world();
    const s = subject(ctx);
    const c = conceptIn(ctx, s, "Matrices");
    const p = seedProposition(ctx.db, { statement: "Orthogonality gramschmidt", conceptId: c });
    ctx.db.prepare("UPDATE lh_propositions SET deleted = 1 WHERE id = ?").run(p);
    await call(app, "put", `/syllabus/${s}`, { text: "Orthogonality gramschmidt" });
    const res = await call(app, "get", `/syllabus/${s}`);
    expect(res.status).toBe(200);
    expect(res.json.items).toHaveLength(1);
    expect(res.json.items[0].seen).toBe(false);
  });
});

describe("MCP import_syllabus and get_syllabus_gaps", () => {
  it("import_syllabus saves and answers {count, errors}; get_syllabus_gaps lists the unseen ones in order", async () => {
    const { ctx } = world();
    const s = subject(ctx);
    conceptIn(ctx, s, "Diagonalization", ["A matrix is diagonalizable if it has a basis of eigenvectors"]);
    expect(await tool(ctx, "import_syllabus", { subjectId: s, text: SYLLABUS })).toEqual({ count: 5, errors: [] });
    expect(await tool(ctx, "get_syllabus_gaps", { subjectId: s })).toEqual({
      total: 5,
      seen: 1,
      unseen: [
        { title: "Matrices", level: 0 },
        { title: "Determinants cofactors", level: 1 },
        { title: "Eigenvalues eigenvectors", level: 1 },
        { title: "Quadratic forms", level: 0 },
      ],
    });
  });

  it("get_syllabus_gaps without a syllabus → total 0", async () => {
    const { ctx } = world();
    const s = subject(ctx);
    expect(await tool(ctx, "get_syllabus_gaps", { subjectId: s })).toEqual({ total: 0, seen: 0, unseen: [] });
  });
});
