#!/usr/bin/env node
// `hub-mcp` binary: launched by the agent (stdio). The token is read from ~/.config/hub-mcp/token or HUB_MCP_TOKEN_FILE.
import { readToken, relay } from "./index.ts";

let token: string;
try {
  token = readToken();
} catch (e) {
  console.error(`hub-mcp: could not read the token: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
await relay({
  url: process.env.HUB_MCP_URL ?? "http://127.0.0.1:4100/mcp",
  token,
  input: process.stdin,
  write: (line) => process.stdout.write(`${line}\n`),
});
