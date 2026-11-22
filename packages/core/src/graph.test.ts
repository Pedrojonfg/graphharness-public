// Contract tests for graph.ts (ADR 102 point 7).
import { describe, expect, it } from "vitest";
import { deriveEdges, dependentsCount, weakPrerequisites, type ChainLike, type ConceptEdge } from "./graph.ts";
import type { ConceptState } from "./state.ts";

/** A → B: "B requires A". */
const req = (from: string, to: string, extra: Partial<ConceptEdge> = {}): ConceptEdge => ({
  from,
  to,
  relation: "requires",
  confidence: "high",
  ...extra,
});

const states = (m: Record<string, ConceptState>, fallback: ConceptState = "weak") => (id: string): ConceptState => m[id] ?? fallback;

describe("weakPrerequisites", () => {
  it("reaches depth 3 but not 4; path [ancestor, …, concept]", () => {
    const edges = [req("D1", "X"), req("D2", "D1"), req("D3", "D2"), req("D4", "D3")];
    expect(weakPrerequisites("X", edges, states({}))).toEqual([
      { conceptId: "D1", state: "weak", path: ["D1", "X"] },
      { conceptId: "D2", state: "weak", path: ["D2", "D1", "X"] },
      { conceptId: "D3", state: "weak", path: ["D3", "D2", "D1", "X"] },
    ]);
  });

  it("maxDepth limits the depth", () => {
    const edges = [req("D1", "X"), req("D2", "D1")];
    expect(weakPrerequisites("X", edges, states({}), 1).map((w) => w.conceptId)).toEqual(["D1"]);
  });

  it("ignores removed, low and illustrates edges (and does not traverse them)", () => {
    const edges = [
      req("R", "X", { removed: true }),
      req("L", "X", { confidence: "low" }),
      req("I", "X", { relation: "illustrates" }),
      req("RR", "R"),
      req("LL", "L"),
      req("II", "I"),
      req("M", "X", { confidence: "medium" }),
    ];
    expect(weakPrerequisites("X", edges, states({})).map((w) => w.conceptId)).toEqual(["M"]);
  });

  it("includes weak/review/unknown, excludes solid but keeps climbing through it", () => {
    const edges = [req("S", "X"), req("W", "X"), req("U", "X"), req("V", "S"), req("S2", "S")];
    const r = weakPrerequisites("X", edges, states({ S: "solid", W: "weak", U: "unknown", V: "review", S2: "solid" }));
    expect(r).toEqual([
      { conceptId: "W", state: "weak", path: ["W", "X"] },
      { conceptId: "U", state: "unknown", path: ["U", "X"] },
      { conceptId: "V", state: "review", path: ["V", "S", "X"] },
    ]);
  });

  it("returns the shortest path even if the long one appears first in `edges`", () => {
    const edges = [req("C", "Y"), req("Y", "B"), req("B", "X"), req("C", "A"), req("A", "X")];
    const r = weakPrerequisites("X", edges, states({ A: "solid", B: "solid", Y: "solid" }));
    expect(r).toEqual([{ conceptId: "C", state: "weak", path: ["C", "A", "X"] }]);
  });

  it("diamond: an ancestor appears once; tie → first in BFS according to `edges` order", () => {
    const edges = [req("D", "A"), req("D", "B"), req("A", "X"), req("B", "X")];
    const r = weakPrerequisites("X", edges, states({}));
    expect(r).toEqual([
      { conceptId: "A", state: "weak", path: ["A", "X"] },
      { conceptId: "B", state: "weak", path: ["B", "X"] },
      { conceptId: "D", state: "weak", path: ["D", "A", "X"] },
    ]);
  });

  it("tie with the `edges` order reversed picks the other path", () => {
    const edges = [req("D", "B"), req("D", "A"), req("B", "X"), req("A", "X")];
    const r = weakPrerequisites("X", edges, states({}));
    expect(r.map((w) => w.conceptId)).toEqual(["B", "A", "D"]);
    expect(r[2]!.path).toEqual(["D", "B", "X"]);
  });

  it("cycle in the graph: terminates and never includes the concept itself", () => {
    const edges = [req("A", "X"), req("X", "A"), req("B", "A"), req("A", "B")];
    const r = weakPrerequisites("X", edges, states({}));
    expect(r).toEqual([
      { conceptId: "A", state: "weak", path: ["A", "X"] },
      { conceptId: "B", state: "weak", path: ["B", "A", "X"] },
    ]);
  });

  it("sorts by depth even if `edges` lists the deep ones first", () => {
    const edges = [req("P3", "P2"), req("P2", "P1"), req("P1", "X"), req("Q1", "X")];
    const r = weakPrerequisites("X", edges, states({}));
    expect(r.map((w) => w.conceptId)).toEqual(["P1", "Q1", "P2", "P3"]);
  });

  it("does not follow edges toward dependents (only ancestors)", () => {
    const edges = [req("X", "Child"), req("Parent", "X")];
    expect(weakPrerequisites("X", edges, states({})).map((w) => w.conceptId)).toEqual(["Parent"]);
  });

  it("no ancestors → []", () => {
    expect(weakPrerequisites("X", [req("X", "Y")], states({}))).toEqual([]);
  });
});

describe("dependentsCount", () => {
  it("transitive, no duplicates in a diamond, does not count itself (even with a cycle)", () => {
    const edges = [req("A", "B"), req("B", "C"), req("A", "D"), req("D", "C"), req("C", "A")];
    expect(dependentsCount("A", edges)).toBe(3);
  });

  it("filters out low, removed and illustrates (and does not traverse them)", () => {
    const edges = [
      req("A", "B"),
      req("A", "E", { confidence: "low" }),
      req("A", "F", { removed: true }),
      req("A", "G", { relation: "illustrates" }),
      req("E", "E2"),
      req("F", "F2"),
      req("G", "G2"),
      req("B", "M", { confidence: "medium" }),
    ];
    expect(dependentsCount("A", edges)).toBe(2);
  });

  it("does not count ancestors", () => {
    expect(dependentsCount("B", [req("A", "B"), req("B", "C")])).toBe(1);
  });

  it("scope: only dependents within the scope are counted", () => {
    const edges = [req("A", "B"), req("B", "C"), req("A", "D")];
    expect(dependentsCount("A", edges, new Set(["B", "C"]))).toBe(2);
    // C is a transitive dependent (via B, outside the scope) and is inside: counted.
    expect(dependentsCount("A", edges, new Set(["A", "C"]))).toBe(1);
    expect(dependentsCount("A", edges, new Set())).toBe(0);
  });

  it("concept without dependents or unknown → 0", () => {
    expect(dependentsCount("Z", [req("A", "B")])).toBe(0);
    expect(dependentsCount("B", [req("A", "B")])).toBe(0);
  });
});

describe("deriveEdges", () => {
  const concepts: Record<string, string> = { a1: "A", a2: "A", b1: "B", b2: "B", c1: "C", d1: "D" };
  const conceptOf = (p: string): string | undefined => concepts[p];
  let n = 0;
  const chain = (premises: string[], conclusion: string): ChainLike => ({ id: `ch${++n}`, premises, conclusion });
  /** k chains a1 → conclusion. */
  const times = (k: number, premise: string, conclusion: string): ChainLike[] => Array.from({ length: k }, () => chain([premise], conclusion));

  it("two premises of the same concept in one chain add 1, not 2", () => {
    const r = deriveEdges({ chains: [chain(["a1", "a2"], "b1")], conceptOf });
    expect(r).toEqual({ edges: [{ from: "A", to: "B", chainSupport: 1, confidence: "low" }], removedForCycles: [] });
  });

  it("support = number of distinct chains", () => {
    const r = deriveEdges({ chains: [chain(["a1", "a2"], "b1"), chain(["a1"], "b2")], conceptOf });
    expect(r.edges).toEqual([{ from: "A", to: "B", chainSupport: 2, confidence: "medium" }]);
  });

  it("A == B generates no edge; the chain's other premises do", () => {
    const r = deriveEdges({ chains: [chain(["a1", "b1"], "a2")], conceptOf });
    expect(r.edges).toEqual([{ from: "B", to: "A", chainSupport: 1, confidence: "low" }]);
  });

  it("proposition without a concept is ignored (in premise or conclusion)", () => {
    const r = deriveEdges({ chains: [chain(["zz", "a1"], "b1"), chain(["a1"], "zz")], conceptOf });
    expect(r.edges).toEqual([{ from: "A", to: "B", chainSupport: 1, confidence: "low" }]);
  });

  it("no chains → empty", () => {
    expect(deriveEdges({ chains: [], conceptOf })).toEqual({ edges: [], removedForCycles: [] });
  });

  it("confidence: 1 low, 2 medium, 3 high, 4 high", () => {
    const r = deriveEdges({
      chains: [...times(1, "a1", "b1"), ...times(2, "a1", "c1"), ...times(3, "a1", "d1"), ...times(4, "b1", "c1")],
      conceptOf,
    });
    expect(r.edges).toEqual([
      { from: "A", to: "B", chainSupport: 1, confidence: "low" },
      { from: "A", to: "C", chainSupport: 2, confidence: "medium" },
      { from: "A", to: "D", chainSupport: 3, confidence: "high" },
      { from: "B", to: "C", chainSupport: 4, confidence: "high" },
    ]);
  });

  it("output sorted by `${from}->${to}` (lexicographic, not numeric)", () => {
    const ids: Record<string, string> = { p9: "n9", p10: "n10", px: "x" };
    // Input in order n9, n10; "n10->x" < "n9->x" in lexicographic order.
    const r = deriveEdges({ chains: [chain(["p9"], "px"), chain(["p10"], "px")], conceptOf: (p) => ids[p] });
    expect(r.edges.map((e) => `${e.from}->${e.to}`)).toEqual(["n10->x", "n9->x"]);
    expect(r.removedForCycles).toEqual([]);
  });

  it("tie in cycle with ids n9/n10/x: removes the lexicographically smallest", () => {
    const ids: Record<string, string> = { p9: "n9", p10: "n10", px: "x" };
    // Cycle x→n9→n10→x, all support 1. Keys: "x->n9", "n9->n10", "n10->x"; the smallest is "n10->x".
    const r = deriveEdges({ chains: [chain(["px"], "p9"), chain(["p9"], "p10"), chain(["p10"], "px")], conceptOf: (p) => ids[p] });
    expect(r.removedForCycles.map((e) => `${e.from}->${e.to}`)).toEqual(["n10->x"]);
    expect(r.edges.map((e) => `${e.from}->${e.to}`)).toEqual(["n9->n10", "x->n9"]);
  });

  it("cycle A↔B: removes the one with lower support and returns it", () => {
    const r = deriveEdges({ chains: [...times(2, "a1", "b1"), ...times(1, "b1", "a1")], conceptOf });
    expect(r.edges).toEqual([{ from: "A", to: "B", chainSupport: 2, confidence: "medium" }]);
    expect(r.removedForCycles).toEqual([{ from: "B", to: "A", chainSupport: 1, confidence: "low" }]);
  });

  it("support tie → removes the smallest by `${from}->${to}`", () => {
    const r = deriveEdges({ chains: [...times(1, "b1", "a1"), ...times(1, "a1", "b1")], conceptOf });
    expect(r.edges).toEqual([{ from: "B", to: "A", chainSupport: 1, confidence: "low" }]);
    expect(r.removedForCycles).toEqual([{ from: "A", to: "B", chainSupport: 1, confidence: "low" }]);
  });

  it("removes the minimum OF THE CYCLE, not the global minimum; lexicographic tie", () => {
    // Cycle A→B(3) → B→C(2) → C→A(2); D→A(1) outside the cycle.
    const r = deriveEdges({
      chains: [...times(3, "a1", "b1"), ...times(2, "b1", "c1"), ...times(2, "c1", "a1"), ...times(1, "d1", "a1")],
      conceptOf,
    });
    expect(r.removedForCycles).toEqual([{ from: "B", to: "C", chainSupport: 2, confidence: "medium" }]);
    expect(r.edges.map((e) => `${e.from}->${e.to}`)).toEqual(["A->B", "C->A", "D->A"]);
  });

  it("an edge shared by two cycles: only that one is removed", () => {
    // A→B(1) is in A→B→A and in A→B→C→A.
    const r = deriveEdges({
      chains: [...times(1, "a1", "b1"), ...times(3, "b1", "a1"), ...times(3, "b1", "c1"), ...times(3, "c1", "a1")],
      conceptOf,
    });
    expect(r.removedForCycles).toEqual([{ from: "A", to: "B", chainSupport: 1, confidence: "low" }]);
    expect(r.edges.map((e) => `${e.from}->${e.to}`)).toEqual(["B->A", "B->C", "C->A"]);
  });

  it("two disjoint cycles: breaks both", () => {
    const r = deriveEdges({
      chains: [...times(2, "a1", "b1"), ...times(1, "b1", "a1"), ...times(1, "c1", "d1"), ...times(3, "d1", "c1")],
      conceptOf,
    });
    expect(r.edges.map((e) => `${e.from}->${e.to}`)).toEqual(["A->B", "D->C"]);
    expect(r.removedForCycles.map((e) => `${e.from}->${e.to}`).sort()).toEqual(["B->A", "C->D"]);
  });

  it("cycle closed by a `fixed` edge: removes the derived one (even if it has more support) and does not return the fixed one", () => {
    const r = deriveEdges({ chains: times(5, "a1", "b1"), conceptOf, fixed: [{ from: "B", to: "A" }] });
    expect(r.edges).toEqual([]);
    expect(r.removedForCycles).toEqual([{ from: "A", to: "B", chainSupport: 5, confidence: "high" }]);
  });

  it("cycle made only of `fixed` edges: does not hang nor remove anything", () => {
    const r = deriveEdges({
      chains: times(1, "c1", "d1"),
      conceptOf,
      fixed: [
        { from: "A", to: "B" },
        { from: "B", to: "A" },
      ],
    });
    expect(r).toEqual({ edges: [{ from: "C", to: "D", chainSupport: 1, confidence: "low" }], removedForCycles: [] });
  });

  it("a cycle of only `fixed` edges does not prevent breaking another derived cycle", () => {
    const r = deriveEdges({
      chains: [...times(2, "c1", "d1"), ...times(1, "d1", "c1")],
      conceptOf,
      fixed: [
        { from: "A", to: "B" },
        { from: "B", to: "A" },
      ],
    });
    expect(r.edges).toEqual([{ from: "C", to: "D", chainSupport: 2, confidence: "medium" }]);
    expect(r.removedForCycles).toEqual([{ from: "D", to: "C", chainSupport: 1, confidence: "low" }]);
  });

  it("derived pair that matches a fixed one is returned anyway", () => {
    const r = deriveEdges({ chains: times(2, "a1", "b1"), conceptOf, fixed: [{ from: "A", to: "B" }] });
    expect(r.edges).toEqual([{ from: "A", to: "B", chainSupport: 2, confidence: "medium" }]);
    expect(r.removedForCycles).toEqual([]);
  });
});
