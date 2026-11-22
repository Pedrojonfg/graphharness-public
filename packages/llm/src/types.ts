import type { ZodType } from "zod";

export type LlmProvider = "claude-cli" | "openai-compatible";
export type LlmTier = "cheap" | "strong";

export interface LlmMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LlmUsageRecord {
  task: string;
  provider: LlmProvider;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  ok: boolean;
  promptVersion: string | null;
  /** ISO 8601 UTC. */
  at: string;
}

/** Minimal subset of a ChildProcess used by the client (injectable in tests). */
export interface ChildLike {
  stdin: { write(chunk: string): unknown; end(): unknown };
  stdout: { on(event: "data", cb: (chunk: Buffer | string) => void): unknown };
  stderr: { on(event: "data", cb: (chunk: Buffer | string) => void): unknown };
  on(event: "close", cb: (code: number | null) => void): unknown;
  on(event: "error", cb: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals | number): unknown;
}
export type SpawnFn = (command: string, args: string[]) => ChildLike;

export interface LlmConfig {
  provider: LlmProvider;
  /** CLI model for the cheap tier (haiku, sonnet, opus…). */
  tierCheap: string;
  tierStrong: string;
  baseUrl?: string;
  apiKey?: string;
  /** openai-compatible models. */
  modelCheap?: string;
  modelStrong?: string;
  /** Defaults to 120000. */
  timeoutMs?: number;
  /** Per-instance semaphore; defaults to 2. */
  maxConcurrent?: number;
  onUsage?: (u: LlmUsageRecord) => void;
  spawn?: SpawnFn;
  fetch?: typeof fetch;
}

export interface LlmRequest<T = unknown> {
  task: string;
  tier: LlmTier;
  system: string;
  messages: LlmMessage[];
  jsonSchema?: ZodType<T>;
  /** Prompt version (`<task>.v<N>`), stored in llm_usage. */
  promptVersion?: string;
}

export interface LlmResult<T = unknown> {
  text: string;
  json?: T;
  model: string;
  usage: { inputTokens: number | null; outputTokens: number | null };
}

export interface Llm {
  complete<T = unknown>(req: LlmRequest<T>): Promise<LlmResult<T>>;
}

export class LlmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmError";
  }
}
export class LlmTimeoutError extends LlmError {
  constructor(message: string) {
    super(message);
    this.name = "LlmTimeoutError";
  }
}
/** The model did not return JSON valid for the schema after the retry. */
export class LlmJsonError extends LlmError {
  readonly lastText: string;
  constructor(message: string, lastText: string) {
    super(message);
    this.name = "LlmJsonError";
    this.lastText = lastText;
  }
}
