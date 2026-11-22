// Concept graph (pure, no LLM): weak-prerequisite detection and edges derived from LH chains.
import type { ConceptState } from "./state.ts";

export type EdgeConfidence = "high" | "medium" | "low";

/** A → B: "B requires A" (like `conceptedges`). */
export interface ConceptEdge {
  from: string;
  to: string;
  relation: "requires" | "illustrates";
  confidence: EdgeConfidence;
  /** Removed by hand: counts for nothing. */
  removed?: boolean;
}

export interface WeakPrerequisite {
  conceptId: string;
  state: ConceptState;
  /** Shortest path [ancestor, …, conceptId]. */
  path: string[];
}

/**
 * Ancestors following `requires` edges, not `removed`, with confidence ≠ 'low', up to depth 3
 * (direct ancestor = depth 1), whose effective state is weak, review or unknown.
 * One per ancestor (shortest path; ties → the first in BFS order over `edges`).
 * Result order: by ascending depth, then by discovery order. Never includes the concept itself.
 */
export function weakPrerequisites(
  conceptId: string,
  edges: readonly ConceptEdge[],
  stateOf: (conceptId: string) => ConceptState,
  maxDepth = 3,
): WeakPrerequisite[] {
  const usable = edges.filter((e) => e.relation === "requires" && !e.removed && e.confidence !== "low");
  const parent = new Map<string, string>(); // ancestor → concept it was discovered from (towards conceptId)
  const seen = new Set([conceptId]);
  const result: WeakPrerequisite[] = [];
  let level = [conceptId];
  for (let depth = 1; depth <= maxDepth && level.length; depth++) {
    const next: string[] = [];
    for (const id of level) {
      for (const e of usable) {
        if (e.to !== id || seen.has(e.from)) continue;
        seen.add(e.from);
        parent.set(e.from, id);
        next.push(e.from);
        const state = stateOf(e.from);
        if (state === "solid") continue;
        const path = [e.from];
        for (let p = parent.get(e.from); p !== undefined; p = parent.get(p)) path.push(p);
        result.push({ conceptId: e.from, state, path });
      }
    }
    level = next;
  }
  return result;
}

/**
 * Number of concepts that (transitively) depend on `conceptId`, via `requires` edges that are not `removed` and not 'low'.
 * If `scope` is passed, only dependents inside it are counted.
 */
export function dependentsCount(conceptId: string, edges: readonly ConceptEdge[], scope?: ReadonlySet<string>): number {
  const usable = edges.filter((e) => e.relation === "requires" && !e.removed && e.confidence !== "low");
  const seen = new Set([conceptId]);
  const queue = [conceptId];
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    for (const e of usable) {
      if (e.from !== id || seen.has(e.to)) continue;
      seen.add(e.to);
      queue.push(e.to);
    }
  }
  seen.delete(conceptId);
  return scope ? [...seen].filter((id) => scope.has(id)).length : seen.size;
}

export interface ChainLike {
  id: string;
  premises: string[];
  conclusion: string;
}

export interface DerivedEdge {
  from: string;
  to: string;
  /** Number of distinct chains that support it. */
  chainSupport: number;
  confidence: EdgeConfidence;
}

/**
 * For each chain, each pair (concept of a premise A, concept of the conclusion B) with A ≠ B
 * adds 1 to the support of A→B — once per chain (support = number of chains). Propositions without a concept are ignored.
 * Confidence: ≥3 high, 2 medium, 1 low.
 * Cycles: while the graph (derived + `fixed`) has a cycle, the DERIVED edge with the least support is removed from the cycle
 * (tie: the lexicographically smallest `${from}->${to}`). The `fixed` edges (the ones the job does not touch: manual source or removed=1) are never removed
 * and are not returned. If a derived pair matches a fixed one, it is returned anyway (the caller decides whether to write it).
 * Result sorted by `${from}->${to}`.
 */
export function deriveEdges(input: {
  chains: readonly ChainLike[];
  conceptOf: (propositionId: string) => string | undefined;
  fixed?: readonly { from: string; to: string }[];
}): { edges: DerivedEdge[]; removedForCycles: DerivedEdge[] } {
  const support = new Map<string, number>();
  for (const chain of input.chains) {
    const premises = new Set(chain.premises.map(input.conceptOf).filter((c): c is string => c !== undefined));
    const conclusion = input.conceptOf(chain.conclusion);
    if (conclusion === undefined) continue;
    for (const a of premises) if (a !== conclusion) support.set(`${a}->${conclusion}`, (support.get(`${a}->${conclusion}`) ?? 0) + 1);
  }
  const pair = new Map<string, { from: string; to: string }>();
  for (const chain of input.chains) {
    // keys contain `->`; we store from/to separately so we don't depend on parsing ids
    for (const p of chain.premises) {
      const a = input.conceptOf(p);
      const b = input.conceptOf(chain.conclusion);
      if (a !== undefined && b !== undefined && a !== b) pair.set(`${a}->${b}`, { from: a, to: b });
    }
  }
  const derived = new Map<string, DerivedEdge>();
  for (const [key, n] of support) {
    const { from, to } = pair.get(key)!;
    derived.set(key, { from, to, chainSupport: n, confidence: n >= 3 ? "high" : n === 2 ? "medium" : "low" });
  }
  const fixed = (input.fixed ?? []).map((f) => ({ from: f.from, to: f.to }));
  const removedForCycles: DerivedEdge[] = [];

  // Shortest path `from` ⇒ `to` over derived + fixed edges, as a list of edges; null if there is none.
  const pathEdges = (from: string, to: string): { from: string; to: string }[] | null => {
    const all = [...derived.values(), ...fixed];
    const via = new Map<string, { from: string; to: string }>();
    const seen = new Set([from]);
    const queue = [from];
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      if (id === to) {
        const path: { from: string; to: string }[] = [];
        for (let e = via.get(to); e; e = via.get(e.from)) path.unshift(e);
        return path;
      }
      for (const e of all) {
        if (e.from !== id || seen.has(e.to)) continue;
        seen.add(e.to);
        via.set(e.to, e);
        queue.push(e.to);
      }
    }
    return null;
  };

  for (;;) {
    let cycle: { from: string; to: string }[] | null = null;
    for (const key of [...derived.keys()].sort()) {
      const e = derived.get(key)!;
      const back = pathEdges(e.to, e.from);
      if (back) {
        cycle = [e, ...back];
        break;
      }
    }
    if (!cycle) break;
    const candidates = cycle.map((e) => derived.get(`${e.from}->${e.to}`)).filter((e): e is DerivedEdge => e !== undefined);
    candidates.sort((a, b) => a.chainSupport - b.chainSupport || (`${a.from}->${a.to}` < `${b.from}->${b.to}` ? -1 : 1));
    const victim = candidates[0]!;
    derived.delete(`${victim.from}->${victim.to}`);
    removedForCycles.push(victim);
  }
  const byKey = (a: DerivedEdge, b: DerivedEdge) => (`${a.from}->${a.to}` < `${b.from}->${b.to}` ? -1 : 1);
  return { edges: [...derived.values()].sort(byKey), removedForCycles: removedForCycles.sort(byKey) };
}
