// The Hub HTTP app: REST API (/api/v1), MCP (/mcp, loopback only + token) and the static PWA (/).
import { Hono, type Context } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { toErrorResponse } from "./errors.ts";
import { mountMcp } from "./mcp/server.ts";
import { registerAgentToolsRoutes } from "./routes/agent-tools.ts";
import { registerFiguresRoutes } from "./routes/figures.ts";
import { registerKnowledgeRoutes } from "./routes/knowledge.ts";
import { registerPracticeRoutes } from "./routes/practice.ts";
import { registerPriorRoutes } from "./routes/prior.ts";
import { registerSessionsRoutes } from "./routes/sessions.ts";
import type { HubContext } from "./services/context.ts";

const PWA_DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "pwa", "dist");

export function createApp(ctx: HubContext, opts: { pwaDist?: string } = {}): Hono {
  const app = new Hono();
  const onError = (err: Error, c: Context) => {
    const { status, body } = toErrorResponse(err);
    return c.json(body, status as 400);
  };
  app.onError(onError);

  const api = new Hono();
  api.onError(onError);
  registerKnowledgeRoutes(api, ctx);
  registerPracticeRoutes(api, ctx);
  registerFiguresRoutes(api, ctx);
  registerSessionsRoutes(api, ctx);
  registerAgentToolsRoutes(api, ctx);
  registerPriorRoutes(api, ctx);
  app.route("/api/v1", api);

  mountMcp(app, ctx);
  app.notFound((c) => c.json({ error: "not_found" }, 404));

  const dist = opts.pwaDist ?? PWA_DIST;
  if (existsSync(dist)) {
    const root = relative(process.cwd(), dist);
    app.use("/*", serveStatic({ root }));
    app.get("/*", serveStatic({ root, path: "index.html" })); // SPA: client-side routes
  }
  return app;
}
