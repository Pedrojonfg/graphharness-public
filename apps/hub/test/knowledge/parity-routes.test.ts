// UI↔MCP parity REST routes (search, overview, notes, gaps, materials list).
import { GetSyllabusGapsOutputSchema, MaterialsListSchema, NoteSchema, SearchKnowledgeResponseSchema, SubjectOverviewSchema } from "@graphharness/contracts";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.ts";
import { makeTestContext, seedConcept, seedSubject } from "../../src/testing.ts";
import { call } from "../practice/helpers.ts";

function setup() {
  const ctx = makeTestContext();
  const app = createApp(ctx, { pwaDist: "/nonexistent" });
  const subject = seedSubject(ctx.db);
  const concept = seedConcept(ctx.db, { subjectId: subject });
  return { ctx, app, subject, concept };
}

describe("REST UI↔MCP parity", () => {
  it("GET /subjects/:id/overview", async () => {
    const { app, subject } = setup();
    const r = await call(app, "GET", `/subjects/${subject}/overview`);
    expect(r.status).toBe(200);
    expect(SubjectOverviewSchema.parse(r.json).subject.id).toBe(subject);
  });

  it("POST /knowledge/search", async () => {
    const { app } = setup();
    const r = await call(app, "POST", "/knowledge/search", { query: "zzz-no-match", limit: 5 });
    expect(r.status).toBe(200);
    expect(SearchKnowledgeResponseSchema.parse(r.json).concepts).toEqual([]);
  });

  it("POST /concepts/:id/notes", async () => {
    const { app, concept } = setup();
    const r = await call(app, "POST", `/concepts/${concept}/notes`, { text: "test note" });
    expect(r.status).toBe(201);
    expect(NoteSchema.parse(r.json)).toMatchObject({ conceptId: concept, text: "test note", origin: "pwa" });
  });

  it("GET /syllabus/:subjectId/gaps without a syllabus", async () => {
    const { app, subject } = setup();
    const r = await call(app, "GET", `/syllabus/${subject}/gaps`);
    expect(r.status).toBe(200);
    expect(GetSyllabusGapsOutputSchema.parse(r.json)).toMatchObject({ total: 0, seen: 0, unseen: [] });
  });

  it("GET /materials/:subjectId empty list or files", async () => {
    const { app, subject } = setup();
    const r = await call(app, "GET", `/materials/${subject}`);
    expect(r.status).toBe(200);
    expect(MaterialsListSchema.parse(r.json).files).toEqual([]);
  });
});
