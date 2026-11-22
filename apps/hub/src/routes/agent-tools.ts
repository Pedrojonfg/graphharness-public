// REST routes of the LH agent's tools under /api/v1 (ADR 105 §5). The logic lives in services/agent-tools.ts.
import { CaptureBodySchema, ErrorsQuerySchema, LensFeedbackBodySchema, LensFeedbackQuerySchema } from "@graphharness/contracts";
import type { Hono } from "hono";
import { jsonBody, query } from "../http.ts";
import { capture, conceptErrors, profile } from "../services/agent-tools.ts";
import { listLensFeedback, saveLensFeedback } from "../services/lens-feedback.ts";
import type { HubContext } from "../services/context.ts";

export function registerAgentToolsRoutes(api: Hono, ctx: HubContext): void {
  api.get("/errors", (c) => c.json(conceptErrors(ctx, query(c, ErrorsQuerySchema))));
  api.get("/profile", (c) => c.json(profile(ctx)));
  api.post("/capture", async (c) => c.json(await capture(ctx, await jsonBody(c, CaptureBodySchema)), 201));
  api.get("/lens-feedback", async (c) => c.json(await listLensFeedback(ctx, query(c, LensFeedbackQuerySchema))));
  api.post("/lens-feedback", async (c) => c.json(await saveLensFeedback(ctx, await jsonBody(c, LensFeedbackBodySchema)), 201));
}
