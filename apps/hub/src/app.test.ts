import { describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { makeTestContext } from "./testing.ts";

const rpc = (id: number, method: string, params: object = {}) =>
  JSON.stringify({ jsonrpc: "2.0", id, method, params });

describe("MCP /mcp (loopback only, bearer token)", () => {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };

  it("rejects a missing token, a bad token and a request arriving through a proxy (tailscale serve)", async () => {
    const app = createApp(makeTestContext(), { pwaDist: "/nonexistent" });
    expect((await app.request("/mcp", { method: "POST", headers, body: rpc(1, "tools/list") })).status).toBe(401);
    expect((await app.request("/mcp", { method: "POST", headers: { ...headers, authorization: "Bearer other" }, body: rpc(1, "tools/list") })).status).toBe(401);
    const proxied = await app.request("/mcp", {
      method: "POST",
      headers: { ...headers, authorization: "Bearer test-token", "x-forwarded-for": "100.64.0.2" },
      body: rpc(1, "tools/list"),
    });
    expect(proxied.status).toBe(403);
  });

  it("with a token it answers initialize over JSON-RPC", async () => {
    const app = createApp(makeTestContext(), { pwaDist: "/nonexistent" });
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { ...headers, authorization: "Bearer test-token" },
      body: rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { serverInfo: { name: string }; instructions: string } };
    expect(body.result.serverInfo.name).toBe("graphharness-hub");
    expect(body.result.instructions).toMatch(/resolve_concepts/);
  });
});

describe("API REST", () => {
  it("unknown route → contract 404", async () => {
    const app = createApp(makeTestContext(), { pwaDist: "/nonexistent" });
    const res = await app.request("/api/v1/does-not-exist");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});
