// Shared utilities for the INGEST lane tests. Data comes from the synthetic fixtures in packages/lh-client/fixtures/synthetic.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "@graphharness/db";
import type { ChatDetail, ChatListItem, GraphSnapshot, LhClient } from "@graphharness/lh-client";
import { extractSessionItems } from "@graphharness/lh-client";
import type { LlmRequest } from "@graphharness/llm";
import { fakeLh, fakeLlm, type LlmResponder } from "@graphharness/hub/testing";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "packages", "lh-client", "fixtures");
const readJson = (rel: string): any => JSON.parse(readFileSync(join(FIXTURES, rel), "utf8"));

export const TEACH_ID = "chat_k3p8w2ud_7e1b44a0";
export const PRACTICE_ID = "chat_k3p9c5zr_2d80f6b3";
export const TEACH_LAST_MSG = "msg_th_045";
export const PRACTICE_LAST_MSG = "msg_pr_015";
/** Exact counts in fixtures/synthetic/http/graph.json. */
export const GRAPH_PROPOSITIONS = 24;
export const GRAPH_CHAINS = 10;

/** Tool-call ids of the answered questions in the teaching session (fixtures/synthetic/chats). */
export const CALL = {
  probe1: "call_th_probe1",
  probe2: "call_th_probe2",
  recall: "call_th_recall1",
  quizFirstLaw: "call_th_quiz_dk", // "I don't know", plan node "first-law"
  quizPvWork: "call_th_quiz_wrong", // wrong answer, plan node "pv-work"
  quizDismissed: "call_th_quiz_dismissed", // dismissed, plan node "isothermal"
  explainFirstLaw: "call_th_explain_fl", // plan node "first-law"
  explainCarnot: "call_th_explain_carnot", // plan node "carnot"
} as const;
/** Tool-call ids of the practice session: a solved problem and a dismissed one. */
export const PRACTICE_CALL = { solvedConclude: "call_pr_conclude1", solvedProblem: "call_pr_problem1", dismissedProblem: "call_pr_problem2" } as const;
/** Targets of the two practice problems (the isothermal and the adiabatic process propositions). */
export const PRACTICE_TARGET = { solved: "n_b16fd5621355", dismissed: "n_c95d76921e15" } as const;
/** The first-law proposition (also cited, with provenance inside the "first-law" plan span, in the teaching session). */
export const FIRST_LAW_PROP = "n_89577c5c8ac3";
/** A chain with four premises: heat engine, thermal efficiency, Carnot engine, thermal reservoir → Carnot efficiency. */
export const SAMPLE_CHAIN = {
  id: "arg_7c41fcf3e431",
  premises: ["n_8604a76cb7c1", "n_30f493583f6e", "n_e725abacad3c", "n_0fe94d9df002"],
  conclusion: "n_ae06a05b0b24",
} as const;
/** Four propositions handy for curator tests (isothermal process, adiabatic process, ideal gas law, Carnot engine). */
export const CURATE_PROPS = { p1: "n_b16fd5621355", p2: "n_c95d76921e15", p3: "n_92895e233079", p4: "n_e725abacad3c" } as const;

/** Only propositions and chains, as lh-client.getGraph returns them (ADR 105). */
export function loadGraph(): GraphSnapshot {
  const g = readJson("synthetic/http/graph.json");
  return { propositions: g.propositions, chains: g.chains };
}
export function loadChats(): ChatListItem[] {
  return readJson("synthetic/http/chats.json").chats;
}
export function loadChat(id: string): ChatDetail {
  const rec = readJson(`synthetic/chats/${id}.json`);
  return { ...rec, turnInFlight: false, coverage: null };
}
export function teachSpans() {
  return extractSessionItems(loadChat(TEACH_ID)).plan!.spans;
}

export function lhWith(over: { graph?: GraphSnapshot; chats?: ChatListItem[]; chat?: Record<string, ChatDetail> } = {}): LhClient {
  return fakeLh({
    getGraph: async () => over.graph ?? loadGraph(),
    listChats: async () => over.chats ?? loadChats(),
    getChat: async (id: string) => {
      const c = over.chat?.[id];
      if (!c) throw new Error(`fakeLh: chat ${id} not simulated`);
      return c;
    },
  });
}

export type JobInfo = { type: string; payload: Record<string, unknown>; status: string };
export function jobs(db: Db, type?: string, status?: string): JobInfo[] {
  const rows = db.prepare("SELECT type, payload_json, status FROM jobs ORDER BY created_at, id").all() as { type: string; payload_json: string; status: string }[];
  return rows
    .filter((r) => (!type || r.type === type) && (!status || r.status === status))
    .map((r) => ({ type: r.type, payload: JSON.parse(r.payload_json) as Record<string, unknown>, status: r.status }));
}
export const count = (db: Db, sql: string, ...args: unknown[]): number => db.prepare(sql).pluck().get(...args) as number;

export const haystack = (req: LlmRequest): string => JSON.stringify([req.system, req.messages]);

/**
 * Fake LLM that dispatches on the task NAME (the names are not fixed by any contract):
 * /curat/ → curator (ADR 105) · /judge|grade/ → judge (ADR 105) · anything else → picks a concept.
 * Records the kind of each call in `kinds`.
 */
export function llmByKind(r: { curator?: LlmResponder; judge?: LlmResponder; pick?: LlmResponder }) {
  const kinds: ("curator" | "judge" | "pick")[] = [];
  const handler = (req: LlmRequest) => {
    const t = req.task.toLowerCase();
    const kind = /curat/.test(t) ? "curator" : /judge|grade/.test(t) ? "judge" : "pick";
    kinds.push(kind);
    const fn = r[kind];
    if (!fn) throw new Error(`llmByKind: unexpected call of kind ${kind} (task ${req.task})`);
    return fn(req);
  };
  const responders = new Proxy({} as Record<string, LlmResponder>, { get: () => handler });
  return Object.assign(fakeLlm(responders), { kinds });
}

export type PickRule = [RegExp, string | null];
/** Picks a concept by rules over the request text (the first one that matches). */
export const pickBy = (rules: PickRule[]): LlmResponder => (req) => {
  const h = haystack(req);
  for (const [re, conceptId] of rules) if (re.test(h)) return { conceptId, rationale: "test rule" };
  throw new Error(`pickBy: no rule matches the request: ${h.slice(0, 300)}`);
};

/** Rule-based judge: verdict according to the text of the student's answer. */
export const judgeBy = (rules: [RegExp, "correct" | "partial" | "incorrect"][]): LlmResponder => (req) => {
  const h = haystack(req);
  for (const [re, verdict] of rules) if (re.test(h)) return { verdict, rationale: "test rule" };
  throw new Error(`judgeBy: no rule matches: ${h.slice(0, 300)}`);
};
