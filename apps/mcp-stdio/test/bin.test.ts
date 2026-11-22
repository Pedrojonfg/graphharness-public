import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "bin.ts");

describe("hub-mcp", () => {
  let server: Server;
  let url: string;
  let dir: string;
  const seen: { auth?: string; accept?: string; body: string }[] = [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "hub-mcp-"));
    writeFileSync(join(dir, "token"), "secret-123\n");
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ auth: req.headers.authorization, accept: req.headers.accept, body });
        const msg = JSON.parse(body) as { id?: number; method: string };
        if (msg.id === undefined) return void res.writeHead(202).end();
        if (msg.method === "sse") {
          res.writeHead(200, { "content-type": "text/event-stream" });
          return void res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: "via-sse" })}\n\n`);
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { ok: true } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  });
  afterAll(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function run(lines: string[]): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const p = spawn("node", [BIN], { env: { ...process.env, HUB_MCP_URL: url, HUB_MCP_TOKEN_FILE: join(dir, "token") } });
      let out = "";
      p.stdout.on("data", (c) => (out += c));
      p.on("error", reject);
      p.on("close", () => resolve(out.split("\n").filter(Boolean)));
      p.stdin.end(lines.join("\n") + "\n");
    });
  }

  it("forwards with Bearer, returns the JSON response, understands SSE and does not respond to notifications", async () => {
    const out = await run([
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "sse" }),
    ]);
    expect(out.map((l) => JSON.parse(l))).toEqual([
      { jsonrpc: "2.0", id: 1, result: { ok: true } },
      { jsonrpc: "2.0", id: 2, result: "via-sse" },
    ]);
    expect(seen).toHaveLength(3);
    for (const s of seen) {
      expect(s.auth).toBe("Bearer secret-123");
      expect(s.accept).toBe("application/json, text/event-stream");
    }
  });
});
