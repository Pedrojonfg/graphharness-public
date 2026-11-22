// edges-derive (ADR 102 points 7, 8) with chains seeded by hand.
import { describe, expect, it } from "vitest";
import { makeTestContext, seedConcept, seedProposition, seedEdge } from "@graphharness/hub/testing";
import type { Db } from "@graphharness/db";
import { handlers, runEdgesDerive } from "../../src/handlers/ingest.ts";
import { count } from "./helpers.ts";

interface Seed {
  A: string; B: string; C: string; D: string; E: string;
}
function seed(db: Db): Seed {
  const ids = { A: "c_A", B: "c_B", C: "c_C", D: "c_D", E: "c_E" };
  for (const id of Object.values(ids)) seedConcept(db, { id });
  const props: Record<string, string[]> = { c_A: ["a1", "a2", "a3"], c_B: ["b1", "b2"], c_C: ["c1", "c2"], c_D: ["d1"], c_E: ["e1"] };
  for (const [c, ps] of Object.entries(props)) for (const p of ps) seedProposition(db, { id: `n_${p}`, conceptId: c });
  return ids;
}
function chain(db: Db, id: string, premises: string[], conclusion: string, deleted = 0): void {
  db.prepare("INSERT INTO lh_chains (id, premises_json, conclusion, deleted, last_synced_at) VALUES (?, ?, ?, ?, ?)").run(
    id,
    JSON.stringify(premises.map((p) => `n_${p}`)),
    `n_${conclusion}`,
    deleted,
    "2026-11-10T09:00:00.000Z",
  );
}
const edge = (db: Db, from: string, to: string) =>
  db.prepare("SELECT confidence, chain_support, source, removed, relation FROM concept_edges WHERE from_concept = ? AND to_concept = ?").get(from, to) as
    | { confidence: string; chain_support: number; source: string; removed: number; relation: string }
    | undefined;

function standardChains(db: Db): void {
  chain(db, "ch1", ["a1", "a2"], "b1"); // A→B (two premises from A: counts as ONE chain)
  chain(db, "ch2", ["a1"], "b2"); // A→B
  chain(db, "ch3", ["a3"], "b1"); // A→B  → 3 cadenas
  chain(db, "ch4", ["a1"], "c1"); // A→C
  chain(db, "ch5", ["a2"], "c2"); // A→C  → 2
  chain(db, "ch6", ["b1"], "d1"); // B→D
  chain(db, "ch7", ["c1", "b2"], "d1"); // C→D and B→D → B→D 2, C→D 1
  chain(db, "ch8", ["c1"], "c2"); // same concept: ignored
  chain(db, "ch9", ["e1"], "d1", 1); // deleted: ignored
}

describe("edges-derive", () => {
  it("support from distinct chains and confidence 3→high, 2→medium, 1→low", async () => {
    const ctx = makeTestContext();
    seed(ctx.db);
    standardChains(ctx.db);
    const r = await runEdgesDerive(ctx);
    expect(edge(ctx.db, "c_A", "c_B")).toEqual({ confidence: "high", chain_support: 3, source: "derived", removed: 0, relation: "requires" });
    expect(edge(ctx.db, "c_A", "c_C")).toMatchObject({ confidence: "medium", chain_support: 2, source: "derived" });
    expect(edge(ctx.db, "c_B", "c_D")).toMatchObject({ confidence: "medium", chain_support: 2, source: "derived" });
    expect(edge(ctx.db, "c_C", "c_D")).toMatchObject({ confidence: "low", chain_support: 1, source: "derived" });
    expect(edge(ctx.db, "c_E", "c_D")).toBeUndefined(); // deleted chain
    expect(count(ctx.db, "SELECT count(*) FROM concept_edges")).toBe(4); // no edges within the same concept
    expect(r.edges).toBe(4);
    expect(r.removedForCycles).toBe(0);
  });

  it("4 chains are still high and repeated execution gives the same result", async () => {
    const ctx = makeTestContext();
    seed(ctx.db);
    standardChains(ctx.db);
    chain(ctx.db, "ch10", ["a2"], "b2");
    await runEdgesDerive(ctx);
    const first = ctx.db.prepare("SELECT * FROM concept_edges ORDER BY from_concept, to_concept").all();
    await runEdgesDerive(ctx);
    expect(ctx.db.prepare("SELECT * FROM concept_edges ORDER BY from_concept, to_concept").all()).toEqual(first);
    expect(edge(ctx.db, "c_A", "c_B")).toMatchObject({ confidence: "high", chain_support: 4 });
  });

  it("does not touch manual edges or removed=1", async () => {
    const ctx = makeTestContext();
    seed(ctx.db);
    standardChains(ctx.db);
    seedEdge(ctx.db, "c_C", "c_B", "high", "manual"); // seeded support of 3
    chain(ctx.db, "ch11", ["c2"], "b1"); // would give C→B with 1 chain
    ctx.db.prepare("INSERT INTO concept_edges (from_concept, to_concept, confidence, chain_support, source, removed) VALUES ('c_A','c_D','low',0,'derived',1)").run();
    chain(ctx.db, "ch12", ["a1"], "d1"); // would give A→D
    chain(ctx.db, "ch13", ["a2"], "d1");
    await runEdgesDerive(ctx);
    expect(edge(ctx.db, "c_C", "c_B")).toEqual({ confidence: "high", chain_support: 3, source: "manual", removed: 0, relation: "requires" });
    expect(edge(ctx.db, "c_A", "c_D")).toEqual({ confidence: "low", chain_support: 0, source: "derived", removed: 1, relation: "requires" });
  });

  it("a curator edge with support becomes derived and is upgraded; without support it stays curator/low", async () => {
    const ctx = makeTestContext();
    seed(ctx.db);
    standardChains(ctx.db);
    ctx.db.prepare("INSERT INTO concept_edges (from_concept, to_concept, confidence, chain_support, source) VALUES ('c_A','c_B','low',0,'curator')").run();
    ctx.db.prepare("INSERT INTO concept_edges (from_concept, to_concept, confidence, chain_support, source) VALUES ('c_D','c_E','low',0,'curator')").run();
    await runEdgesDerive(ctx);
    expect(edge(ctx.db, "c_A", "c_B")).toMatchObject({ source: "derived", confidence: "high", chain_support: 3 });
    expect(edge(ctx.db, "c_D", "c_E")).toMatchObject({ source: "curator", confidence: "low", chain_support: 0, removed: 0 });
  });

  it("a cycle removes the edge with less support and counts it", async () => {
    const ctx = makeTestContext();
    seed(ctx.db);
    chain(ctx.db, "k1", ["a1"], "b1");
    chain(ctx.db, "k2", ["a2"], "b2"); // A→B support 2
    chain(ctx.db, "k3", ["b1"], "a3"); // B→A support 1
    const r = await runEdgesDerive(ctx);
    expect(r.removedForCycles).toBe(1);
    expect(edge(ctx.db, "c_A", "c_B")).toMatchObject({ confidence: "medium", chain_support: 2, removed: 0 });
    expect(count(ctx.db, "SELECT count(*) FROM concept_edges WHERE from_concept = 'c_B' AND to_concept = 'c_A' AND removed = 0")).toBe(0);
  });

  it("the 'edges-derive' handler works", async () => {
    const ctx = makeTestContext();
    seed(ctx.db);
    standardChains(ctx.db);
    await handlers["edges-derive"]!(ctx, { id: "j", type: "edges-derive", payload: {}, status: "running", attempts: 1, runAfter: "", lastError: null });
    expect(count(ctx.db, "SELECT count(*) FROM concept_edges")).toBe(4);
  });
});
