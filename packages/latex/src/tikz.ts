// Ported from graphlearn/apps/worker/src/pdf/latex.ts (65b56d6): graphTikz.
// Changes: takes a `TikzGraph` (`id`) instead of GL's `graphSnapshot` (`nodeId`).
import { escapeLatex } from "./escape.ts";
import type { TikzGraph } from "./types.ts";

/** State colors defined in the templates: `fill=<color>` on each node. */
export const STATE_COLOR = { solid: "solid", review: "review", weak: "weak", unknown: "unknown" } as const;

/** TikZ graph by prerequisite layers (the basics on top). One `\node` per concept, one `\draw` per edge with both ends. */
export function graphTikz(graph: TikzGraph): string {
  const ids = graph.nodes.map((n) => n.id);
  const known = new Set(ids);
  const parents = new Map<string, string[]>();
  for (const e of graph.edges) parents.set(e.to, [...(parents.get(e.to) ?? []), e.from]);
  const layer = new Map<string, number>();
  const depth = (id: string, seen = new Set<string>()): number => {
    const cached = layer.get(id);
    if (cached !== undefined) return cached;
    if (seen.has(id)) return 0; // cycle: cut here
    seen.add(id);
    const d = Math.max(-1, ...(parents.get(id) ?? []).filter((p) => known.has(p)).map((p) => depth(p, seen))) + 1;
    layer.set(id, d);
    return d;
  };
  ids.forEach((id) => depth(id));
  const rows = new Map<number, string[]>();
  for (const id of ids) {
    const l = layer.get(id)!;
    rows.set(l, [...(rows.get(l) ?? []), id]);
  }
  const key = new Map(ids.map((id, i) => [id, `n${i}`]));
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const lines: string[] = [];
  for (const [l, row] of [...rows.entries()].sort((a, b) => a[0] - b[0])) {
    row.forEach((id, i) => {
      const n = byId.get(id)!;
      const x = ((i - (row.length - 1) / 2) * 3.6).toFixed(2);
      const y = (-l * 1.7).toFixed(2);
      const name = escapeLatex(n.name.length > 60 ? `${n.name.slice(0, 57)}…` : n.name);
      lines.push(`  \\node[node, fill=${STATE_COLOR[n.state]}] (${key.get(id)}) at (${x},${y}) {${name}};`);
    });
  }
  const drawn = new Set<string>();
  for (const e of graph.edges) {
    const from = key.get(e.from);
    const to = key.get(e.to);
    if (!from || !to || drawn.has(`${from}>${to}`)) continue;
    drawn.add(`${from}>${to}`);
    lines.push(`  \\draw[pre] (${from}) -- (${to});`);
  }
  return [
    "\\begin{tikzpicture}[",
    "  node/.style={draw=black!40, rounded corners, minimum height=0.9cm, text width=3.1cm, align=center, font=\\scriptsize},",
    "  pre/.style={-{Stealth[length=2mm]}, gray!70!black}]",
    ...lines,
    "\\end{tikzpicture}",
  ].join("\n");
}
