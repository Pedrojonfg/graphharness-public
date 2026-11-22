// MCP tools of ADR 108: compile_tikz_fragment, save_figure, list_figure_templates.
import { CompileTikzBodySchema, FigureFamilySchema, SaveFigureBodySchema } from "@graphharness/contracts";
import { z } from "zod";
import { compileTikz, listTemplates, saveFigure } from "../services/figures.ts";
import type { McpHandlers } from "./types.ts";

export const figuresTools: McpHandlers = {
  compile_tikz_fragment: (ctx, input) => compileTikz(ctx, CompileTikzBodySchema.parse(input)),
  save_figure: (ctx, input) => saveFigure(ctx, SaveFigureBodySchema.parse(input)),
  list_figure_templates: async (_ctx, input) => {
    const { family } = z.object({ family: FigureFamilySchema.optional() }).parse(input ?? {});
    return { templates: listTemplates(family) };
  },
};
