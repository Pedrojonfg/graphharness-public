import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CLAUDE_NO_TOOLS_ARGS, createLlm, llmConfigFromEnv } from "./client.ts";
import { chatResponse, cliOutput, fakeChild, type FakeChild } from "./testing.ts";
import { LlmError, LlmJsonError, LlmTimeoutError, type LlmUsageRecord } from "./types.ts";

afterEach(() => vi.useRealTimers());

const base = { tierCheap: "haiku", tierStrong: "sonnet" } as const;
const req = { task: "t", tier: "cheap" as const, system: "SYSTEM", messages: [{ role: "user" as const, content: "question one" }] };

function cliSetup(outputs: string[], extra: Record<string, unknown> = {}) {
  const calls: { command: string; args: string[]; child: FakeChild }[] = [];
  const usage: LlmUsageRecord[] = [];
  const spawn = (command: string, args: string[]) => {
    const child = fakeChild();
    calls.push({ command, args, child });
    const out = outputs[calls.length - 1];
    if (out !== undefined) queueMicrotask(() => child.finish(out));
    return child;
  };
  const llm = createLlm({ provider: "claude-cli", ...base, spawn, onUsage: (u) => usage.push(u), ...extra });
  return { llm, calls, usage };
}

describe("llmConfigFromEnv", () => {
  it("defaults: claude-cli, haiku, sonnet", () => {
    const c = llmConfigFromEnv({});
    expect(c).toMatchObject({ provider: "claude-cli", tierCheap: "haiku", tierStrong: "sonnet" });
    expect(c.baseUrl).toBeUndefined();
    expect(c.apiKey).toBeUndefined();
  });
  it("reads all the LLM_* variables", () => {
    const c = llmConfigFromEnv({
      LLM_PROVIDER: "openai-compatible",
      LLM_TIER_CHEAP: "opus",
      LLM_TIER_STRONG: "opus",
      LLM_BASE_URL: "https://x/v1",
      LLM_API_KEY: "k",
      LLM_MODEL_CHEAP: "m-c",
      LLM_MODEL_STRONG: "m-s",
    });
    expect(c).toMatchObject({
      provider: "openai-compatible", tierCheap: "opus", tierStrong: "opus",
      baseUrl: "https://x/v1", apiKey: "k", modelCheap: "m-c", modelStrong: "m-s",
    });
  });
  it("rejects an unknown provider", () => {
    expect(() => llmConfigFromEnv({ LLM_PROVIDER: "other" })).toThrow(/LLM_PROVIDER/);
  });
});

describe("claude-cli", () => {
  it("launches `claude -p --output-format json --model <tier>` without tools and passes the prompt via stdin", async () => {
    const { llm, calls } = cliSetup([cliOutput("hello")]);
    await llm.complete({
      ...req,
      messages: [
        { role: "user", content: "question one" },
        { role: "assistant", content: "previous answer" },
        { role: "user", content: "question two" },
      ],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("claude");
    expect(calls[0]!.args).toEqual(["-p", "--output-format", "json", "--model", "haiku", ...CLAUDE_NO_TOOLS_ARGS]);
    expect(CLAUDE_NO_TOOLS_ARGS.length).toBeGreaterThan(0);
    const stdin = calls[0]!.child.stdinData;
    const order = ["SYSTEM", "question one", "previous answer", "question two"].map((s) => stdin.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(stdin).not.toContain(calls[0]!.args.join(" "));
  });

  it("the strong tier uses the strong model", async () => {
    const { llm, calls } = cliSetup([cliOutput("x")], { tierStrong: "opus" });
    await llm.complete({ ...req, tier: "strong" });
    expect(calls[0]!.args).toContain("opus");
    expect(calls[0]!.args).not.toContain("haiku");
  });

  it("parses result and usage, and calls onUsage", async () => {
    const { llm, usage } = cliSetup([cliOutput("final text", { input_tokens: 42, output_tokens: 9 })]);
    const r = await llm.complete({ ...req, promptVersion: "t.v3" });
    expect(r).toMatchObject({ text: "final text", model: "haiku", usage: { inputTokens: 42, outputTokens: 9 } });
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ task: "t", provider: "claude-cli", model: "haiku", inputTokens: 42, outputTokens: 9, ok: true, promptVersion: "t.v3" });
    expect(Number.isNaN(Date.parse(usage[0]!.at))).toBe(false);
  });

  it("missing usage → null", async () => {
    const { llm } = cliSetup([cliOutput("x", null)]);
    expect((await llm.complete(req)).usage).toEqual({ inputTokens: null, outputTokens: null });
  });

  it("is_error or exit code ≠ 0 → LlmError and onUsage ok:false", async () => {
    const a = cliSetup([cliOutput("failure", null, true)]);
    await expect(a.llm.complete(req)).rejects.toBeInstanceOf(LlmError);
    expect(a.usage[0]).toMatchObject({ ok: false });

    const calls: FakeChild[] = [];
    const usage: LlmUsageRecord[] = [];
    const llm = createLlm({
      provider: "claude-cli", ...base, onUsage: (u) => usage.push(u),
      spawn: () => {
        const c = fakeChild();
        calls.push(c);
        queueMicrotask(() => c.finish("", 1, "boom"));
        return c;
      },
    });
    await expect(llm.complete(req)).rejects.toThrow(/boom|1/);
    expect(usage[0]).toMatchObject({ ok: false });
  });

  it("output that is not JSON → LlmError", async () => {
    const { llm } = cliSetup(["this is not json"]);
    await expect(llm.complete(req)).rejects.toBeInstanceOf(LlmError);
  });

  it("the timeout kills the process and rejects with LlmTimeoutError", async () => {
    vi.useFakeTimers();
    const { llm, calls, usage } = cliSetup([], { timeoutMs: 1000 });
    const p = llm.complete(req);
    const assertion = expect(p).rejects.toBeInstanceOf(LlmTimeoutError);
    await vi.advanceTimersByTimeAsync(999);
    expect(calls[0]!.child.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    await assertion;
    expect(calls[0]!.child.killed).toBe(true);
    expect(usage[0]).toMatchObject({ ok: false });
  });

  it("the default timeout is 120 s", async () => {
    vi.useFakeTimers();
    const { llm, calls } = cliSetup([]);
    const p = llm.complete(req);
    const assertion = expect(p).rejects.toBeInstanceOf(LlmTimeoutError);
    await vi.advanceTimersByTimeAsync(119_000);
    expect(calls[0]!.child.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
    expect(calls[0]!.child.killed).toBe(true);
  });
});

describe("openai-compatible", () => {
  const cfg = { provider: "openai-compatible" as const, ...base, baseUrl: "https://api.example.com/v1", apiKey: "sk-test", modelCheap: "m-cheap", modelStrong: "m-strong" };

  it("POST {baseUrl}/chat/completions with Bearer and the tier's model", async () => {
    const fetchFn = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => chatResponse("answer"));
    const usage: LlmUsageRecord[] = [];
    const llm = createLlm({ ...cfg, fetch: fetchFn as unknown as typeof fetch, onUsage: (u) => usage.push(u) });
    const r = await llm.complete({ ...req, tier: "strong", promptVersion: "t.v1" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(String(url)).toBe("https://api.example.com/v1/chat/completions");
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer sk-test");
    expect(headers.get("content-type")).toMatch(/application\/json/);
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe("m-strong");
    expect(body.messages).toEqual([
      { role: "system", content: "SYSTEM" },
      { role: "user", content: "question one" },
    ]);
    expect(r).toMatchObject({ text: "answer", model: "m-strong", usage: { inputTokens: 5, outputTokens: 3 } });
    expect(usage[0]).toMatchObject({ provider: "openai-compatible", model: "m-strong", inputTokens: 5, outputTokens: 3, ok: true, promptVersion: "t.v1" });
  });

  it("cheap tier uses modelCheap and tolerates baseUrl with a trailing slash", async () => {
    const fetchFn = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) => chatResponse("x", null));
    const llm = createLlm({ ...cfg, baseUrl: "https://api.example.com/v1/", fetch: fetchFn as unknown as typeof fetch });
    const r = await llm.complete(req);
    expect(String(fetchFn.mock.calls[0]![0])).toBe("https://api.example.com/v1/chat/completions");
    expect(JSON.parse(String(fetchFn.mock.calls[0]![1]?.body)).model).toBe("m-cheap");
    expect(r.usage).toEqual({ inputTokens: null, outputTokens: null });
  });

  it("non-OK HTTP → LlmError and onUsage ok:false", async () => {
    const usage: LlmUsageRecord[] = [];
    const fetchFn = vi.fn(async () => new Response("nope", { status: 500 }));
    const llm = createLlm({ ...cfg, fetch: fetchFn as unknown as typeof fetch, onUsage: (u) => usage.push(u) });
    await expect(llm.complete(req)).rejects.toBeInstanceOf(LlmError);
    expect(usage[0]).toMatchObject({ ok: false });
  });

  it("no baseUrl or no tier model → configuration error on call", async () => {
    const fetchFn = vi.fn(async () => chatResponse("x"));
    const noUrl = createLlm({ provider: "openai-compatible", ...base, modelCheap: "m", fetch: fetchFn as unknown as typeof fetch });
    await expect(noUrl.complete(req)).rejects.toBeInstanceOf(LlmError);
    const noModel = createLlm({ ...cfg, modelCheap: undefined, fetch: fetchFn as unknown as typeof fetch });
    await expect(noModel.complete(req)).rejects.toBeInstanceOf(LlmError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("the timeout aborts the fetch and rejects with LlmTimeoutError", async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn(
      (_u: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new DOMException("abort", "AbortError")))),
    );
    const llm = createLlm({ ...cfg, timeoutMs: 500, fetch: fetchFn as unknown as typeof fetch });
    const assertion = expect(llm.complete(req)).rejects.toBeInstanceOf(LlmTimeoutError);
    await vi.advanceTimersByTimeAsync(501);
    await assertion;
  });
});

describe("JSON output with schema", () => {
  const schema = z.object({ a: z.number() });

  it("extracts and validates (```json block) and returns typed json", async () => {
    const { llm, usage } = cliSetup([cliOutput('Sure:\n```json\n{"a": 5}\n```')]);
    const r = await llm.complete({ ...req, jsonSchema: schema });
    expect(r.json).toEqual({ a: 5 });
    expect(usage).toHaveLength(1);
  });

  it("if validation fails it retries ONCE with the error in the second prompt; onUsage twice", async () => {
    const { llm, calls, usage } = cliSetup([cliOutput('{"a":"x"}'), cliOutput('{"a":7}')]);
    const r = await llm.complete({ ...req, jsonSchema: schema, promptVersion: "t.v1" });
    expect(r.json).toEqual({ a: 7 });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.child.stdinData).not.toMatch(/Expected number/);
    expect(calls[1]!.child.stdinData).toMatch(/Expected number/);
    expect(calls[1]!.child.stdinData).toContain('{"a":"x"}');
    expect(usage).toHaveLength(2);
    expect(usage.map((u) => u.promptVersion)).toEqual(["t.v1", "t.v1"]);
  });

  it("also retries if the text contains no JSON", async () => {
    const { llm, calls } = cliSetup([cliOutput("no idea"), cliOutput('{"a":1}')]);
    expect((await llm.complete({ ...req, jsonSchema: schema })).json).toEqual({ a: 1 });
    expect(calls).toHaveLength(2);
  });

  it("second failure → LlmJsonError, exactly 2 calls", async () => {
    const { llm, calls, usage } = cliSetup([cliOutput('{"a":"x"}'), cliOutput('{"a":"y"}'), cliOutput('{"a":9}')]);
    const err = await llm.complete({ ...req, jsonSchema: schema }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmJsonError);
    expect((err as LlmJsonError).lastText).toContain('"y"');
    expect(calls).toHaveLength(2);
    expect(usage).toHaveLength(2);
  });

  it("without jsonSchema there is no json and no retries", async () => {
    const { llm, calls } = cliSetup([cliOutput("{no json")]);
    const r = await llm.complete(req);
    expect(r.json).toBeUndefined();
    expect(calls).toHaveLength(1);
  });
});

describe("concurrency semaphore", () => {
  function slowFetch() {
    let inFlight = 0;
    let maxInFlight = 0;
    const pending: (() => void)[] = [];
    const fetchFn = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          pending.push(() => {
            inFlight--;
            resolve(chatResponse("ok"));
          });
        }),
    );
    return { fetchFn, pending, max: () => maxInFlight };
  }
  const cfg = { provider: "openai-compatible" as const, ...base, baseUrl: "https://h/v1", modelCheap: "m", modelStrong: "m" };
  const tick = () => new Promise((r) => setTimeout(r, 5));

  it("with 3 slow calls only 2 are in flight; the 3rd starts when one is released", async () => {
    const { fetchFn, pending, max } = slowFetch();
    const llm = createLlm({ ...cfg, fetch: fetchFn as unknown as typeof fetch });
    const ps = [llm.complete(req), llm.complete(req), llm.complete(req)];
    await tick();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    pending.shift()!();
    await tick();
    expect(fetchFn).toHaveBeenCalledTimes(3);
    pending.shift()!();
    pending.shift()!();
    await Promise.all(ps);
    expect(max()).toBe(2);
  });

  it("configurable maxConcurrent (1) and the slot is also released if the call fails", async () => {
    let n = 0;
    const fetchFn = vi.fn(async () => (++n === 1 ? new Response("x", { status: 500 }) : chatResponse("ok")));
    const llm = createLlm({ ...cfg, maxConcurrent: 1, fetch: fetchFn as unknown as typeof fetch });
    const results = await Promise.allSettled([llm.complete(req), llm.complete(req)]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "fulfilled"]);
  });
});
