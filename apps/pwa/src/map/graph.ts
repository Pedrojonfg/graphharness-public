// Ported from the GraphLearn web app (65b56d6; see docs/PROVENANCE.md): `layoutGraph` and `relations`, over contracts' SubjectMap.
import { Graph, layout } from "@dagrejs/dagre";
import type { MapConcept, SubjectMap } from "@graphharness/contracts";

export const NODE_WIDTH = 176;
export const NODE_HEIGHT = 52;

/** Lays concepts out in layers: prerequisites on top, what needs them below. */
export function layoutGraph(map: Pick<SubjectMap, "concepts" | "edges">): Map<string, { x: number; y: number }> {
  const g = new Graph();
  g.setGraph({ rankdir: "TB", nodesep: 20, ranksep: 64, marginx: 16, marginy: 16 });
  g.setDefaultEdgeLabel(() => ({}));
  const ids = new Set(map.concepts.map((c) => c.id));
  for (const c of map.concepts) g.setNode(c.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const e of map.edges) if (ids.has(e.from) && ids.has(e.to)) g.setEdge(e.from, e.to);
  layout(g);
  const positions = new Map<string, { x: number; y: number }>();
  for (const c of map.concepts) {
    const { x, y } = g.node(c.id);
    // dagre returns the center; React Flow expects the top-left corner.
    positions.set(c.id, { x: x - NODE_WIDTH / 2, y: y - NODE_HEIGHT / 2 });
  }
  return positions;
}

/** Direct prerequisites and the concepts it unlocks (`requires` edges). */
export function relations(map: Pick<SubjectMap, "concepts" | "edges">, id: string): { before: MapConcept[]; unlocks: MapConcept[] } {
  const byId = new Map(map.concepts.map((c) => [c.id, c]));
  const pick = (xs: string[]) => xs.map((x) => byId.get(x)).filter((c): c is MapConcept => Boolean(c));
  const req = map.edges.filter((e) => e.relation === "requires");
  return {
    before: pick(req.filter((e) => e.to === id).map((e) => e.from)),
    unlocks: pick(req.filter((e) => e.from === id).map((e) => e.to)),
  };
}
