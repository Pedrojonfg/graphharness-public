// ADR 108: code templates → instance without solution; attempt with userInput.given.
import { ExerciseAttemptResponseSchema, ExerciseSchema } from "@graphharness/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.ts";
import { clientPayloadOf, isCodeRecipe } from "../../src/services/templates.ts";
import { isoNow, ulid } from "@graphharness/core";
import { makeTestContext, seedConcept, seedSubject, startEval } from "../../src/testing.ts";
import { call, row } from "./helpers.ts";

export const PARSONS_RECIPE = {
  version: 1,
  kind: "parsons",
  statement: "Order the lines to print hello.",
  language: "python",
  lines: [
    { key: "l0", text: 'print("hello")', indent: 0 },
    { key: "l1", text: "x = 1", indent: 0 },
    { key: "d0", text: "import os", indent: 0, distractor: true },
  ],
  order: ["l0", "l1"],
};

function seedCodeTemplate(ctx: ReturnType<typeof makeTestContext>, conceptId: string) {
  const id = ulid();
  ctx.db
    .prepare(
      `INSERT INTO templates (id, concept_id, slug, name, method_summary, method_limits, recipe_json, level, status, validation_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'base', 'active', '{}', ?)`,
    )
    .run(id, conceptId, `code-${id.slice(-6)}`, "Parsons hello", "Order.", "No imports.", JSON.stringify(PARSONS_RECIPE), isoNow(ctx.now()));
  return id;
}

let ev: Awaited<ReturnType<typeof startEval>>;
beforeAll(async () => {
  ev = await startEval();
});
afterAll(() => ev?.stop());

describe("isCodeRecipe / clientPayloadOf", () => {
  it("detects kind and hides the solution", async () => {
    expect(isCodeRecipe(PARSONS_RECIPE)).toBe(true);
    expect(isCodeRecipe({ version: 1, statement: "x", params: [], answer: { kind: "number", expr: "1" } })).toBe(false);
    const full = await ev.client.generateCode(PARSONS_RECIPE);
    const client = clientPayloadOf(full);
    expect(client).toMatchObject({ comprehensionVersion: 1, kind: "parsons" });
    expect(client).not.toHaveProperty("order");
    expect((client as { lines: unknown[] }).lines.length).toBe(3);
  });
});

describe("POST /exercises (code)", () => {
  it("instance without order; correct attempt with given.order", async () => {
    const ctx = makeTestContext({ evalApi: ev.client });
    const app = createApp(ctx, { pwaDist: "/nonexistent" });
    const concept = seedConcept(ctx.db, { subjectId: seedSubject(ctx.db, { kind: "programming", name: "Python" }), computable: true });
    const templateId = seedCodeTemplate(ctx, concept);
    const r = await call(app, "POST", "/exercises", { templateId });
    expect(r.status).toBe(201);
    const ex = ExerciseSchema.parse(r.json);
    expect(ex.instance).toMatchObject({ comprehensionVersion: 1, kind: "parsons" });
    expect(ex.instance).not.toHaveProperty("order");

    const payload = JSON.parse(row(ctx.db, "SELECT payload_json FROM instances WHERE id = ?", ex.instanceId).payload_json);
    expect(payload.order).toEqual(["l0", "l1"]);

    const wrong = await call(app, "POST", `/exercises/${ex.instanceId}/attempt`, {
      userInput: { given: { order: ["l1", "l0"] } },
      responseMs: 3000,
    });
    expect(wrong.status).toBe(200);
    expect(ExerciseAttemptResponseSchema.parse(wrong.json)).toMatchObject({ correct: false, canRetry: true, solution: null });

    const ok = await call(app, "POST", `/exercises/${ex.instanceId}/attempt`, {
      userInput: { given: { order: payload.order } },
      responseMs: 2000,
    });
    const body = ExerciseAttemptResponseSchema.parse(ok.json);
    expect(body).toMatchObject({ correct: true, finished: true });
    expect(body.solution).toEqual({ order: ["l0", "l1"] });
  });
});
