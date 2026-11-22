import type { HubContext } from "../services/context.ts";

/** Handler of an MCP tool: receives the input already validated with the `MCP_TOOLS` schema and returns its `output`. */
export type McpHandler = (ctx: HubContext, input: any) => Promise<unknown>; // the fine-grained typing comes from the contracts schema
export type McpHandlers = Record<string, McpHandler>;
