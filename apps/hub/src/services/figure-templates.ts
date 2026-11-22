// ADR 108: classroom TikZ templates (embedded; optionally from packages/latex/templates/figures/).
import type { FigureFamily, FigureTemplate } from "@graphharness/contracts";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_FIGURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "packages", "latex", "templates", "figures");

// five minimal templates in the repo; if .tex files exist in packages/latex/templates/figures/, they are loaded on top.
const EMBEDDED: FigureTemplate[] = [
  {
    id: "geometry-right-triangle",
    family: "geometry",
    title: "Right triangle with labels",
    description: "Legs and hypotenuse with named vertices.",
    libraries: ["calc"],
    tikz: String.raw`\draw (0,0) -- (3,0) -- (0,2) -- cycle;
\node[below] at (1.5,0) {$a$};
\node[left] at (0,1) {$b$};
\node[above right] at (1.2,1.4) {$c$};`,
  },
  {
    id: "axes-parabola",
    family: "axes",
    title: "Axes and parabola",
    description: "Basic Cartesian system with a quadratic curve.",
    libraries: [],
    tikz: String.raw`\draw[->] (-0.5,0) -- (3.5,0) node[right] {$x$};
\draw[->] (0,-0.5) -- (0,3.5) node[above] {$y$};
\draw[domain=0:3, smooth, variable=\x] plot ({\x}, {0.3*\x*\x});`,
  },
  {
    id: "venn-two-sets",
    family: "venn",
    title: "Venn diagram (two sets)",
    description: "Two overlapping circles labelled A and B.",
    libraries: [],
    tikz: String.raw`\draw[fill=blue!10] (0,0) circle (1.2);
\draw[fill=red!10] (1.5,0) circle (1.2);
\node at (-0.5,0) {$A$};
\node at (2,0) {$B$};`,
  },
  {
    id: "tree-binary",
    family: "tree",
    title: "Simple binary tree",
    description: "Three levels for classification or decision.",
    libraries: ["positioning"],
    tikz: String.raw`\node (r) at (0,2) {$\\bullet$};
\node[below left=1cm and 0.8cm of r] (l) {$\\bullet$};
\node[below right=1cm and 0.8cm of r] (d) {$\\bullet$};
\draw (r) -- (l) (r) -- (d);`,
  },
  {
    id: "flowchart-linear",
    family: "flowchart",
    title: "Linear flow",
    description: "Input → process → output.",
    libraries: ["arrows.meta", "positioning", "shapes.geometric"],
    tikz: String.raw`\node[draw, rounded corners, minimum width=2cm] (in) {Entrada};
\node[draw, rounded corners, minimum width=2cm, below=1cm of in] (proc) {Proceso};
\node[draw, rounded corners, minimum width=2cm, below=1cm of proc] (out) {Salida};
\draw[-{Stealth}] (in) -- (proc) (proc) -- (out);`,
  },
];

function fromTexFiles(): FigureTemplate[] {
  if (!existsSync(REPO_FIGURES_DIR)) return [];
  const out: FigureTemplate[] = [];
  for (const name of readdirSync(REPO_FIGURES_DIR).filter((f) => f.endsWith(".tex")).sort()) {
    const stem = name.slice(0, -4);
    const family = (["geometry", "axes", "venn", "tree", "flowchart"].includes(stem.split("-")[0]!)
      ? stem.split("-")[0]
      : "custom") as FigureFamily;
    const raw = readFileSync(join(REPO_FIGURES_DIR, name), "utf8");
    const libMatch = raw.match(/%\s*libraries:\s*(.+)/i);
    const libraries = libMatch
      ? libMatch[1]!
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    const tikz = raw
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("%"))
      .join("\n")
      .trim();
    out.push({
      id: stem,
      family,
      title: stem.replace(/-/g, " "),
      description: `Template ${stem} (packages/latex/templates/figures).`,
      libraries,
      tikz,
    });
  }
  return out;
}

const ALL_TEMPLATES: FigureTemplate[] = (() => {
  // Disk wins by id; embedded ones fill gaps (distinct ids such as geometry-right-triangle).
  const disk = fromTexFiles();
  const ids = new Set(disk.map((t) => t.id));
  return [...disk, ...EMBEDDED.filter((t) => !ids.has(t.id))];
})();

export function listTemplates(family?: FigureFamily): FigureTemplate[] {
  return family ? ALL_TEMPLATES.filter((t) => t.family === family) : [...ALL_TEMPLATES];
}
