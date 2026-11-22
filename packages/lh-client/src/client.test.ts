// Tests for the LearnHarness HTTP client (ADR 105) against a fake fetch that serves
// fixtures/synthetic/http (synthetic responses shaped after src/types.ts; see fixtures/README.md).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createLhClient, type ImportFile } from "./client.ts";
import { LhContractError, LhError } from "./errors.ts";
import type { ServerEvent } from "./types.ts";

const BASE = "http://lh.test:3000";
const CHAT = "chat_k3p9c5zr_2d80f6b3";
const TEACH_CHAT = "chat_k3p8w2ud_7e1b44a0";

const fixtureText = (name: string): string => readFileSync(new URL(`../fixtures/synthetic/http/${name}`, import.meta.url), "utf8");
const fixture = (name: string): unknown => JSON.parse(fixtureText(name));

type Handler = (req: Request) => Response | Promise<Response>;

/** Fake fetch: keeps a copy of every Request (with its body) and delegates to `handler`. */
function fakeFetch(handler: Handler): { fetch: typeof fetch; calls: Request[] } {
  const calls: Request[] = [];
  const f = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    calls.push(req.clone());
    return handler(req);
  };
  return { fetch: f as typeof fetch, calls };
}

/** LearnHarness routes → fixture. */
function lhFake(): ReturnType<typeof fakeFetch> {
  return fakeFetch((req) => {
    const { pathname } = new URL(req.url);
    const route = `${req.method} ${pathname}`;
    switch (route) {
      case "GET /api/graph":
        return Response.json(fixture("graph.json"));
      case "GET /api/chats":
        return Response.json(fixture("chats.json"));
      case `GET /api/chats/${CHAT}`:
        return Response.json(fixture("chat.json"));
      case `GET /api/chats/${CHAT}/markdown`:
        return new Response(fixtureText("chat-markdown.md"), {
          headers: { "content-type": "text/markdown; charset=utf-8", "content-disposition": 'attachment; filename="test-session.md"' },
        });
      case "GET /api/chats/chat_missing":
        return Response.json(fixture("chat-404.json"), { status: 404 });
      case "POST /api/chats":
        return Response.json(fixture("chats-create.json"));
      case "POST /api/chat":
        return Response.json(fixture("chat-send.json"));
      case "POST /api/graph/coverage/extract":
        return Response.json(fixture("coverage-extract-202.json"), { status: 202 });
      case "GET /api/graph/status":
        return Response.json(fixture("graph-status.json"));
      default:
        return Response.json({ error: `route not expected in the test: ${route}` }, { status: 599 });
    }
  });
}

const routeOf = (req: Request): string => `${req.method} ${new URL(req.url).pathname}`;

describe("reads", () => {
  it("getGraph: GET /api/graph and only propositions + chains + fileSources (never nodes/edges)", async () => {
    const fake = lhFake();
    const graph = await createLhClient({ baseUrl: BASE, fetch: fake.fetch }).getGraph();
    expect(fake.calls.map(routeOf)).toEqual(["GET /api/graph"]);
    expect(fake.calls[0]!.url).toBe(`${BASE}/api/graph`);
    expect(graph.propositions).toHaveLength(24);
    expect(graph.chains).toHaveLength(10);
    // ADR 103: besides propositions + chains, fileSources (srcId → path); never nodes/edges.
    expect(Object.keys(graph).sort()).toEqual(["chains", "fileSources", "propositions"]);
    expect(Object.values(graph.fileSources ?? {}).length).toBeGreaterThan(0);
    const p = graph.propositions.find((n) => n.id === "n_89577c5c8ac3");
    expect(p).toMatchObject({ name: "First law of thermodynamics" });
    expect(p!.statement).toMatch(/^The change in the internal energy of a closed system equals the heat added to it/);
    expect(graph.chains[0]!.id).toMatch(/^arg_/);
    expect(graph.chains.every((c) => c.premises.length >= 1 && typeof c.conclusion === "string")).toBe(true);
  });

  it("a trailing slash in baseUrl does not duplicate the slash", async () => {
    const fake = lhFake();
    await createLhClient({ baseUrl: `${BASE}/`, fetch: fake.fetch }).getGraph();
    expect(fake.calls[0]!.url).toBe(`${BASE}/api/graph`);
  });

  it("listChats: GET /api/chats → the ChatListItem rows", async () => {
    const fake = lhFake();
    const chats = await createLhClient({ baseUrl: BASE, fetch: fake.fetch }).listChats();
    expect(fake.calls.map(routeOf)).toEqual(["GET /api/chats"]);
    expect(chats.map((c) => [c.id, c.kind, c.messageCount, c.busy])).toEqual([
      [CHAT, "practice", 16, false],
      [TEACH_CHAT, "teach", 46, false],
    ]);
    expect(chats[0]!.title).toBe("Practice: ideal gas processes");
    expect(chats[0]!.updatedAt).toBe("2026-09-22T16:21:15.000Z");
  });

  it("getChat: GET /api/chats/:id → record with native messages + turnInFlight + coverage", async () => {
    const fake = lhFake();
    const chat = await createLhClient({ baseUrl: BASE, fetch: fake.fetch }).getChat(CHAT);
    expect(fake.calls.map(routeOf)).toEqual([`GET /api/chats/${CHAT}`]);
    expect(chat.id).toBe(CHAT);
    expect(chat.kind).toBe("practice");
    expect(chat.messages).toHaveLength(16);
    expect(chat.messages[0]).toMatchObject({ role: "custom", customType: "graph-context" });
    expect(chat.turnInFlight).toBe(false);
    expect(chat.coverage).toMatchObject({ uncoveredCount: 3, running: false });
  });

  it("getChat of a missing chat → LhError 404", async () => {
    const fake = lhFake();
    const err = await createLhClient({ baseUrl: BASE, fetch: fake.fetch }).getChat("chat_missing").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LhError);
    expect(err).toMatchObject({ status: 404, code: "http_404" });
  });

  it("getChatMarkdown: GET /api/chats/:id/markdown → text", async () => {
    const fake = lhFake();
    const md = await createLhClient({ baseUrl: BASE, fetch: fake.fetch }).getChatMarkdown(CHAT);
    expect(fake.calls.map(routeOf)).toEqual([`GET /api/chats/${CHAT}/markdown`]);
    expect(md).toBe(fixtureText("chat-markdown.md"));
    expect(md.startsWith("# Practice: ideal gas processes\n")).toBe(true);
  });

  it("graphStatus: GET /api/graph/status → runs", async () => {
    const fake = lhFake();
    const runs = await createLhClient({ baseUrl: BASE, fetch: fake.fetch }).graphStatus();
    expect(fake.calls.map(routeOf)).toEqual(["GET /api/graph/status"]);
    expect(runs.map((r) => [r.id, r.chatId, r.phase])).toEqual([
      [CHAT, CHAT, "extracting"],
      ["src_9e29eb12f09c#2", "src_9e29eb12f09c", "auditing"],
    ]);
  });

  it("graphStatus with no extraction running → []", async () => {
    const fake = fakeFetch(() => Response.json(fixture("graph-status-idle.json")));
    expect(await createLhClient({ baseUrl: BASE, fetch: fake.fetch }).graphStatus()).toEqual([]);
  });
});

describe("writes", () => {
  it("createChat: POST /api/chats with {title, kind, graphContext} as JSON → {id, title}", async () => {
    const fake = lhFake();
    const picks = [
      { id: "n_89577c5c8ac3", name: "First law of thermodynamics", statement: "The change in the internal energy of a closed system …" },
      { id: "n_b16fd5621355", name: "Isothermal process", statement: "In an isothermal process the temperature stays constant …" },
    ];
    const out = await createLhClient({ baseUrl: BASE, fetch: fake.fetch }).createChat({
      title: "Thermodynamics: entropy review",
      kind: "teach",
      graphContext: { propositions: picks },
    });
    expect(out).toEqual({ id: "chat_k3pa7q18_9d3c52e1", title: "Thermodynamics: entropy review" });
    const req = fake.calls[0]!;
    expect(routeOf(req)).toBe("POST /api/chats");
    expect(req.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await req.json()).toEqual({ title: "Thermodynamics: entropy review", kind: "teach", graphContext: { propositions: picks } });
  });

  it("createChat without graphContext does not send it", async () => {
    const fake = lhFake();
    await createLhClient({ baseUrl: BASE, fetch: fake.fetch }).createChat({ title: "Practice", kind: "practice" });
    expect(await fake.calls[0]!.json()).toEqual({ title: "Practice", kind: "practice" });
  });

  it("sendMessage: POST /api/chat with {chatId, input:{type:'text', text}} and resolves once the turn is accepted", async () => {
    const fake = lhFake();
    const text = "Goal: first law of thermodynamics.\nMaterials: thermodynamics/ch3-first-law.pdf";
    await expect(createLhClient({ baseUrl: BASE, fetch: fake.fetch }).sendMessage(CHAT, text)).resolves.toBeUndefined();
    const req = fake.calls[0]!;
    expect(routeOf(req)).toBe("POST /api/chat");
    expect(req.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await req.json()).toEqual({ chatId: CHAT, input: { type: "text", text } });
  });

  it("sendMessage with LH lacking a model → LhError 503 models_not_configured, unchanged (ADR 105)", async () => {
    const fake = fakeFetch(() => Response.json(fixture("models-not-configured-503.json"), { status: 503 }));
    const err = await createLhClient({ baseUrl: BASE, fetch: fake.fetch }).sendMessage(CHAT, "hello").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LhError);
    expect(err).toMatchObject({
      status: 503,
      code: "models_not_configured",
      body: { error: "No models are configured yet. Set up the required models first.", code: "models_not_configured", missing: ["strong"] },
    });
  });

  it("sendMessage while a turn is already running → LhError 409 without an LH code", async () => {
    const fake = fakeFetch(() => Response.json(fixture("chat-send-409.json"), { status: 409 }));
    const err = await createLhClient({ baseUrl: BASE, fetch: fake.fetch }).sendMessage(CHAT, "hello").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LhError);
    expect(err).toMatchObject({ status: 409, code: "http_409" });
  });

  it("error with a text body (LH 500) → LhError with the text in body", async () => {
    const fake = fakeFetch(() => new Response("Your input could not be saved. Please try again.", { status: 500 }));
    const err = await createLhClient({ baseUrl: BASE, fetch: fake.fetch }).sendMessage(CHAT, "hello").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LhError);
    expect(err).toMatchObject({ status: 500, code: "http_500", body: "Your input could not be saved. Please try again." });
  });

  it("LH unreachable → LhError status 0 'unreachable'", async () => {
    const fake = fakeFetch(() => {
      throw new TypeError("fetch failed");
    });
    const err = await createLhClient({ baseUrl: BASE, fetch: fake.fetch }).listChats().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LhError);
    expect(err).toMatchObject({ status: 0, code: "unreachable" });
  });

  it("extractCoverage: POST /api/graph/coverage/extract with {chatId}; 202 → started", async () => {
    const fake = lhFake();
    expect(await createLhClient({ baseUrl: BASE, fetch: fake.fetch }).extractCoverage(CHAT)).toEqual({ status: "started" });
    const req = fake.calls[0]!;
    expect(routeOf(req)).toBe("POST /api/graph/coverage/extract");
    expect(await req.json()).toEqual({ chatId: CHAT });
  });

  it("extractCoverage: 409 → already_running (ADR 105)", async () => {
    const fake = fakeFetch(() => Response.json(fixture("coverage-extract-409.json"), { status: 409 }));
    expect(await createLhClient({ baseUrl: BASE, fetch: fake.fetch }).extractCoverage(CHAT)).toEqual({ status: "already_running" });
  });

  it("extractCoverage: any other error → LhError", async () => {
    const fake = fakeFetch(() => Response.json({ error: "Body must be {chatId: string}" }, { status: 400 }));
    const err = await createLhClient({ baseUrl: BASE, fetch: fake.fetch }).extractCoverage(CHAT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LhError);
    expect(err).toMatchObject({ status: 400 });
  });
});

describe("importFiles (POST /api/graph/import, multipart files + paths)", () => {
  const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a]);
  const byPath = new Map(
    (fixture("graph-import.json") as { results: { filePath: string }[] }).results.map((r) => [r.filePath, r] as const),
  );
  /** Answers like LH to a request for ONE file: requestIndex 0 and the filePath that was sent. */
  const importFake = (): ReturnType<typeof fakeFetch> =>
    fakeFetch(async (req) => {
      const form = await req.formData();
      const path = form.get("paths");
      const result = typeof path === "string" ? byPath.get(path) : undefined;
      if (!result) return Response.json({ results: [], error: "Invalid import paths" }, { status: 400 });
      return Response.json({ results: [{ ...result, requestIndex: 0 }] });
    });

  it("one request per file, with `files` and `paths` in the UI order and the content intact", async () => {
    const fake = importFake();
    const files: ImportFile[] = [
      { path: "thermodynamics/ch3-first-law.md", content: "# Chapter 3\nFirst law.", filename: "ch3-first-law.md" },
      { path: "thermodynamics/problem-set-1.pdf", content: PDF, filename: "problem-set-1.pdf" },
    ];
    const results = await createLhClient({ baseUrl: BASE, fetch: fake.fetch }).importFiles(files);
    expect(fake.calls).toHaveLength(2);
    const sent = await Promise.all(
      fake.calls.map(async (req) => {
        expect(routeOf(req)).toBe("POST /api/graph/import");
        expect(req.headers.get("content-type")).toMatch(/^multipart\/form-data; boundary=/);
        const form = await req.formData();
        expect([...form.keys()]).toEqual(["files", "paths"]);
        const file = form.get("files");
        if (!(file instanceof File)) throw new Error("files is not a File");
        return { path: form.get("paths"), name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
      }),
    );
    sent.sort((a, b) => String(a.path).localeCompare(String(b.path)));
    expect(sent[1]).toEqual({ path: "thermodynamics/problem-set-1.pdf", name: "problem-set-1.pdf", bytes: PDF });
    expect(sent[0]!.path).toBe("thermodynamics/ch3-first-law.md");
    expect(sent[0]!.name).toBe("ch3-first-law.md");
    expect(new TextDecoder().decode(sent[0]!.bytes)).toBe("# Chapter 3\nFirst law.");
    expect(results).toEqual([
      { filePath: "thermodynamics/ch3-first-law.md", requestIndex: 0, outcome: "completed", ok: true, stats: { nodes: 12, chains: 7 } },
      {
        filePath: "thermodynamics/problem-set-1.pdf",
        requestIndex: 1,
        outcome: "completed",
        ok: true,
        stats: { nodes: 4, chains: 2, droppedChains: 1 },
        notice: "Two pages contain only scanned images and were skipped; text recognition is not available.",
      },
    ]);
  });

  it("files LH would reject are not sent: absolute path, unsupported extension, different filename, > 25 MB", async () => {
    const fake = importFake();
    const files: ImportFile[] = [
      { path: "/home/lh/materials/thermodynamics/ch3-first-law.md", content: "x", filename: "ch3-first-law.md" },
      { path: "thermodynamics/ch3-first-law.md", content: "# ok", filename: "ch3-first-law.md" },
      { path: "thermodynamics/notes.docx", content: "x", filename: "notes.docx" },
      { path: "thermodynamics/other.md", content: "x", filename: "different.md" },
      { path: "thermodynamics/../secret.md", content: "x", filename: "secret.md" },
      { path: "thermodynamics/huge.pdf", content: new Uint8Array(25 * 1024 * 1024 + 1), filename: "huge.pdf" },
    ];
    const results = await createLhClient({ baseUrl: BASE, fetch: fake.fetch }).importFiles(files);
    expect(fake.calls).toHaveLength(1);
    expect(results.map((r) => [r.requestIndex, r.filePath, r.ok, r.outcome])).toEqual([
      [0, "/home/lh/materials/thermodynamics/ch3-first-law.md", false, "failed"],
      [1, "thermodynamics/ch3-first-law.md", true, "completed"],
      [2, "thermodynamics/notes.docx", false, "failed"],
      [3, "thermodynamics/other.md", false, "failed"],
      [4, "thermodynamics/../secret.md", false, "failed"],
      [5, "thermodynamics/huge.pdf", false, "failed"],
    ]);
    for (const r of results.filter((x) => !x.ok)) expect(r.error).toEqual(expect.any(String));
  });

  it("at most 3 requests in flight at a time", async () => {
    let inFlight = 0;
    let max = 0;
    const fake = fakeFetch(async (req) => {
      inFlight++;
      max = Math.max(max, inFlight);
      const form = await req.formData();
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return Response.json({ results: [{ filePath: form.get("paths"), requestIndex: 0, outcome: "completed", ok: true, stats: { nodes: 1 } }] });
    });
    const files = Array.from({ length: 7 }, (_, i): ImportFile => ({ path: `notes/f${i}.md`, content: `# ${i}`, filename: `f${i}.md` }));
    const results = await createLhClient({ baseUrl: BASE, fetch: fake.fetch }).importFiles(files);
    expect(fake.calls).toHaveLength(7);
    expect(max).toBe(3);
    expect(results.map((r) => [r.requestIndex, r.filePath])).toEqual(files.map((f, i) => [i, f.path]));
  });

  it("LH in-band rejection (models_not_configured) arrives unchanged in the result", async () => {
    const fake = fakeFetch(() => Response.json(fixture("graph-import-models-not-configured.json")));
    const [r] = await createLhClient({ baseUrl: BASE, fetch: fake.fetch }).importFiles([
      { path: "thermodynamics/ch3-first-law.md", content: "# x", filename: "ch3-first-law.md" },
    ]);
    expect(r).toEqual({
      filePath: "thermodynamics/ch3-first-law.md",
      ok: false,
      requestIndex: 0,
      outcome: "failed",
      error: "No models are configured yet. Set up the required models first.",
      code: "models_not_configured",
      missing: ["cheap"],
    });
  });

  it("a non-2xx HTTP status for one file becomes its failed result; the others carry on", async () => {
    const fake = fakeFetch(async (req) => {
      const form = await req.formData();
      const path = form.get("paths");
      if (path === "notes/a.md") return Response.json({ results: [], error: "Too big. Max 25 MB." }, { status: 413 });
      return Response.json({ results: [{ filePath: path, requestIndex: 0, outcome: "completed", ok: true, stats: { nodes: 3 } }] });
    });
    const results = await createLhClient({ baseUrl: BASE, fetch: fake.fetch }).importFiles([
      { path: "notes/a.md", content: "a", filename: "a.md" },
      { path: "notes/b.md", content: "b", filename: "b.md" },
    ]);
    expect(results[0]).toMatchObject({ filePath: "notes/a.md", requestIndex: 0, ok: false, outcome: "failed" });
    expect(results[0]!.error).toContain("HTTP 413");
    expect(results[0]!.error).toContain("Too big. Max 25 MB.");
    expect(results[1]).toMatchObject({ filePath: "notes/b.md", requestIndex: 1, ok: true });
  });

  it("malformed response, or one that does not match the file sent → LhContractError", async () => {
    const malformed = fakeFetch(() => Response.json({ results: [{ filePath: "notes/a.md", ok: "yes" }] }));
    await expect(
      createLhClient({ baseUrl: BASE, fetch: malformed.fetch }).importFiles([{ path: "notes/a.md", content: "a", filename: "a.md" }]),
    ).rejects.toBeInstanceOf(LhContractError);
    const foreign = fakeFetch(() =>
      Response.json({ results: [{ filePath: "other/path.md", requestIndex: 0, outcome: "completed", ok: true, stats: { nodes: 1 } }] }),
    );
    await expect(
      createLhClient({ baseUrl: BASE, fetch: foreign.fetch }).importFiles([{ path: "notes/a.md", content: "a", filename: "a.md" }]),
    ).rejects.toBeInstanceOf(LhContractError);
  });
});

describe("contract broken upstream → LhContractError (ADR 105)", () => {
  const graph = fixture("graph.json") as { propositions: Record<string, unknown>[] };

  it("GET /api/graph with a proposition lacking statement", async () => {
    const broken = { ...graph, propositions: graph.propositions.map((p, i) => (i === 0 ? { ...p, statement: undefined } : p)) };
    const fake = fakeFetch(() => Response.json(broken));
    const err = await createLhClient({ baseUrl: BASE, fetch: fake.fetch }).getGraph().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LhContractError);
    expect(err).toMatchObject({ route: "GET /api/graph" });
    expect((err as LhContractError).issues.length).toBeGreaterThan(0);
  });

  it("GET /api/chats with an unknown kind", async () => {
    const chats = fixture("chats.json") as { chats: Record<string, unknown>[] };
    const fake = fakeFetch(() => Response.json({ chats: [{ ...chats.chats[0], kind: "lecture" }] }));
    const err = await createLhClient({ baseUrl: BASE, fetch: fake.fetch }).listChats().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LhContractError);
    expect(err).toMatchObject({ route: "GET /api/chats" });
  });

  it("GET /api/chats/:id with a message of unknown role", async () => {
    const chat = fixture("chat.json") as { messages: unknown[] };
    const fake = fakeFetch(() => Response.json({ ...chat, messages: [...chat.messages, { id: "m", role: "system", content: "x", timestamp: 1 }] }));
    await expect(createLhClient({ baseUrl: BASE, fetch: fake.fetch }).getChat(CHAT)).rejects.toBeInstanceOf(LhContractError);
  });

  it("POST /api/chat answering 200 without {ok:true}", async () => {
    const fake = fakeFetch(() => Response.json({ accepted: true }));
    await expect(createLhClient({ baseUrl: BASE, fetch: fake.fetch }).sendMessage(CHAT, "x")).rejects.toBeInstanceOf(LhContractError);
  });

  it("GET /api/graph/status with an unknown phase", async () => {
    const fake = fakeFetch(() => Response.json({ runs: [{ id: "a", chatId: "a", title: "t", phase: "thinking", startedAt: 1 }] }));
    await expect(createLhClient({ baseUrl: BASE, fetch: fake.fetch }).graphStatus()).rejects.toBeInstanceOf(LhContractError);
  });

  it("2xx with a body that is not JSON", async () => {
    const fake = fakeFetch(() => new Response("<!doctype html><title>Next.js</title>", { headers: { "content-type": "text/html" } }));
    await expect(createLhClient({ baseUrl: BASE, fetch: fake.fetch }).getGraph()).rejects.toBeInstanceOf(LhContractError);
  });

  it("POST /api/chats answering without an id", async () => {
    const fake = fakeFetch(() => Response.json({ title: "x" }));
    await expect(createLhClient({ baseUrl: BASE, fetch: fake.fetch }).createChat({ title: "x", kind: "teach" })).rejects.toBeInstanceOf(
      LhContractError,
    );
  });
});

describe("subscribeEvents (GET /api/events, SSE)", () => {
  const encoder = new TextEncoder();
  /** Splits the text into chunks of `size` bytes so that frames arrive broken up. */
  function sseResponse(text: string, size: number, opts: { keepOpen?: boolean; signal?: AbortSignal } = {}): Response {
    const bytes = encoder.encode(text);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.slice(i, i + size));
        if (!opts.keepOpen) controller.close();
        opts.signal?.addEventListener("abort", () => controller.error(opts.signal!.reason));
      },
    });
    return new Response(body, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" },
    });
  }

  it("parses the LH frames (chunked), ignores the keep-alive and resolves when LH closes the stream", async () => {
    const fake = fakeFetch(() => sseResponse(fixtureText("events.sse"), 7));
    const events: ServerEvent[] = [];
    await createLhClient({ baseUrl: BASE, fetch: fake.fetch }).subscribeEvents((e) => events.push(e), {
      signal: new AbortController().signal,
    });
    expect(fake.calls.map(routeOf)).toEqual(["GET /api/events"]);
    expect(events).toEqual([
      { type: "chats-changed" },
      { type: "turn-started", chatId: CHAT },
      { type: "record-changed", chatId: CHAT },
      { type: "turn-settled", chatId: CHAT },
      { type: "compaction-changed", chatId: TEACH_CHAT, running: true },
      { type: "jobs-changed" },
      { type: "sources-changed" },
    ]);
  });

  it("a stream with only keep-alives emits nothing", async () => {
    const fake = fakeFetch(() => sseResponse(": ping\n\n: ping\n\n", 3));
    const events: ServerEvent[] = [];
    await createLhClient({ baseUrl: BASE, fetch: fake.fetch }).subscribeEvents((e) => events.push(e), {
      signal: new AbortController().signal,
    });
    expect(events).toEqual([]);
  });

  it("unknown event types are ignored (LH may add events)", async () => {
    const text = 'event: shiny-new-thing\ndata: {"x":1}\n\nevent: turn-settled\ndata: {"chatId":"c1"}\n\n';
    const fake = fakeFetch(() => sseResponse(text, 1000));
    const events: ServerEvent[] = [];
    await createLhClient({ baseUrl: BASE, fetch: fake.fetch }).subscribeEvents((e) => events.push(e), {
      signal: new AbortController().signal,
    });
    expect(events).toEqual([{ type: "turn-settled", chatId: "c1" }]);
  });

  it("a known event with a malformed payload → LhContractError", async () => {
    const fake = fakeFetch(() => sseResponse('event: turn-settled\ndata: {"chat":"c1"}\n\n', 1000));
    await expect(
      createLhClient({ baseUrl: BASE, fetch: fake.fetch }).subscribeEvents(() => undefined, { signal: new AbortController().signal }),
    ).rejects.toBeInstanceOf(LhContractError);
  });

  it("aborting the signal ends the subscription without error", async () => {
    const ac = new AbortController();
    const fake = fakeFetch((req) => sseResponse('event: chats-changed\ndata: {}\n\n', 1000, { keepOpen: true, signal: req.signal }));
    const events: ServerEvent[] = [];
    await expect(
      createLhClient({ baseUrl: BASE, fetch: fake.fetch }).subscribeEvents(
        (e) => {
          events.push(e);
          ac.abort();
        },
        { signal: ac.signal },
      ),
    ).resolves.toBeUndefined();
    expect(events).toEqual([{ type: "chats-changed" }]);
  });

  it("non-2xx response → LhError", async () => {
    const fake = fakeFetch(() => new Response("Bad Gateway", { status: 502 }));
    const err = await createLhClient({ baseUrl: BASE, fetch: fake.fetch })
      .subscribeEvents(() => undefined, { signal: new AbortController().signal })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LhError);
    expect(err).toMatchObject({ status: 502 });
  });
});
