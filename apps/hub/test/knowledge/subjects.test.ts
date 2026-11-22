// L1 — Subjects CRUD (REST) and create_subject (MCP). Contract: packages/contracts/src/api/subjects.ts.
import { CreateSubjectOutputSchema, SubjectListSchema, SubjectSchema } from "@graphharness/contracts";
import { describe, expect, it } from "vitest";
import { knowledgeTools } from "../../src/mcp/knowledge.ts";
import { call, world } from "./helpers.ts";

describe("POST /subjects", () => {
  it("creates with 201, derives a valid slug and fills in the defaults", async () => {
    const { app } = world();
    const r = await call(app, "post", "/subjects", { name: "Linear Algebra", kind: "computable_math", courseNotation: "Column vectors" });
    expect(r.status).toBe(201);
    const s = SubjectSchema.parse(r.json);
    expect(s).toMatchObject({ name: "Linear Algebra", kind: "computable_math", courseNotation: "Column vectors", lhSourceFolder: null, archivedAt: null });
    expect(s.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(s.createdAt).toBe("2026-11-10T09:00:00.000Z");
  });

  it("default kind 'general'", async () => {
    const { app } = world();
    const r = await call(app, "post", "/subjects", { name: "Modern Philosophy" });
    expect(r.status).toBe(201);
    expect(SubjectSchema.parse(r.json).kind).toBe("general");
  });

  it("same name → 409 slug_taken", async () => {
    const { app } = world();
    expect((await call(app, "post", "/subjects", { name: "Calculus" })).status).toBe(201);
    const r = await call(app, "post", "/subjects", { name: "Calculus" });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ error: "slug_taken" });
  });

  it("invalid body → 400 invalid_request with issues", async () => {
    const { app } = world();
    for (const body of [{}, { name: "   " }, { name: "X", kind: "other" }]) {
      const r = await call(app, "post", "/subjects", body);
      expect(r.status).toBe(400);
      expect(r.json.error).toBe("invalid_request");
      expect(Array.isArray(r.json.issues)).toBe(true);
    }
  });
});

describe("GET /subjects and PATCH /subjects/:id", () => {
  it("also lists archived ones and PATCH archives/unarchives", async () => {
    const { app } = world();
    const a = SubjectSchema.parse((await call(app, "post", "/subjects", { name: "Algebra" })).json);
    const b = SubjectSchema.parse((await call(app, "post", "/subjects", { name: "Physics" })).json);

    const arch = await call(app, "patch", `/subjects/${b.id}`, { archived: true });
    expect(arch.status).toBe(200);
    expect(SubjectSchema.parse(arch.json).archivedAt).toBe("2026-11-10T09:00:00.000Z");

    const list = await call(app, "get", "/subjects");
    expect(list.status).toBe(200);
    const subjects = SubjectListSchema.parse(list.json);
    expect(subjects.map((s) => s.id).sort()).toEqual([a.id, b.id].sort());
    expect(subjects.find((s) => s.id === b.id)!.archivedAt).not.toBeNull();
    expect(subjects.find((s) => s.id === a.id)!.archivedAt).toBeNull();

    const un = await call(app, "patch", `/subjects/${b.id}`, { archived: false });
    expect(SubjectSchema.parse(un.json).archivedAt).toBeNull();
  });

  it("edits name, kind and optional fields; null clears an optional one", async () => {
    const { app } = world();
    const s = SubjectSchema.parse((await call(app, "post", "/subjects", { name: "Logic", courseNotation: "N1", lhSourceFolder: "logic" })).json);
    const r = await call(app, "patch", `/subjects/${s.id}`, { name: "Formal Logic", kind: "computable_math", courseNotation: null });
    expect(r.status).toBe(200);
    expect(SubjectSchema.parse(r.json)).toMatchObject({ id: s.id, name: "Formal Logic", kind: "computable_math", courseNotation: null, lhSourceFolder: "logic" });
  });

  it("renaming to an existing name → 409 slug_taken", async () => {
    const { app } = world();
    await call(app, "post", "/subjects", { name: "Algebra" });
    const b = SubjectSchema.parse((await call(app, "post", "/subjects", { name: "Calculus" })).json);
    const r = await call(app, "patch", `/subjects/${b.id}`, { name: "Algebra" });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ error: "slug_taken" });
  });

  it("404 if it does not exist; 400 with an empty body", async () => {
    const { app } = world();
    const s = SubjectSchema.parse((await call(app, "post", "/subjects", { name: "Algebra" })).json);
    const nf = await call(app, "patch", "/subjects/nope", { name: "X" });
    expect(nf.status).toBe(404);
    expect(nf.json).toEqual({ error: "not_found" });
    const bad = await call(app, "patch", `/subjects/${s.id}`, {});
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe("invalid_request");
  });
});

describe("MCP create_subject", () => {
  it("creates and returns the subject; a repeated name is 409 slug_taken", async () => {
    const { ctx, app } = world();
    const out = CreateSubjectOutputSchema.parse(await knowledgeTools.create_subject!(ctx, { name: "Linear Algebra", kind: "computable_math", courseNotation: "A^t transpose" }));
    expect(out).toMatchObject({ name: "Linear Algebra", kind: "computable_math", courseNotation: "A^t transpose" });
    // visible through REST
    expect(SubjectListSchema.parse((await call(app, "get", "/subjects")).json).map((s) => s.id)).toContain(out.id);
    await expect(knowledgeTools.create_subject!(ctx, { name: "Linear Algebra", kind: "general" })).rejects.toMatchObject({ status: 409, body: { error: "slug_taken" } });
  });
});
