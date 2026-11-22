import { describe, expect, it } from "vitest";
import { migrate, openDb } from "./index.ts";

describe("openDb", () => {
  it("applies the migrations only once and creates the schema", () => {
    const db = openDb(":memory:");
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table') ORDER BY name").pluck().all();
    expect(tables).toEqual(expect.arrayContaining(["subjects", "concepts", "evidence_events", "concept_state", "cards", "jobs", "concept_fts", "concept_suggestions", "diagnostics", "unassigned_questions", "meta"]));
    migrate(db); // idempotent
    expect(db.prepare("SELECT count(*) FROM schema_migrations").pluck().get()).toBe(6);
  });
});
