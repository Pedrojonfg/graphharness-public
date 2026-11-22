// Test doubles and utilities for hub and worker tests. Not used in production.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isoNow, ulid } from "@graphharness/core";
import { openDb, type Db } from "@graphharness/db";
import type { LhClient } from "@graphharness/lh-client";
import type { Llm, LlmRequest, LlmResult } from "@graphharness/llm";
import { configFromEnv } from "./services/config.ts";
import type { HubContext } from "./services/context.ts";
import { createEvalClient, type EvalClient } from "./services/eval-client.ts";

/** Fake LH: methods not provided throw, so a test never depends on LH by accident. */
export function fakeLh(impl: Partial<LhClient> = {}): LhClient {
  return new Proxy(impl as LhClient, {
    get(target, prop: string) {
      if (prop in target) return target[prop as keyof LhClient];
      return () => Promise.reject(new Error(`fakeLh: ${prop} is not simulated in this test`));
    },
  });
}

export type LlmResponder = (req: LlmRequest) => string | object;

/**
 * Fake LLM per task. If the request carries a jsonSchema, it validates the response just like the real client
 * (no retry: a badly written responder must fail the test). Records the calls in `calls`.
 */
export function fakeLlm(responders: Record<string, LlmResponder> = {}): Llm & { calls: LlmRequest[] } {
  const calls: LlmRequest[] = [];
  return {
    calls,
    async complete<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
      calls.push(req as LlmRequest);
      const r = responders[req.task];
      if (!r) throw new Error(`fakeLlm: no response for task "${req.task}"`);
      const out = r(req as LlmRequest);
      const text = typeof out === "string" ? out : JSON.stringify(out);
      const json = req.jsonSchema ? req.jsonSchema.parse(typeof out === "string" ? JSON.parse(out) : out) : undefined;
      return { text, json, model: `fake-${req.tier}`, usage: { inputTokens: null, outputTokens: null } };
    },
  };
}

/** Fake eval: methods not provided throw. For real grading use `startEval()`. */
export function fakeEval(impl: Partial<EvalClient> = {}): EvalClient {
  return new Proxy(impl as EvalClient, {
    get(target, prop: string) {
      if (prop in target) return target[prop as keyof EvalClient];
      return () => Promise.reject(new Error(`fakeEval: ${prop} is not simulated in this test`));
    },
  });
}

export function makeTestContext(over: Partial<HubContext> & { nowIso?: string } = {}): HubContext & { db: Db } {
  let now = new Date(over.nowIso ?? "2026-11-10T09:00:00.000Z");
  return {
    db: over.db ?? openDb(":memory:"),
    lh: over.lh ?? fakeLh(),
    llm: over.llm ?? fakeLlm(),
    evalApi: over.evalApi ?? fakeEval(),
    config: over.config ?? {
      ...configFromEnv({}),
      mcpToken: "test-token",
      reportsDir: "/tmp/graphharness-test-reports",
      figuresDir: "/tmp/graphharness-test-figures",
    },
    now: over.now ?? (() => now),
    ...(over.now ? {} : { setNow: (iso: string) => (now = new Date(iso)) }),
  } as HubContext & { db: Db };
}

/** Advances the clock of a context created with makeTestContext (without its own `now`). */
export function setNow(ctx: HubContext, iso: string): void {
  (ctx as unknown as { setNow: (iso: string) => void }).setNow(iso);
}

const EVAL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "eval");

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => res(port));
    });
    s.on("error", rej);
  });
}

/** Starts the REAL eval (uvicorn) on a free port: a real boundary for exercise/template tests. */
export async function startEval(): Promise<{ url: string; client: EvalClient; stop: () => void }> {
  const port = await freePort();
  const proc: ChildProcess = spawn("uv", ["run", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: EVAL_DIR,
    stdio: "ignore",
  });
  const url = `http://127.0.0.1:${port}`;
  const client = createEvalClient({ baseUrl: url });
  for (let i = 0; i < 300; i++) {
    if (await client.health()) return { url, client, stop: () => proc.kill() };
    await new Promise((r) => setTimeout(r, 200));
  }
  proc.kill();
  throw new Error("eval did not start within 60 s");
}

// ── Minimal seeds (direct SQL, no domain logic) ───────────────────────────────

export function seedSubject(db: Db, over: { id?: string; name?: string; kind?: "general" | "computable_math" | "programming"; lhSourceFolder?: string } = {}): string {
  const id = over.id ?? ulid();
  const name = over.name ?? "Linear Algebra";
  db.prepare("INSERT INTO subjects (id, name, slug, kind, lh_source_folder, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    id,
    name,
    `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${id.slice(-4).toLowerCase()}`,
    over.kind ?? "general",
    over.lhSourceFolder ?? null,
    isoNow(),
  );
  return id;
}

export function seedConcept(
  db: Db,
  over: { id?: string; subjectId?: string | null; name?: string; description?: string; computable?: boolean } = {},
): string {
  const id = over.id ?? ulid();
  db.prepare(
    "INSERT INTO concepts (id, subject_id, name, description, computable, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'curator', ?, ?)",
  ).run(id, over.subjectId ?? null, over.name ?? `Concept ${id.slice(-4)}`, over.description ?? "Description.", over.computable ? 1 : 0, isoNow(), isoNow());
  return id;
}

export function seedProposition(db: Db, over: { id?: string; name?: string; statement?: string; conceptId?: string; provenance?: { chatId: string; messageId: string }[] } = {}): string {
  const id = over.id ?? `n_${ulid().slice(-12).toLowerCase()}`;
  db.prepare(
    "INSERT INTO lh_propositions (id, name, statement, provenance_json, first_seen_at, last_synced_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, over.name ?? id, over.statement ?? `Statement of ${id}.`, JSON.stringify(over.provenance ?? []), isoNow(), isoNow());
  if (over.conceptId)
    db.prepare("INSERT INTO concept_propositions (proposition_id, concept_id, assigned_by, assigned_at) VALUES (?, ?, 'curator', ?)").run(id, over.conceptId, isoNow());
  return id;
}

export function seedEdge(db: Db, from: string, to: string, confidence: "high" | "medium" | "low" = "high", source: "derived" | "curator" | "manual" = "derived"): void {
  db.prepare("INSERT INTO concept_edges (from_concept, to_concept, confidence, chain_support, source) VALUES (?, ?, ?, 3, ?)").run(from, to, confidence, source);
}
