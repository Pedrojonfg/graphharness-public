// Shared utilities for the tests of the KNOWLEDGE and SESSIONS lanes (tests only).
import { isoNow, ulid } from "@graphharness/core";
import type { Db } from "@graphharness/db";
import type { Llm, LlmRequest, LlmResult } from "@graphharness/llm";
import type { Hono } from "hono";
import type { z } from "zod";
import { createApp } from "../../src/app.ts";
import { configFromEnv, type HubConfig } from "../../src/services/config.ts";
import type { HubContext } from "../../src/services/context.ts";
import { recordEvidence } from "../../src/services/evidence.ts";
import { refreshConceptFts } from "../../src/services/fts.ts";
import { makeTestContext, seedConcept, seedProposition, seedSubject } from "../../src/testing.ts";

export const NOW = "2026-11-10T09:00:00.000Z";
export const DAY = 86_400_000;
export const iso = (ms: number): string => new Date(ms).toISOString();
export const daysFromNow = (d: number): string => iso(Date.parse(NOW) + d * DAY);

export type Ctx = HubContext & { db: Db };

// ---------------------------------------------------------------- LLM that answers ANY task

let counter = 0;
const next = (): number => ++counter;

/** Generates a value that matches a zod v3 schema (to answer LLM tasks whose name we do not know). */
export function sample(schema: z.ZodTypeAny): unknown {
  // minimal zod v3 introspection (_def.typeName); it only covers what the Hub's prompts use.
  const def = schema._def as any;
  switch (def.typeName) {
    case "ZodString": {
      const checks: any[] = def.checks ?? [];
      if (checks.some((c) => c.kind === "datetime")) return isoNow(new Date(NOW));
      if (checks.some((c) => c.kind === "url")) return "https://example.com/x";
      let s = `Test text ${next()}`;
      const min = checks.find((c) => c.kind === "min")?.value ?? 0;
      while (s.length < min) s += " filler";
      return s;
    }
    case "ZodNumber": {
      const checks: any[] = def.checks ?? [];
      const min = checks.find((c) => c.kind === "min")?.value ?? 0;
      const max = checks.find((c) => c.kind === "max")?.value ?? Infinity;
      return Math.min(Math.max(0, min), max);
    }
    case "ZodBoolean":
      return true;
    case "ZodEnum":
      return def.values[0];
    case "ZodLiteral":
      return def.value;
    case "ZodArray": {
      const n = Math.max(def.minLength?.value ?? 1, def.exactLength?.value ?? 0);
      return Array.from({ length: n }, () => sample(def.type));
    }
    case "ZodObject": {
      const shape = def.shape();
      return Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, sample(v as z.ZodTypeAny)]));
    }
    case "ZodOptional":
    case "ZodNullable":
      return sample(def.innerType);
    case "ZodDefault":
      return sample(def.innerType);
    case "ZodEffects":
      return sample(def.schema);
    case "ZodUnion":
      return sample(def.options[0]);
    case "ZodDiscriminatedUnion":
      return sample([...def.options.values()][0]);
    case "ZodRecord":
      return {};
    default:
      return "x";
  }
}

export type AutoLlm = Llm & { calls: LlmRequest[] };

/** Fake LLM: for each task it uses `over[task]` or, otherwise, a response generated from `jsonSchema`. Records `calls`. */
export function autoLlm(over: Record<string, (req: LlmRequest) => string | object> = {}): AutoLlm {
  const calls: LlmRequest[] = [];
  return {
    calls,
    async complete<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
      calls.push(req as LlmRequest);
      const r = over[req.task];
      const out = r ? r(req as LlmRequest) : req.jsonSchema ? (sample(req.jsonSchema) as object) : "Test text";
      const text = typeof out === "string" ? out : JSON.stringify(out);
      const json = req.jsonSchema ? req.jsonSchema.parse(typeof out === "string" ? JSON.parse(out) : out) : undefined;
      return { text, json, model: `fake-${req.tier}`, usage: { inputTokens: null, outputTokens: null } };
    },
  };
}

/** LLM that always fails (the report must be saved with data only, the rerank must degrade to FTS). */
export function brokenLlm(): AutoLlm {
  const calls: LlmRequest[] = [];
  return {
    calls,
    async complete<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
      calls.push(req as LlmRequest);
      throw new Error("LLM unavailable (test)");
    },
  };
}

// ---------------------------------------------------------------- context and HTTP

export function world(over: Omit<NonNullable<Parameters<typeof makeTestContext>[0]>, "config"> & { config?: Partial<HubConfig> } = {}): { ctx: Ctx; app: Hono } {
  const ctx = makeTestContext({
    llm: autoLlm(),
    ...over,
    config: { ...configFromEnv({}), mcpToken: "test-token", reportsDir: "/tmp/graphharness-test-reports", ...(over.config ?? {}) },
  });
  return { ctx, app: createApp(ctx, { pwaDist: "/nonexistent" }) };
}

export interface Res {
  status: number;
  json: any;
  headers: Headers;
  raw: Response;
}

export async function call(app: Hono, method: string, path: string, body?: unknown): Promise<Res> {
  const res = await app.request(`/api/v1${path}`, {
    method: method.toUpperCase(),
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const isJson = (res.headers.get("content-type") ?? "").includes("json");
  const clone = res.clone();
  return { status: res.status, json: isJson ? await res.json() : null, headers: res.headers, raw: clone };
}

/** Parses with the contract's schema and returns the value (the test fails with the detail if it does not match). */
export function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  return schema.parse(value);
}

// ---------------------------------------------------------------- evidence seeds

let refSeq = 0;
export type Mastery = "solid" | "review" | "weak" | "pending";

/**
 * Seeds evidence with `recordEvidence` and leaves, with the clock at NOW (age 0, no decay):
 * solid = 3 open hits (P 0.95) · review = 1 hit (0.65) · weak = 1 miss (0.30) ·
 * pending = 'solid' declaration (0.85, manual_pending).
 */
export function mastery(ctx: Ctx, conceptId: string, kind: Mastery, at = NOW): void {
  const base = { conceptId, at, inferred: false, weight: 1 };
  const grade = (correct: boolean) =>
    recordEvidence(
      ctx.db,
      { ...base, source: "lh_quiz", correct, responseFormat: "open", ref: { chatId: "c_seed", toolCallId: `t${++refSeq}` } },
      new Date(at),
    );
  if (kind === "solid") [1, 2, 3].forEach(() => grade(true));
  else if (kind === "review") grade(true);
  else if (kind === "weak") grade(false);
  else
    recordEvidence(
      ctx.db,
      { ...base, source: "declaration", correct: null, responseFormat: null, targetState: "solid", justification: "seed", ref: { declarationId: `d${++refSeq}` } },
      new Date(at),
    );
}

export function conceptIn(ctx: Ctx, subjectId: string | null, name: string, props: string[] = [], description = "Description."): string {
  const id = seedConcept(ctx.db, { subjectId, name, description });
  for (const statement of props) seedProposition(ctx.db, { statement, conceptId: id });
  refreshConceptFts(ctx.db, id);
  return id;
}

export const subject = (ctx: Ctx, name = "Linear Algebra"): string => seedSubject(ctx.db, { name });

// ---------------------------------------------------------------- direct SQL (tables without a seed in testing.ts)

export function insertDeclaration(
  db: Db,
  o: { id?: string; conceptId: string; status?: string; createdAt: string; origin?: "agent" | "pwa" },
): string {
  const id = o.id ?? ulid();
  db.prepare(
    "INSERT INTO declarations (id, concept_id, target_state, justification, origin, status, created_at) VALUES (?, ?, 'solid', 'seed', ?, ?, ?)",
  ).run(id, o.conceptId, o.origin ?? "agent", o.status ?? "pending", o.createdAt);
  return id;
}

export function insertSuggestion(
  db: Db,
  kind: "merge" | "split",
  payload: object,
  o: { status?: "open" | "accepted" | "dismissed"; rationale?: string } = {},
): string {
  const id = ulid();
  db.prepare("INSERT INTO concept_suggestions (id, kind, payload_json, rationale, status, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    id,
    kind,
    JSON.stringify(payload),
    o.rationale ?? "Because.",
    o.status ?? "open",
    NOW,
  );
  return id;
}

export function insertTemplate(db: Db, conceptId: string, o: { name?: string; status?: "active" | "failed" | "retired"; validation?: object } = {}): string {
  const id = ulid();
  db.prepare(
    "INSERT INTO templates (id, concept_id, slug, name, recipe_json, level, status, validation_json, created_at) VALUES (?, ?, ?, ?, '{}', 'base', ?, ?, ?)",
  ).run(id, conceptId, `tpl-${id.toLowerCase()}`, o.name ?? "Test method", o.status ?? "active", o.validation ? JSON.stringify(o.validation) : null, NOW);
  return id;
}

export function insertTemplateError(db: Db, templateId: string, key: string, description: string, timesSeen: number): string {
  const id = ulid();
  db.prepare(
    "INSERT INTO template_errors (id, template_id, key, description, expr, origin, times_seen, last_seen_at) VALUES (?, ?, ?, ?, '0', 'recipe', ?, ?)",
  ).run(id, templateId, key, description, timesSeen, timesSeen > 0 ? NOW : null);
  return id;
}

export function insertCard(
  db: Db,
  o: { conceptId: string; purpose?: "review" | "confirmation"; intervalDays?: number; tRefMs?: number; reviewed?: boolean; retired?: boolean; createdAt?: string },
): string {
  const id = ulid();
  db.prepare(
    `INSERT INTO cards (id, concept_id, kind, purpose, front_text, answer_json, ease, interval_days, repetitions, t_ref, reviewed, retired, created_at)
     VALUES (?, ?, 'text', ?, 'Question', '{"text":"x","accepted":["x"]}', 2.5, ?, 1, ?, ?, ?, ?)`,
  ).run(id, o.conceptId, o.purpose ?? "review", o.intervalDays ?? 1, o.tRefMs ?? Date.parse(NOW), o.reviewed === false ? 0 : 1, o.retired ? 1 : 0, o.createdAt ?? daysFromNow(-1));
  return id;
}

export function insertSession(
  db: Db,
  o: { chatId: string; title?: string; kind?: "teaching" | "practice"; subjectId?: string | null; hubState?: string; settledAt?: string | null; closedAt?: string | null; startedBy?: string | null },
): void {
  db.prepare(
    "INSERT INTO lh_sessions (chat_id, title, kind, subject_id, started_by, last_turn_settled_at, hub_state, closed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(o.chatId, o.title ?? `Session ${o.chatId}`, o.kind ?? "teaching", o.subjectId ?? null, o.startedBy ?? null, o.settledAt ?? null, o.hubState ?? "open", o.closedAt ?? null);
}

export function sessionReportData(chatId: string, subjectId: string | null, over: { text?: object | null } = {}): object {
  return {
    schemaVersion: 1,
    chatId,
    title: `Session ${chatId}`,
    subjectId,
    subjectName: subjectId ? "Linear Algebra" : null,
    closedAt: NOW,
    conceptsTouched: [],
    questions: [],
    practices: [],
    errors: [],
    declarations: [],
    cardsCreated: 0,
    nextRecommendation: [],
    text: over.text === undefined ? { summary: "First sentence. Second sentence. Third sentence.", reviewMaterial: [], mistakes: [] } : over.text,
    verifiedFormulas: [],
  };
}

export function masterReportData(subjectId: string): object {
  return {
    schemaVersion: 1,
    subjectId,
    subjectName: "Linear Algebra",
    generatedAt: NOW,
    reviewFrontier: [],
    weakAndReview: [],
    recurringErrors: [],
    unpatternedFailures: 0,
    consolidated: [],
    upcomingExams: [],
  };
}

export const MINIMAL_TEX = "\\documentclass{article}\n\\begin{document}\nHello report.\n\\end{document}\n";

export function insertReport(
  db: Db,
  o: { id?: string; kind: "session" | "master"; chatId?: string | null; subjectId?: string | null; data: object; tex?: string | null; pdfPath?: string | null; createdAt?: string },
): string {
  const id = o.id ?? ulid();
  db.prepare("INSERT INTO reports (id, kind, chat_id, subject_id, data_json, tex, pdf_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    id,
    o.kind,
    o.chatId ?? null,
    o.subjectId ?? null,
    JSON.stringify(o.data),
    o.tex === undefined ? MINIMAL_TEX : o.tex,
    o.pdfPath ?? null,
    o.createdAt ?? NOW,
  );
  return id;
}

export const count = (db: Db, sql: string, ...args: unknown[]): number => db.prepare(sql).pluck().get(...args) as number;

export function fakeJob(type: string, payload: Record<string, unknown> = {}) {
  return { id: "j_test", type, payload, status: "running" as const, attempts: 1, runAfter: NOW, lastError: null };
}
