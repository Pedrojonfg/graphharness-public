// The ONLY Hub module that knows the LearnHarness HTTP routes (ADR 105).
//
// Rules shared by all methods:
// - 2xx response → validated with the schema in types.ts; if it does not match → `LhContractError`.
// - non-2xx response → `LhError` with `status` and `code` = LearnHarness's `body.code` if it carries one
//   (e.g. 503 `models_not_configured`, which is handed back unchanged), otherwise `http_<status>`.
// - fetch rejects (LearnHarness down) → `LhError` with `status: 0`, `code: "unreachable"`.
// - LearnHarness's browser mode has no authentication: no credentials are sent.
import type { z } from "zod";
import { LhContractError, LhError } from "./errors.ts";
import {
  ChatDetailSchema,
  ChatListResponseSchema,
  CoverageExtractResponseSchema,
  CreateChatResponseSchema,
  GraphSnapshotSchema,
  GraphStatusResponseSchema,
  ImportResponseSchema,
  LhErrorBodySchema,
  SendMessageResponseSchema,
  ServerEventSchema,
  SERVER_EVENT_TYPES,
} from "./types.ts";
import type {
  ChatDetail,
  ChatKind,
  ChatListItem,
  CreateChatResponse,
  GraphSnapshot,
  GraphStatusRun,
  ImportResult,
  ServerEvent,
} from "./types.ts";

export interface LhClientOptions {
  /** LearnHarness origin, e.g. "http://127.0.0.1:3000" (with or without a trailing slash: it makes no difference). */
  baseUrl: string;
  /** Injectable for tests; defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
}

/** Proposition carried in `graphContext` (LearnHarness `GraphContextPick`; LearnHarness accepts up to 64). */
export interface GraphContextPick {
  id: string;
  name: string;
  statement: string;
}

export interface CreateChatInput {
  title: string;
  kind: ChatKind;
  graphContext?: { propositions: GraphContextPick[] };
}

/**
 * A file for `POST /api/graph/import`. LearnHarness (its notes-import path validation) requires:
 * a RELATIVE `path` (no leading "/", no "." or "..", no "\\" or ":"), ≤ 1024 characters, whose last
 * segment is `filename` (or `path === filename`). LearnHarness's UI (its notes import queue) also
 * filters before sending: extension .md/.markdown/.txt/.pdf and ≤ 25 MB per file; the client does the same.
 * `path` is the source's identity in LearnHarness (id "src_" + hash of the path).
 */
export interface ImportFile {
  path: string;
  content: Uint8Array | string;
  filename: string;
}

export type ExtractCoverageStatus = "started" | "already_running";

export interface SubscribeOptions {
  signal: AbortSignal;
}

export interface LhClient {
  /** `GET /api/graph` → only `propositions`, `chains` and `fileSources` (ADR 105, ADR 103). */
  getGraph(): Promise<GraphSnapshot>;
  /** `GET /api/chats` → `chats`. */
  listChats(): Promise<ChatListItem[]>;
  /** `GET /api/chats/:id` → record with native messages + `turnInFlight` + `coverage`. 404 → LhError. */
  getChat(id: string): Promise<ChatDetail>;
  /** `GET /api/chats/:id/markdown` → transcript as Markdown (text). */
  getChatMarkdown(id: string): Promise<string>;
  /** `POST /api/chats` with `{title, kind, graphContext?}` → `{id, title}`. */
  createChat(input: CreateChatInput): Promise<CreateChatResponse>;
  /**
   * `POST /api/chat` with `{chatId, input: {type: "text", text}}`. LearnHarness answers 200 `{ok:true}` as soon as
   * it accepts the turn (the turn keeps running on the server; its stream is at GET /api/chats/:id/stream, which
   * the Hub does not use). Resolves once the turn has started. 409 (turn already running), 503
   * `models_not_configured`/`provider_key_missing`, 404 → LhError.
   */
  sendMessage(chatId: string, text: string): Promise<void>;
  /**
   * `POST /api/graph/import` (multipart: `files` + `paths`, interleaved like LearnHarness's UI).
   * Same as the UI (its notes import queue): ONE request per file, up to 3 in parallel,
   * no retries (an ambiguous response may already have merged). Returns one result per file
   * in input order, with `requestIndex` = index in `files` and `filePath` = `path`.
   * A file that does not meet the `ImportFile` requirements is not sent: its result is
   * `{ok:false, outcome:"failed", error}`. A non-2xx HTTP status for one file is also turned
   * into its failed result (`error` = "HTTP <status>: <LearnHarness error>"); the others carry on.
   * An in-band LearnHarness rejection (e.g. `code: "models_not_configured"`) arrives unchanged in the result.
   * A 2xx response that does not match `ImportResponseSchema`, that does not carry exactly one result or
   * whose `filePath` is not the `path` that was sent → LhContractError (LearnHarness's UI applies the same check).
   */
  importFiles(files: ImportFile[]): Promise<ImportResult[]>;
  /** `POST /api/graph/coverage/extract` with `{chatId}`: 202 → "started"; 409 → "already_running" (ADR 105). */
  extractCoverage(chatId: string): Promise<{ status: ExtractCoverageStatus }>;
  /** `GET /api/graph/status` → `runs` (extractions in progress; empty = nothing running). */
  graphStatus(): Promise<GraphStatusRun[]>;
  /**
   * `GET /api/events` (SSE). Calls `onEvent({type, ...payload})` for every `event:`/`data:` frame
   * of a known type; ignores keep-alives (`: ping`) and unknown event types (LearnHarness may add
   * events without breaking the Hub). A frame of a known type whose payload does not match →
   * rejects with LhContractError. LearnHarness sends nothing on connect.
   * Resolves when LearnHarness closes the stream or when `signal` aborts; RECONNECTING (and the full
   * reconciliation on reconnect, ADR 105) is the caller's job.
   */
  subscribeEvents(onEvent: (event: ServerEvent) => void, opts: SubscribeOptions): Promise<void>;
}

// LearnHarness's import limits, replicated so we do not send what it would reject.
const MAX_IMPORT_BYTES = 25 * 1024 * 1024;
const IMPORT_EXTENSIONS = /\.(?:md|markdown|txt|pdf)$/i;
const IMPORT_CONCURRENCY = 3;

function validNotesPath(path: string, filename: string): boolean {
  const parts = path.split("/");
  return (
    path.length > 0 &&
    path.length <= 1024 &&
    !/[\\:\x00-\x1f\x7f]/.test(path) &&
    parts.every((part) => part.length > 0 && part !== "." && part !== "..") &&
    (parts.at(-1) === filename || path === filename)
  );
}

const failedImport = (index: number, path: string, error: string): ImportResult => ({
  requestIndex: index,
  filePath: path,
  outcome: "failed",
  ok: false,
  error,
});

export function createLhClient(opts: LhClientOptions): LhClient {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const doFetch = opts.fetch ?? globalThis.fetch;

  /** fetch + error translation: network down → unreachable; non-2xx → LhError. Returns the 2xx Response. */
  async function call(route: string, path: string, init: RequestInit = {}): Promise<Response> {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, init);
    } catch (cause) {
      if (init.signal?.aborted) throw cause;
      throw new LhError(`${route}: LearnHarness is not responding`, { status: 0, code: "unreachable", cause });
    }
    if (!res.ok) throw await httpError(route, res);
    return res;
  }

  async function httpError(route: string, res: Response): Promise<LhError> {
    const text = await res.text().catch(() => "");
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // non-JSON body (e.g. a plain-text 500) → kept as text.
    }
    const parsed = LhErrorBodySchema.safeParse(body);
    const code = parsed.success && parsed.data.code ? parsed.data.code : `http_${res.status}`;
    const detail = parsed.success ? parsed.data.error : text;
    return new LhError(`${route}: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`, { status: res.status, code, body });
  }

  function validate<S extends z.ZodTypeAny>(route: string, schema: S, data: unknown): z.infer<S> {
    const r = schema.safeParse(data);
    if (!r.success) throw new LhContractError(route, r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`));
    return r.data;
  }

  async function json<S extends z.ZodTypeAny>(route: string, path: string, schema: S, init?: RequestInit): Promise<z.infer<S>> {
    const res = await call(route, path, init);
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      throw new LhContractError(route, ["the 2xx body is not JSON"]);
    }
    return validate(route, schema, data);
  }

  const post = (body: unknown): RequestInit => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  async function importOne(file: ImportFile, index: number): Promise<ImportResult> {
    const { path, filename, content } = file;
    const route = "POST /api/graph/import";
    const blob = new Blob([content] as NonNullable<ConstructorParameters<typeof Blob>[0]>);
    if (!validNotesPath(path, filename)) return failedImport(index, path, `${path}: invalid path or file name`);
    if (!IMPORT_EXTENSIONS.test(filename)) return failedImport(index, path, `${path}: unsupported extension (.md, .markdown, .txt, .pdf)`);
    if (blob.size > MAX_IMPORT_BYTES) return failedImport(index, path, `${path}: Too big. Max 25 MB.`);
    const form = new FormData();
    form.append("files", blob, filename);
    form.append("paths", path);
    let res: Response;
    try {
      res = await doFetch(`${base}/api/graph/import`, { method: "POST", body: form });
    } catch (cause) {
      throw new LhError(`${route}: LearnHarness is not responding`, { status: 0, code: "unreachable", cause });
    }
    if (!res.ok) {
      const err = await httpError(route, res);
      const body = LhErrorBodySchema.safeParse(err.body);
      return failedImport(index, path, `HTTP ${res.status}: ${body.success ? body.data.error : String(err.body)}`);
    }
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      throw new LhContractError(route, ["the 2xx body is not JSON"]);
    }
    const { results } = validate(route, ImportResponseSchema, data);
    const [r] = results;
    if (results.length !== 1 || r === undefined) throw new LhContractError(route, [`expected 1 result but got ${results.length}`]);
    if (r.filePath !== path) throw new LhContractError(route, [`filePath "${r.filePath}" is not the one sent "${path}"`]);
    return { ...r, requestIndex: index };
  }

  async function subscribeEvents(onEvent: (event: ServerEvent) => void, o: SubscribeOptions): Promise<void> {
    const route = "GET /api/events";
    if (o.signal.aborted) return;
    let res: Response;
    try {
      res = await call(route, "/api/events", { headers: { accept: "text/event-stream" }, signal: o.signal });
    } catch (e) {
      if (o.signal.aborted) return;
      throw e;
    }
    if (!res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    const dispatch = (frame: string): void => {
      let type = "";
      const data: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith(":")) continue;
        if (line.startsWith("event:")) type = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (!(SERVER_EVENT_TYPES as readonly string[]).includes(type)) return;
      let payload: unknown;
      try {
        payload = JSON.parse(data.join("\n") || "{}");
      } catch {
        throw new LhContractError(route, [`event ${type}: data is not JSON`]);
      }
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        throw new LhContractError(route, [`event ${type}: data is not an object`]);
      }
      onEvent(validate(route, ServerEventSchema, { ...payload, type }));
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true }).replace(/\r\n?/g, "\n");
        let sep: number;
        while ((sep = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          dispatch(frame);
          if (o.signal.aborted) return;
        }
      }
    } catch (e) {
      if (o.signal.aborted) return;
      if (e instanceof LhContractError) throw e;
      throw new LhError(`${route}: stream interrupted`, { status: 0, code: "unreachable", cause: e });
    } finally {
      reader.cancel().catch(() => undefined);
    }
  }

  return {
    async getGraph() {
      const g = await json("GET /api/graph", "/api/graph", GraphSnapshotSchema);
      // Only propositions + chains (ADR 105: never nodes/edges) + fileSources (srcId → path, ADR 103: subject inheritance by folder).
      return { propositions: g.propositions, chains: g.chains, fileSources: g.fileSources ?? {} };
    },
    async listChats() {
      return (await json("GET /api/chats", "/api/chats", ChatListResponseSchema)).chats;
    },
    getChat: (id) => json("GET /api/chats/:id", `/api/chats/${encodeURIComponent(id)}`, ChatDetailSchema),
    async getChatMarkdown(id) {
      return (await call("GET /api/chats/:id/markdown", `/api/chats/${encodeURIComponent(id)}/markdown`)).text();
    },
    createChat: (input) => json("POST /api/chats", "/api/chats", CreateChatResponseSchema, post(input)),
    async sendMessage(chatId, text) {
      await json("POST /api/chat", "/api/chat", SendMessageResponseSchema, post({ chatId, input: { type: "text", text } }));
    },
    async importFiles(files) {
      const out: ImportResult[] = new Array(files.length);
      let next = 0;
      const worker = async (): Promise<void> => {
        while (next < files.length) {
          const i = next++;
          out[i] = await importOne(files[i]!, i);
        }
      };
      await Promise.all(Array.from({ length: Math.min(IMPORT_CONCURRENCY, files.length) }, worker));
      return out;
    },
    async extractCoverage(chatId) {
      const route = "POST /api/graph/coverage/extract";
      try {
        await json(route, "/api/graph/coverage/extract", CoverageExtractResponseSchema, post({ chatId }));
        return { status: "started" };
      } catch (e) {
        if (e instanceof LhError && e.status === 409) return { status: "already_running" };
        throw e;
      }
    },
    async graphStatus() {
      return (await json("GET /api/graph/status", "/api/graph/status", GraphStatusResponseSchema)).runs;
    },
    subscribeEvents,
  };
}
