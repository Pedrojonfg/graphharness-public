// error-hypothesize job: promotion of personal errors by reproduction in a real eval.
import { ExerciseAttemptResponseSchema, ExerciseSchema } from "@graphharness/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../../hub/src/app.ts";
import { makeTestContext, seedConcept, seedSubject, startEval } from "../../../hub/src/testing.ts";
import { call, callsOf, hypothesisCandidates, instancePayload, llmFor, makeJob, row, rows, seedTemplate, signFlipAnswer } from "../../../hub/test/practice/helpers.ts";
import { drain } from "../../src/runner.ts";
import { handlers } from "../../src/handlers/practice.ts";

let ev: Awaited<ReturnType<typeof startEval>>;
beforeAll(async () => {
  ev = await startEval();
});
afterAll(() => ev?.stop());

const SIGN_FLIP = { key: "sign_flip_linear", description: "Flips the sign of the linear term when differentiating", expr: "3*a*x^2 - b" };

async function setup(hypothesis: { key: string; description: string; expr: string }) {
  const llm = llmFor({ hypothesis: () => hypothesisCandidates(hypothesis) });
  const ctx = makeTestContext({ evalApi: ev.client, llm });
  const app = createApp(ctx, { pwaDist: "/nonexistent" });
  const concept = seedConcept(ctx.db, { subjectId: seedSubject(ctx.db), computable: true });
  const { templateId } = await seedTemplate(ctx, { conceptId: concept });
  const start = async () => ExerciseSchema.parse((await call(app, "POST", "/exercises", { templateId })).json);
  const attempt = async (instanceId: string, result: unknown) => {
    const r = await call(app, "POST", `/exercises/${instanceId}/attempt`, { userInput: { result } });
    return ExerciseAttemptResponseSchema.parse(r.json);
  };
  // The learner makes the "sign of the linear term" error: eval does not know it → unknown_error → job enqueued.
  const ex = await start();
  const first = await attempt(ex.instanceId, signFlipAnswer(instancePayload(ctx.db, ex.instanceId)));
  expect(first.outcome).toBe("unknown_error");
  const unknownErrorId = row(ctx.db, "SELECT id FROM unknown_errors").id as string;
  return { ctx, llm, app, concept, templateId, start, attempt, unknownErrorId };
}

describe("error-hypothesize", () => {
  it("hypothesis that reproduces the failure and is distinguishable → template_errors origin personal, unknown_errors promoted, and the error is detected afterwards", async () => {
    const { ctx, llm, templateId, start, attempt, unknownErrorId } = await setup(SIGN_FLIP);
    await drain(ctx, handlers); // runs the job enqueued by the attempt
    expect(callsOf(llm, "hypothesis")).toHaveLength(1);
    expect(callsOf(llm, "hypothesis")[0].tier).toBe("strong");

    const personal = rows(ctx.db, "SELECT * FROM template_errors WHERE template_id = ? AND origin = 'personal'", templateId);
    expect(personal).toHaveLength(1);
    expect(personal[0]).toMatchObject({ key: SIGN_FLIP.key, description: SIGN_FLIP.description, expr: SIGN_FLIP.expr });
    const ue = row(ctx.db, "SELECT * FROM unknown_errors WHERE id = ?", unknownErrorId);
    expect(ue.status).toBe("promoted");
    expect(JSON.parse(ue.hypothesis_json)).toMatchObject({ key: SIGN_FLIP.key, expr: SIGN_FLIP.expr });

    // New exercise: the Hub passes the personal errors to eval (first) and the same failure is now known.
    const ex2 = await start();
    const payload2 = instancePayload(ctx.db, ex2.instanceId);
    expect(Object.keys(payload2.errors)).toContain(SIGN_FLIP.key);
    const again = await attempt(ex2.instanceId, signFlipAnswer(payload2));
    expect(again).toMatchObject({ correct: false, outcome: "known_error", canRetry: true });
    const seen = row(ctx.db, "SELECT times_seen FROM template_errors WHERE id = ?", personal[0].id);
    expect(seen.times_seen).toBe(1);
    expect(row(ctx.db, "SELECT matched_error_id FROM attempts WHERE instance_id = ?", ex2.instanceId).matched_error_id).toBe(personal[0].id);
  });

  it("is idempotent: running the handler twice does not duplicate the personal error", async () => {
    const { ctx, templateId, unknownErrorId } = await setup(SIGN_FLIP);
    const job = makeJob("error-hypothesize", { unknownErrorId });
    await handlers["error-hypothesize"](ctx, job);
    await handlers["error-hypothesize"](ctx, job);
    expect(rows(ctx.db, "SELECT 1 FROM template_errors WHERE template_id = ? AND origin = 'personal'", templateId)).toHaveLength(1);
    expect(row(ctx.db, "SELECT status FROM unknown_errors WHERE id = ?", unknownErrorId).status).toBe("promoted");
  });

  it("hypothesis that does not reproduce the learner's answer → unknown_errors rejected and no personal error is created", async () => {
    const { ctx, templateId, unknownErrorId } = await setup({ key: "sum_instead_of_differentiating", description: "Adds the coefficients", expr: "a + b" });
    await handlers["error-hypothesize"](ctx, makeJob("error-hypothesize", { unknownErrorId }));
    const ue = row(ctx.db, "SELECT * FROM unknown_errors WHERE id = ?", unknownErrorId);
    expect(ue.status).toBe("rejected");
    expect(ue.hypothesis_json).toBeTruthy(); // stored for the master report ("failures without a pattern")
    expect(rows(ctx.db, "SELECT 1 FROM template_errors WHERE template_id = ? AND origin = 'personal'", templateId)).toHaveLength(0);
  });

  it("hypothesis with an expression outside the allowlist → rejected", async () => {
    const { ctx, unknownErrorId } = await setup({ key: "malicioso", description: "Tries to run code", expr: "__import__('os').system('x')" });
    await handlers["error-hypothesize"](ctx, makeJob("error-hypothesize", { unknownErrorId }));
    expect(row(ctx.db, "SELECT status FROM unknown_errors WHERE id = ?", unknownErrorId).status).toBe("rejected");
  });

  it("hypothesis equal to the solution (does not reproduce the learner's failure and is not distinguishable) → rejected", async () => {
    const { ctx, unknownErrorId } = await setup({ key: "same_as_solution", description: "It is the solution itself", expr: "diff(a*x^3 + b*x, x)" });
    await handlers["error-hypothesize"](ctx, makeJob("error-hypothesize", { unknownErrorId }));
    expect(row(ctx.db, "SELECT status FROM unknown_errors WHERE id = ?", unknownErrorId).status).toBe("rejected");
  });
});
