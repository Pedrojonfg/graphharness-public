// MCP: Streamable HTTP on /mcp, stateless (one server per request), Bearer $HUB_MCP_TOKEN and loopback ONLY.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { MCP_SERVER_INSTRUCTIONS, MCP_TOOLS } from "@graphharness/contracts";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, Hono } from "hono";
import { timingSafeEqual } from "node:crypto";
import { toErrorResponse } from "../errors.ts";
import type { HubContext } from "../services/context.ts";
import { figuresTools } from "./figures.ts";
import { knowledgeTools } from "./knowledge.ts";
import { lensFeedbackTools } from "./lens-feedback.ts";
import { practiceTools } from "./practice.ts";
import { priorTools } from "./prior.ts";
import { sessionsTools } from "./sessions.ts";
import type { McpHandlers } from "./types.ts";

export const MCP_HANDLERS: McpHandlers = { ...knowledgeTools, ...practiceTools, ...sessionsTools, ...priorTools, ...figuresTools, ...lensFeedbackTools };

export function createMcpServer(ctx: HubContext, handlers: McpHandlers = MCP_HANDLERS): McpServer {
  const server = new McpServer({ name: "graphharness-hub", version: "1.0.0" }, { instructions: MCP_SERVER_INSTRUCTIONS });
  for (const tool of MCP_TOOLS) {
    const handler = handlers[tool.name];
    if (!handler) continue;
    const annotations = "readOnly" in tool && tool.readOnly ? { readOnlyHint: true } : { readOnlyHint: false };
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.input, outputSchema: tool.output, annotations }, async (input: unknown) => {
      try {
        const out = (await handler(ctx, input)) as Record<string, unknown>;
        return { content: [{ type: "text" as const, text: JSON.stringify(out) }], structuredContent: out };
      } catch (err) {
        return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(toErrorResponse(err).body) }] };
      }
    });
  }
  return server;
}

function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * True loopback: `tailscale serve` also connects from 127.0.0.1, so any request carrying proxy headers
 * (X-Forwarded-For, Tailscale-User-*) is rejected as well.
 */
export function isDirectLoopback(c: Context): boolean {
  let addr: string | undefined;
  try {
    addr = getConnInfo(c).remote.address;
  } catch {
    addr = undefined; // no socket (app.request in tests): decided by headers
  }
  const loopback = addr === undefined || addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
  const proxied = c.req.header("x-forwarded-for") !== undefined || c.req.header("tailscale-user-login") !== undefined;
  return loopback && !proxied;
}

export function mountMcp(app: Hono, ctx: HubContext): void {
  app.all("/mcp", async (c) => {
    if (!isDirectLoopback(c)) return c.json({ error: "forbidden" }, 403);
    const auth = c.req.header("authorization") ?? "";
    if (!ctx.config.mcpToken || !sameToken(auth, `Bearer ${ctx.config.mcpToken}`)) return c.json({ error: "unauthorized" }, 401);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const server = createMcpServer(ctx);
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });
}
