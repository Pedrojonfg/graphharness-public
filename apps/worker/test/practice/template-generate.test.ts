// template-generate job (LLM strong + real eval). Valid recipe → active; invalid → one retry with the problems → failed.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestContext, seedConcept, seedProposition, seedSubject, startEval } from "../../../hub/src/testing.ts";
import { callsOf, DERIVATIVE, llmFor, makeJob, row, rows, templateCandidates } from "../../../hub/test/practice/helpers.ts";
import { handlers } from "../../src/handlers/practice.ts";

let ev: Awaited<ReturnType<typeof startEval>>;
beforeAll(async () => {
  ev = await startEval();
});
afterAll(() => ev?.stop());

const SAME_AS_ANSWER = { key: "same_as_answer", description: "Not distinguishable from the solution", expr: "diff(a*x^3 + b*x, x)" };
const BAD_RECIPE = { ...DERIVATIVE, answer: { kind: "expression", expr: "A.inv()" } };

function setup(recipes: unknown[]) {
  let i = 0;
  const llm = llmFor({ template: () => templateCandidates(recipes[Math.min(i++, recipes.length - 1)]) });
  const ctx = makeTestContext({ evalApi: ev.client, llm });
  const subject = seedSubject(ctx.db, { name: "Calculus" });
  const concept = seedConcept(ctx.db, { subjectId: subject, name: "Derivative of a polynomial", computable: true });
  seedProposition(ctx.db, { conceptId: concept, statement: "The derivative of $x^n$ is $n x^{n-1}$." });
  return { ctx, llm, concept };
}

describe("template-generate", () => {
  it("valid recipe: active template with its sheet, and only the surviving errors in template_errors (origin recipe)", async () => {
    const { ctx, llm, concept } = setup([{ ...DERIVATIVE, errors: [...DERIVATIVE.errors, SAME_AS_ANSWER] }]);
    await handlers["template-generate"](ctx, makeJob("template-generate", { conceptId: concept }));

    const ts = rows(ctx.db, "SELECT * FROM templates WHERE concept_id = ?", concept);
    expect(ts).toHaveLength(1);
    expect(ts[0]).toMatchObject({ status: "active", level: "base" });
    expect(ts[0].method_summary).toContain("1. Lower the exponent. 2. Subtract one from the exponent.");
    expect(ts[0].method_limits).toContain("Only valid for integer powers.");
    expect(ts[0].slug).toMatch(/\S/);
    const recipe = JSON.parse(ts[0].recipe_json);
    expect(recipe.answer.expr).toBe("diff(a*x^3 + b*x, x)");
    expect(JSON.parse(ts[0].validation_json).ok).toBe(true);

    const errs = rows(ctx.db, "SELECT key, origin, times_seen FROM template_errors WHERE template_id = ?", ts[0].id);
    expect(errs).toEqual([{ key: "power_not_lowered", origin: "recipe", times_seen: 0 }]); // eval discards same_as_answer
    expect(recipe.errors.map((e: { key: string }) => e.key)).toEqual(["power_not_lowered"]);
    expect(callsOf(llm, "template")).toHaveLength(1);
    expect(callsOf(llm, "template")[0].tier).toBe("strong");
  });

  it("invalid recipe then valid: the retry receives eval's problems and the template becomes active", async () => {
    const { ctx, llm, concept } = setup([BAD_RECIPE, DERIVATIVE]);
    const problems = (await ev.client.validateRecipe(BAD_RECIPE)).problems;
    expect(problems.length).toBeGreaterThan(0);

    await handlers["template-generate"](ctx, makeJob("template-generate", { conceptId: concept }));
    const calls = callsOf(llm, "template");
    expect(calls).toHaveLength(2);
    const retryText = JSON.stringify(calls[1].messages);
    for (const p of problems) expect(retryText).toContain(p);
    expect(JSON.stringify(calls[0].messages)).not.toContain(problems[0]);
    expect(rows(ctx.db, "SELECT status FROM templates WHERE concept_id = ?", concept).map((r) => r.status)).toEqual(["active"]);
  });

  it("invalid recipe twice: template failed, no errors, the concept still has no active template; the job does not fail", async () => {
    const { ctx, llm, concept } = setup([BAD_RECIPE]);
    const problems = (await ev.client.validateRecipe(BAD_RECIPE)).problems;
    await handlers["template-generate"](ctx, makeJob("template-generate", { conceptId: concept }));

    expect(callsOf(llm, "template")).toHaveLength(2); // only one retry
    expect(JSON.stringify(callsOf(llm, "template")[1].messages)).toContain(problems[0]);
    const ts = rows(ctx.db, "SELECT * FROM templates WHERE concept_id = ?", concept);
    expect(ts).toHaveLength(1);
    expect(ts[0].status).toBe("failed");
    expect(JSON.parse(ts[0].validation_json).ok).toBe(false);
    expect(rows(ctx.db, "SELECT 1 FROM template_errors WHERE template_id = ?", ts[0].id)).toHaveLength(0);
    expect(row(ctx.db, "SELECT COUNT(*) AS n FROM templates WHERE concept_id = ? AND status = 'active'", concept).n).toBe(0);
  });

  it("non-computable or nonexistent concept: no template is generated and the LLM is not called", async () => {
    const { ctx, llm } = setup([DERIVATIVE]);
    const plain = seedConcept(ctx.db, { name: "History", computable: false });
    await handlers["template-generate"](ctx, makeJob("template-generate", { conceptId: plain }));
    expect(rows(ctx.db, "SELECT 1 FROM templates")).toHaveLength(0);
    expect(llm.calls).toHaveLength(0);
  });
});
