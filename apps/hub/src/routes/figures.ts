// REST routes of ADR 108: templates, compile, save and read TikZ figures.
import { CompileTikzBodySchema, FigureFamilySchema, SaveFigureBodySchema } from "@graphharness/contracts";
import type { Hono } from "hono";
import { existsSync, readFileSync } from "node:fs";
import { jsonBody } from "../http.ts";
import { notFound } from "../errors.ts";
import type { HubContext } from "../services/context.ts";
import { compileTikz, getFigure, listTemplates, saveFigure } from "../services/figures.ts";

export function registerFiguresRoutes(api: Hono, ctx: HubContext): void {
  api.get("/figures/templates", (c) => {
    const raw = c.req.query("family");
    const family = raw === undefined || raw === "" ? undefined : FigureFamilySchema.parse(raw);
    return c.json({ templates: listTemplates(family) });
  });
  api.post("/figures/compile", async (c) => c.json(await compileTikz(ctx, await jsonBody(c, CompileTikzBodySchema))));
  api.post("/figures", async (c) => c.json(await saveFigure(ctx, await jsonBody(c, SaveFigureBodySchema)), 201));
  api.get("/figures/:id/svg", (c) => {
    const fig = getFigure(ctx, c.req.param("id"));
    if (!fig.svgPath || !existsSync(fig.svgPath)) throw notFound();
    // Same idea as the report PDF: bytes in memory (small SVGs).
    return c.body(readFileSync(fig.svgPath), 200, {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "private, max-age=3600",
    });
  });
  api.get("/figures/:id", (c) => c.json(getFigure(ctx, c.req.param("id"))));
}
