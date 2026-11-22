// Hub process (hub.service): REST API + MCP + PWA on 127.0.0.1:$HUB_PORT.
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { createContext } from "./services/context.ts";

const ctx = createContext();
if (!ctx.config.mcpToken) console.warn("[hub] HUB_MCP_TOKEN is empty: /mcp will reject every request");
serve({ fetch: createApp(ctx).fetch, hostname: "127.0.0.1", port: ctx.config.port }, (info) =>
  console.log(`[hub] listening on http://127.0.0.1:${info.port}`),
);
