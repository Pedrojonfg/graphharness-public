// stdio → HTTP adapter for the Hub: each incoming JSON-RPC line is a POST to /mcp.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

export interface RelayOptions {
  url: string;
  token: string;
  input: NodeJS.ReadableStream;
  write: (line: string) => void;
}

/** Extracts the JSON messages from a response: a direct JSON body or SSE events (`data:` lines). */
export function parseResponse(contentType: string, body: string): string[] {
  if (contentType.includes("text/event-stream")) {
    return body
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .filter(Boolean);
  }
  return body.trim() ? [body.trim()] : [];
}

function rpcError(id: unknown, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } });
}

export async function relay(opts: RelayOptions): Promise<void> {
  let sessionId: string | null = null;
  // Sequential: responses are written in the same order as the requests.
  for await (const raw of createInterface({ input: opts.input })) {
    const line = raw.trim();
    if (!line) continue;
    let id: unknown;
    try {
      id = (JSON.parse(line) as { id?: unknown }).id;
    } catch {
      opts.write(rpcError(null, "Invalid JSON on stdin"));
      continue;
    }
    try {
      const res = await fetch(opts.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${opts.token}`,
          ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        },
        body: line,
      });
      sessionId = res.headers.get("mcp-session-id") ?? sessionId;
      const body = await res.text();
      if (id === undefined) continue; // notification: no response
      if (!res.ok && !body.trim().startsWith("{")) {
        opts.write(rpcError(id, `Hub responded ${res.status}`));
        continue;
      }
      for (const msg of parseResponse(res.headers.get("content-type") ?? "", body)) opts.write(msg);
    } catch (e) {
      if (id !== undefined) opts.write(rpcError(id, `Could not reach the Hub: ${e instanceof Error ? e.message : String(e)}`));
    }
  }
}

export function readToken(env: NodeJS.ProcessEnv = process.env): string {
  const file = env.HUB_MCP_TOKEN_FILE ?? join(homedir(), ".config", "hub-mcp", "token");
  return readFileSync(file, "utf8").trim();
}
