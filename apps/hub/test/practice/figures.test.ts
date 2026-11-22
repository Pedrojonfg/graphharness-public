// ADR 108 — templates and MCP wiring (without pdflatex).
import { MCP_TOOLS, FigureTemplateSchema } from "@graphharness/contracts";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.ts";
import { figuresTools } from "../../src/mcp/figures.ts";
import { makeTestContext } from "../../src/testing.ts";

describe("figures (ADR 108)", () => {
  it("figuresTools exposes compile_tikz_fragment, save_figure, list_figure_templates", () => {
    for (const n of ["compile_tikz_fragment", "save_figure", "list_figure_templates"] as const) expect(figuresTools[n]).toBeTypeOf("function");
  });

  it("list_figure_templates → 5 families and validates the contract", async () => {
    const ctx = makeTestContext();
    const def = MCP_TOOLS.find((t) => t.name === "list_figure_templates")!;
    const out = def.output.parse(await figuresTools.list_figure_templates!(ctx, {}));
    expect(out.templates.length).toBeGreaterThanOrEqual(5);
    for (const t of out.templates) FigureTemplateSchema.parse(t);
    const families = new Set(out.templates.map((t) => t.family));
    for (const f of ["geometry", "axes", "venn", "tree", "flowchart"]) expect(families).toContain(f);
  });

  it("GET /api/v1/figures/templates", async () => {
    const app = createApp(makeTestContext(), { pwaDist: "/nonexistent" });
    const res = await app.request("/api/v1/figures/templates");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { templates: unknown[] };
    expect(body.templates.length).toBeGreaterThanOrEqual(5);
  });
});
