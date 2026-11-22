import { describe, expect, it } from "vitest";
import { graphTikz } from "./tikz.ts";
import type { TikzGraph } from "./types.ts";

const graph: TikzGraph = {
  nodes: [
    { id: "a", name: "Limits", state: "solid" },
    { id: "b", name: "Derivatives", state: "review" },
    { id: "c", name: "Integral_def", state: "weak" },
    { id: "d", name: "Series", state: "unknown" },
  ],
  edges: [
    { from: "a", to: "b" },
    { from: "b", to: "c" },
    { from: "z", to: "c" },
  ],
};

describe("graphTikz", () => {
  const tikz = graphTikz(graph);
  it("is a complete tikzpicture", () => {
    expect(tikz.startsWith("\\begin{tikzpicture}")).toBe(true);
    expect(tikz.trimEnd().endsWith("\\end{tikzpicture}")).toBe(true);
  });
  it("one node per concept with its state color", () => {
    const nodes = tikz.split("\n").filter((l) => l.includes("\\node"));
    expect(nodes).toHaveLength(4);
    expect(nodes.find((l) => l.includes("Limits"))).toContain("fill=solid");
    expect(nodes.find((l) => l.includes("Derivatives"))).toContain("fill=review");
    expect(nodes.find((l) => l.includes("Integral"))).toContain("fill=weak");
    expect(nodes.find((l) => l.includes("Series"))).toContain("fill=unknown");
  });
  it("escapes the names", () => {
    expect(tikz).toContain("Integral\\_def");
    expect(tikz).not.toMatch(/Integral_def/);
  });
  it("one edge per pair with both ends; ignores those pointing to a nonexistent node", () => {
    expect(tikz.split("\n").filter((l) => l.includes("\\draw"))).toHaveLength(2);
  });
  it("empty graph is still a valid tikzpicture", () => {
    const t = graphTikz({ nodes: [], edges: [] });
    expect(t).toContain("\\begin{tikzpicture}");
    expect(t).not.toContain("\\node");
  });
});
