// ADR 109 (decision 7): read-only MCP tool `list_lens_feedback`, same output as GET /lens-feedback.
import { MCP_TOOLS } from "@graphharness/contracts";
import type { LlmRequest } from "@graphharness/llm";
import type { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { MCP_HANDLERS } from "../../src/mcp/server.ts";
import { setNow } from "../../src/testing.ts";
import { NOW, autoLlm, call, conceptIn, iso, subject, world, type Ctx } from "./helpers.ts";

const NAME = "list_lens_feedback";

/** Calls the tool like the MCP server: input validated with the contract's schema and output validated with its own. */
async function tool(ctx: Ctx, input: object): Promise<any> {
  const def = MCP_TOOLS.find((t) => t.name === NAME);
  expect(def, `${NAME} missing in MCP_TOOLS`).toBeDefined();
  const handler = MCP_HANDLERS[NAME];
  expect(handler, `handler of ${NAME} missing in MCP_HANDLERS`).toBeDefined();
  return def!.output.parse(await handler!(ctx, def!.input.parse(input)));
}

/** tools/list through the real /mcp endpoint (stateless JSON-RPC). */
async function listTools(app: Hono): Promise<{ name: string; annotations?: { readOnlyHint?: boolean } }[]> {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: { authorization: "Bearer test-token", "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { result: { tools: { name: string; annotations?: { readOnlyHint?: boolean } }[] } }).result.tools;
}

function rerankLlm(scores: () => { conceptId: string; score: number }[]) {
  return autoLlm({ "resolve-rerank": (_req: LlmRequest) => ({ scores: scores() }) });
}

describe("list_lens_feedback (MCP)", () => {
  it("is read-only: readOnly in the contract and readOnlyHint in tools/list", async () => {
    const { app } = world();
    const tools = await listTools(app);
    expect(tools.find((t) => t.name === "get_concept")?.annotations?.readOnlyHint, "tools/list funciona (get_concept)").toBe(true);
    const def = MCP_TOOLS.find((t) => t.name === NAME);
    expect(def && "readOnly" in def && def.readOnly, `${NAME}.readOnly in MCP_TOOLS`).toBe(true);
    expect(tools.find((t) => t.name === NAME)?.annotations, `${NAME} in tools/list`).toMatchObject({ readOnlyHint: true });
  });

  it("returns the same as GET /lens-feedback, by conceptId and by conceptQuery", async () => {
    let id = "";
    const { ctx, app } = world({ llm: rerankLlm(() => [{ conceptId: id, score: 0.95 }]) });
    id = conceptIn(ctx, subject(ctx), "Eigenvalues");
    const post = async (chatId: string, lenses: { label: string; liked: boolean }[]) =>
      expect((await call(app, "post", "/lens-feedback", { conceptId: id, chatId, nodeId: "n1", lenses })).status).toBe(201);
    await post("chat-1", [{ label: "Drawing", liked: true }, { label: "Counterexample", liked: false }]);
    setNow(ctx, iso(Date.parse(NOW) + 60_000));
    await post("chat-2", [{ label: "Counterexample", liked: true }, { label: "Analogy", liked: false }]);

    const rest = await call(app, "get", `/lens-feedback?conceptId=${id}`);
    expect(rest.status).toBe(200);
    expect(rest.json.lenses.map((l: { label: string }) => l.label)).toEqual(["Counterexample", "Drawing", "Analogy"]);
    expect(await tool(ctx, { conceptId: id })).toEqual(rest.json);
    expect(await tool(ctx, { conceptQuery: "eigenvalues" })).toEqual(rest.json);
  });

  it("no votes → lenses: []; non-existent concept → 404 not_found", async () => {
    const { ctx } = world();
    const c = conceptIn(ctx, subject(ctx), "Rank");
    expect(await tool(ctx, { conceptId: c })).toEqual({ conceptId: c, conceptName: "Rank", lenses: [] });
    await expect(MCP_HANDLERS[NAME]!(ctx, { conceptId: "nope" })).rejects.toMatchObject({ status: 404, body: { error: "not_found" } });
  });

  // The input of MCP_TOOLS must be a ZodObject (required by packages/contracts/src/api/routes.test.ts), so the rule
  // "exactly one" can live in the schema (superRefine cannot: it turns it into ZodEffects) or in the handler (400).
  it("the input requires exactly one of conceptId / conceptQuery (schema or handler → 400)", async () => {
    const { ctx } = world();
    const c = conceptIn(ctx, subject(ctx), "Rank");
    expect((await tool(ctx, { conceptId: c })).conceptId).toBe(c);
    const def = MCP_TOOLS.find((t) => t.name === NAME)!;
    for (const input of [{}, { conceptId: c, conceptQuery: "rank" }]) {
      const parsed = def.input.safeParse(input);
      if (!parsed.success) continue; // rejected by the contract's schema
      await expect(MCP_HANDLERS[NAME]!(ctx, parsed.data), JSON.stringify(input)).rejects.toMatchObject({ status: 400, body: { error: "invalid_request" } });
    }
  });
});
