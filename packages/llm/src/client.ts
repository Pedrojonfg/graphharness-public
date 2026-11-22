// Ported from graphlearn/packages/llm/src/client.ts (65b56d6).
// The structure is kept (2-attempt loop: extract JSON → validate with zod → retry with the
// error); the transport changes: `claude -p` as a child process or openai-compatible with native fetch.
import { spawn as nodeSpawn } from "node:child_process";
import { extractJson } from "./json.ts";
import {
  type ChildLike,
  type Llm,
  type LlmConfig,
  LlmError,
  LlmJsonError,
  type LlmMessage,
  type LlmProvider,
  type LlmRequest,
  type LlmResult,
  LlmTimeoutError,
  type SpawnFn,
} from "./types.ts";

/**
 * Arguments that disable ALL of the CLI's tools. Single constant: `claude` was not installed
 * on the development machine, so this could not be checked with `claude --help`. If the
 * current CLI uses a different flag (`--disallowedTools ...`), change it here.
 */
export const CLAUDE_NO_TOOLS_ARGS: string[] = ["--tools", ""];

/** Exact argument order: `claude -p --output-format json --model <m> <CLAUDE_NO_TOOLS_ARGS>`. */
export const CLAUDE_COMMAND = "claude";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_CONCURRENT = 2;
const PROVIDERS: readonly LlmProvider[] = ["claude-cli", "openai-compatible"];

export function llmConfigFromEnv(env: Record<string, string | undefined>): LlmConfig {
  const provider = env.LLM_PROVIDER || "claude-cli";
  if (!PROVIDERS.includes(provider as LlmProvider))
    throw new LlmError(`Unknown LLM_PROVIDER: "${provider}" (allowed values: ${PROVIDERS.join(", ")}).`);
  return {
    provider: provider as LlmProvider,
    tierCheap: env.LLM_TIER_CHEAP || "haiku",
    tierStrong: env.LLM_TIER_STRONG || "sonnet",
    baseUrl: env.LLM_BASE_URL || undefined,
    apiKey: env.LLM_API_KEY || undefined,
    modelCheap: env.LLM_MODEL_CHEAP || undefined,
    modelStrong: env.LLM_MODEL_STRONG || undefined,
  };
}

/** Response from a single provider call. */
interface RawResult {
  text: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

export function createLlm(config: LlmConfig): Llm {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const limit = semaphore(config.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);
  const spawnFn = config.spawn ?? defaultSpawn;
  const fetchFn = config.fetch ?? fetch;

  /** One call: checks the configuration, waits its turn on the semaphore and records usage. */
  async function call(req: LlmRequest<unknown>, messages: LlmMessage[]): Promise<RawResult> {
    const send =
      config.provider === "claude-cli"
        ? callClaudeCli(spawnFn, cliModel(config, req.tier), req.system, messages, timeoutMs)
        : callOpenAi(fetchFn, config, req.tier, req.system, messages, timeoutMs);
    const model = send.model;
    const record = (ok: boolean, r?: RawResult) =>
      config.onUsage?.({
        task: req.task,
        provider: config.provider,
        model,
        inputTokens: r?.inputTokens ?? null,
        outputTokens: r?.outputTokens ?? null,
        ok,
        promptVersion: req.promptVersion ?? null,
        at: new Date().toISOString(),
      });
    try {
      const r = await limit(send.run);
      record(true, r);
      return r;
    } catch (err) {
      record(false);
      throw err;
    }
  }

  return {
    async complete<T = unknown>(req: LlmRequest<T>): Promise<LlmResult<T>> {
      const messages = [...req.messages];
      const first = await call(req, messages);
      if (!req.jsonSchema) return toResult(first);

      // JSON output: a single retry with the validation error in the prompt.
      let last = first;
      for (let attempt = 1; ; attempt++) {
        const raw = extractJson(last.text);
        let problem: string;
        if (raw === undefined) problem = "The response does not contain a JSON object.";
        else {
          const parsed = req.jsonSchema.safeParse(raw);
          if (parsed.success) return { ...toResult(last), json: parsed.data };
          problem = parsed.error.issues
            .slice(0, 12)
            .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
            .join("\n");
        }
        if (attempt === 2) throw new LlmJsonError(`The model did not return the requested JSON: ${problem}`, last.text);
        messages.push(
          { role: "assistant", content: last.text },
          {
            role: "user",
            content: `Your response does not meet the requested format:\n${problem}\n\nReturn ONLY the corrected JSON object, with no surrounding text.`,
          },
        );
        last = await call(req, messages);
      }
    },
  };
}

function toResult(r: RawResult): LlmResult<never> {
  return { text: r.text, model: r.model, usage: { inputTokens: r.inputTokens, outputTokens: r.outputTokens } };
}

function cliModel(config: LlmConfig, tier: LlmRequest["tier"]): string {
  return tier === "strong" ? config.tierStrong : config.tierCheap;
}

/** Concurrency semaphore: at most `max` calls in flight; the freed slot goes to the next one in the queue. */
function semaphore(max: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async <R>(fn: () => Promise<R>): Promise<R> => {
    if (active < max) active++;
    else await new Promise<void>((resolve) => queue.push(resolve));
    try {
      return await fn();
    } finally {
      const next = queue.shift();
      if (next) next();
      else active--;
    }
  };
}

// ---------------------------------------------------------------------------------------------
// claude-cli

function defaultSpawn(command: string, args: string[]): ChildLike {
  const child = nodeSpawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
  // A failure writing the prompt (EPIPE if the CLI dies before reading it) is treated as a process failure.
  child.stdin.on("error", (err) => child.emit("error", err));
  return child;
}

/** Prompt for stdin: the system prompt first, then the conversation in order, with the role marked. */
function cliPrompt(system: string, messages: LlmMessage[]): string {
  const turns = messages.map((m) => `<${m.role}>\n${m.content}\n</${m.role}>`);
  return `${system}\n\n${turns.join("\n\n")}\n`;
}

function callClaudeCli(spawnFn: SpawnFn, model: string, system: string, messages: LlmMessage[], timeoutMs: number) {
  const run = () =>
    new Promise<RawResult>((resolve, reject) => {
      const child = spawnFn(CLAUDE_COMMAND, ["-p", "--output-format", "json", "--model", model, ...CLAUDE_NO_TOOLS_ARGS]);
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        settle(() => reject(new LlmTimeoutError(`claude did not respond within ${timeoutMs} ms; the process was stopped.`)));
        child.kill("SIGKILL");
      }, timeoutMs);

      child.stdout.on("data", (c) => out.push(toBuffer(c)));
      child.stderr.on("data", (c) => err.push(toBuffer(c)));
      child.on("error", (e) => settle(() => reject(new LlmError(`Could not run claude: ${e.message}`))));
      child.on("close", (code) =>
        settle(() => {
          const stdout = Buffer.concat(out).toString("utf8");
          const stderr = Buffer.concat(err).toString("utf8").trim();
          if (code !== 0) {
            reject(new LlmError(`claude exited with code ${code}: ${(stderr || stdout).slice(0, 2000)}`));
            return;
          }
          try {
            resolve(parseCliOutput(stdout, model));
          } catch (e) {
            reject(e);
          }
        }),
      );

      child.stdin.write(cliPrompt(system, messages));
      child.stdin.end();
    });
  return { model, run };
}

function toBuffer(c: Buffer | string): Buffer {
  return typeof c === "string" ? Buffer.from(c, "utf8") : c;
}

/** Output of `claude -p --output-format json`: `{type:"result", is_error, result, usage}`. */
function parseCliOutput(stdout: string, model: string): RawResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new LlmError(`claude output is not JSON: ${stdout.slice(0, 500)}`);
  }
  const o = (parsed ?? {}) as { is_error?: unknown; result?: unknown; usage?: Record<string, unknown> };
  if (o.is_error === true) throw new LlmError(`claude returned an error: ${String(o.result ?? "").slice(0, 2000)}`);
  if (typeof o.result !== "string") throw new LlmError("claude output has no `result` field.");
  const u = o.usage;
  const num = (v: unknown) => (typeof v === "number" ? v : 0);
  return {
    text: o.result,
    model,
    // The CLI's cache tokens are also input: they are summed so the record is accurate.
    inputTokens: u && typeof u.input_tokens === "number" ? u.input_tokens + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens) : null,
    outputTokens: u && typeof u.output_tokens === "number" ? u.output_tokens : null,
  };
}

// ---------------------------------------------------------------------------------------------
// openai-compatible

function callOpenAi(fetchFn: typeof fetch, config: LlmConfig, tier: LlmRequest["tier"], system: string, messages: LlmMessage[], timeoutMs: number) {
  const model = tier === "strong" ? config.modelStrong : config.modelCheap;
  if (!config.baseUrl) throw new LlmError("LLM_BASE_URL is missing for the openai-compatible provider.");
  if (!model) throw new LlmError(`${tier === "strong" ? "LLM_MODEL_STRONG" : "LLM_MODEL_CHEAP"} is missing for the openai-compatible provider.`);
  const url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  const run = async (): Promise<RawResult> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
      const res = await fetchFn(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ model, messages: [{ role: "system", content: system }, ...messages] }),
        signal: controller.signal,
      });
      if (!res.ok) throw new LlmError(`The provider responded with HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
      const body = (await res.json()) as {
        choices?: { message?: { content?: unknown } }[];
        usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
      };
      const text = body.choices?.[0]?.message?.content;
      if (typeof text !== "string") throw new LlmError("The provider response has no `choices[0].message.content`.");
      return {
        text,
        model,
        inputTokens: typeof body.usage?.prompt_tokens === "number" ? body.usage.prompt_tokens : null,
        outputTokens: typeof body.usage?.completion_tokens === "number" ? body.usage.completion_tokens : null,
      };
    } catch (err) {
      if (controller.signal.aborted) throw new LlmTimeoutError(`The provider did not respond within ${timeoutMs} ms.`);
      if (err instanceof LlmError) throw err;
      throw new LlmError(`Failed to call the provider: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
    }
  };
  return { model, run };
}
