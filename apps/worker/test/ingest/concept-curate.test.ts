// concept-curate (ADR 102 point 8) with a fake LLM.
import { describe, expect, it } from "vitest";
import { makeTestContext, seedConcept, seedProposition, seedSubject } from "@graphharness/hub/testing";
import { searchConceptsFts } from "@graphharness/hub/services/fts";
import { runOnce } from "../../src/runner.ts";
import { enqueueJob } from "@graphharness/hub/services/jobs";
import { handlers, runConceptCurate, runLhSync } from "../../src/handlers/ingest.ts";
import { CURATE_BATCH } from "../../src/ingest/curate.ts";
import { CURATE_PROPS, count, haystack, jobs, lhWith, llmByKind, loadGraph } from "./helpers.ts";

const ids = (h: string): string[] => [...new Set(h.match(/n_[0-9a-f]{12}/g) ?? [])];
const REAL = CURATE_PROPS; // isothermal process, adiabatic process, ideal gas law, Carnot engine

function setup() {
  const llmHolder = { responder: (_h: string): object => ({}) };
  const llm = llmByKind({ curator: (req) => llmHolder.responder(haystack(req)) });
  const ctx = makeTestContext({ llm });
  const subject = seedSubject(ctx.db, { name: "Thermodynamics" });
  const existing = seedConcept(ctx.db, { id: "c_exist01", subjectId: subject, name: "Ideal gas model", description: "Pressure, volume and temperature of an ideal gas." });
  const graph = loadGraph();
  for (const p of Object.values(REAL)) {
    const g = graph.propositions.find((x) => x.id === p)!;
    seedProposition(ctx.db, { id: p, name: g.name, statement: g.statement });
  }
  return { ctx, llm, llmHolder, subject, existing, graph };
}

describe("concept-curate", () => {
  it("creates new concepts and assigns to existing ones, with curator edges at low, FTS and chained jobs", async () => {
    const { ctx, llmHolder, subject, existing, graph } = setup();
    const n1 = { tempId: "t1", name: "Gas state equations", description: "Equations that relate the state variables of a gas.", subjectId: subject, computable: true };
    const n2 = { tempId: "t2", name: "Heat engines", description: "Cycles that turn heat into work.", subjectId: subject, computable: false };
    llmHolder.responder = () => ({
      assignments: [
        { propositionId: REAL.p1, conceptId: existing, newConcept: null },
        { propositionId: REAL.p2, conceptId: null, newConcept: n1 },
        { propositionId: REAL.p3, conceptId: null, newConcept: n1 },
        { propositionId: REAL.p4, conceptId: null, newConcept: n2 },
      ],
      newEdges: [
        { from: existing, to: "t1", relation: "requires" },
        { from: "t1", to: "t2", relation: "requires" },
      ],
    });
    const r = await runConceptCurate(ctx);
    expect(r.assigned).toBe(4);
    expect(r.createdConceptIds).toHaveLength(2);

    const created = ctx.db.prepare("SELECT * FROM concepts WHERE id <> ? ORDER BY name").all(existing) as Record<string, any>[];
    expect(created.map((c) => c.name)).toEqual(["Gas state equations", "Heat engines"]);
    expect(created.every((c) => c.created_by === "curator" && c.subject_id === subject && c.status === "active")).toBe(true);
    const gas = created.find((c) => c.name === "Gas state equations")!;
    const engines = created.find((c) => c.name === "Heat engines")!;
    expect(gas.computable).toBe(1);
    expect(engines.computable).toBe(0);
    expect(r.createdConceptIds.sort()).toEqual([gas.id, engines.id].sort());

    const cp = Object.fromEntries((ctx.db.prepare("SELECT proposition_id, concept_id, assigned_by FROM concept_propositions").all() as any[]).map((x) => [x.proposition_id, x]));
    expect(cp[REAL.p1].concept_id).toBe(existing);
    expect(cp[REAL.p2].concept_id).toBe(gas.id);
    expect(cp[REAL.p3].concept_id).toBe(gas.id);
    expect(cp[REAL.p4].concept_id).toBe(engines.id);
    expect(Object.values(cp).every((x: any) => x.assigned_by === "curator")).toBe(true);

    const e1 = ctx.db.prepare("SELECT * FROM concept_edges WHERE from_concept = ? AND to_concept = ?").get(existing, gas.id) as any;
    const e2 = ctx.db.prepare("SELECT * FROM concept_edges WHERE from_concept = ? AND to_concept = ?").get(gas.id, engines.id) as any;
    for (const e of [e1, e2]) expect(e).toMatchObject({ source: "curator", confidence: "low", chain_support: 0, relation: "requires", removed: 0 });
    expect(count(ctx.db, "SELECT count(*) FROM concept_edges")).toBe(2);

    // FTS: found by the statement of an assigned proposition.
    const stmt = graph.propositions.find((x) => x.id === REAL.p2)!.statement;
    expect(searchConceptsFts(ctx.db, stmt, { limit: 5 }).map((h) => h.conceptId)).toContain(gas.id);
    expect(searchConceptsFts(ctx.db, "Heat engines").map((h) => h.conceptId)).toContain(engines.id);

    // Jobs: template-generate ONLY for the new computable concept; edges-derive enqueued.
    expect(jobs(ctx.db, "template-generate", "queued").map((j) => j.payload)).toEqual([{ conceptId: gas.id }]);
    expect(jobs(ctx.db, "edges-derive", "queued")).toHaveLength(1);
  });

  it("a proposition with concept null and newConcept null stays unassigned (no concept is invented)", async () => {
    const { ctx, llmHolder, existing } = setup();
    llmHolder.responder = () => ({
      assignments: [
        { propositionId: REAL.p1, conceptId: existing, newConcept: null },
        { propositionId: REAL.p2, conceptId: null, newConcept: null },
        { propositionId: REAL.p3, conceptId: existing, newConcept: null },
        { propositionId: REAL.p4, conceptId: existing, newConcept: null },
      ],
      newEdges: [],
    });
    const r = await runConceptCurate(ctx);
    expect(r.assigned).toBe(3);
    expect(r.createdConceptIds).toEqual([]);
    expect(count(ctx.db, "SELECT count(*) FROM concept_propositions WHERE proposition_id = ?", REAL.p2)).toBe(0);
    expect(count(ctx.db, "SELECT count(*) FROM concepts")).toBe(1);
  });

  it("invalid LLM output (does not match the schema) → the job fails for retry and writes nothing", async () => {
    const { ctx, llm, llmHolder } = setup();
    llmHolder.responder = () => ({ assignments: "this is not a list", newEdges: [] });
    await expect(runConceptCurate(ctx)).rejects.toThrow();
    expect(llm.kinds).toContain("curator"); // failed due to the LLM output, not earlier
    enqueueJob(ctx.db, "concept-curate", {}, { now: ctx.now() });
    const r = await runOnce(ctx, handlers);
    expect(r?.outcome).toBe("retry");
    expect(jobs(ctx.db, "concept-curate", "queued")).toHaveLength(1);
    expect(count(ctx.db, "SELECT count(*) FROM concepts")).toBe(1);
    expect(count(ctx.db, "SELECT count(*) FROM concept_propositions")).toBe(0);
    expect(count(ctx.db, "SELECT count(*) FROM concept_edges")).toBe(0);
    expect(jobs(ctx.db, "template-generate")).toEqual([]);
  });

  it("assignment to a nonexistent concept → fails and leaves no partial write (transaction)", async () => {
    const { ctx, llm, llmHolder, subject, existing } = setup();
    llmHolder.responder = () => ({
      assignments: [
        { propositionId: REAL.p1, conceptId: existing, newConcept: null },
        { propositionId: REAL.p2, conceptId: null, newConcept: { tempId: "t1", name: "New concept", description: "d", subjectId: subject, computable: false } },
        { propositionId: REAL.p3, conceptId: "c_does_not_exist", newConcept: null },
      ],
      newEdges: [],
    });
    await expect(runConceptCurate(ctx)).rejects.toThrow();
    expect(llm.kinds).toContain("curator");
    expect(count(ctx.db, "SELECT count(*) FROM concepts")).toBe(1);
    expect(count(ctx.db, "SELECT count(*) FROM concept_propositions")).toBe(0);
  });

  it("processes ALL live propositions without a concept in batches of ≤ CURATE_BATCH (a snapshot of 6 batches plus a partial one)", async () => {
    // The fixture graph is small, so the volume is built in memory: the real propositions plus extras with distinct ids.
    const TOTAL = 6 * CURATE_BATCH + Math.floor(CURATE_BATCH / 2);
    const base = loadGraph();
    const extras = Array.from({ length: TOTAL - base.propositions.length }, (_, i) => ({
      id: `n_${(i + 1).toString(16).padStart(12, "0")}`,
      name: `Synthetic proposition ${i}`,
      statement: `Synthetic statement number ${i}.`,
      aliases: [],
      provenance: [],
      createdAt: "2026-09-20T18:30:00.000Z",
    }));
    const graph = { propositions: [...base.propositions, ...extras], chains: base.chains };
    expect(new Set(graph.propositions.map((p) => p.id)).size).toBe(TOTAL);
    const ctx = makeTestContext({ lh: lhWith({ graph }) });
    await runLhSync(ctx);
    expect(count(ctx.db, "SELECT count(*) FROM lh_propositions WHERE deleted = 0")).toBe(TOTAL);
    const subject = seedSubject(ctx.db);
    const existing = seedConcept(ctx.db, { id: "c_big", subjectId: subject });
    const sizes: number[] = [];
    const llm2 = llmByKind({
      curator: (req) => {
        const pending = ids(haystack(req)).filter((id) => count(ctx.db, "SELECT count(*) FROM concept_propositions WHERE proposition_id = ?", id) === 0);
        sizes.push(pending.length);
        return { assignments: pending.map((propositionId) => ({ propositionId, conceptId: existing, newConcept: null })), newEdges: [] };
      },
    });
    ctx.llm = llm2;
    const r = await runConceptCurate(ctx);
    expect(r.assigned).toBe(TOTAL);
    expect(sizes.every((s) => s >= 1 && s <= CURATE_BATCH)).toBe(true);
    expect(sizes).toHaveLength(Math.ceil(TOTAL / CURATE_BATCH));
    expect(sizes.slice(0, -1).every((s) => s === CURATE_BATCH)).toBe(true);
    expect(sizes.at(-1)).toBe(TOTAL % CURATE_BATCH);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(TOTAL);
    expect(count(ctx.db, "SELECT count(*) FROM concept_propositions")).toBe(TOTAL);
    // Second run: nothing pending, does not call the LLM.
    const before = sizes.length;
    const r2 = await runConceptCurate(ctx);
    expect(r2.assigned).toBe(0);
    expect(sizes).toHaveLength(before);
  });
});
