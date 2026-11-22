// Dependencies shared by hub and worker. They are injected so they can be replaced in tests.
import { openDb, type Db } from "@graphharness/db";
import { createLhClient, type LhClient } from "@graphharness/lh-client";
import { createLlm, llmConfigFromEnv, type Llm, type LlmUsageRecord } from "@graphharness/llm";
import { ulid } from "@graphharness/core";
import { configFromEnv, type HubConfig } from "./config.ts";
import { createEvalClient, type EvalClient } from "./eval-client.ts";

export interface HubContext {
  db: Db;
  lh: LhClient;
  /** ONE instance per process: its 2-call semaphore is the "global" one. */
  llm: Llm;
  evalApi: EvalClient;
  config: HubConfig;
  now: () => Date;
}

/** Records every LLM call in `llm_usage`. */
export function usageRecorder(db: Db) {
  return (u: LlmUsageRecord): void => {
    db.prepare(
      "INSERT INTO llm_usage (id, task, provider, model, input_tokens, output_tokens, ok, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(ulid(), u.promptVersion ? `${u.task}@${u.promptVersion}` : u.task, u.provider, u.model, u.inputTokens, u.outputTokens, u.ok ? 1 : 0, u.at);
  };
}

export function createContext(env: NodeJS.ProcessEnv = process.env): HubContext {
  const config = configFromEnv(env);
  const db = openDb(config.dbPath);
  return {
    db,
    config,
    lh: createLhClient({ baseUrl: config.lhBaseUrl }),
    llm: createLlm({ ...llmConfigFromEnv(env), onUsage: usageRecorder(db) }),
    evalApi: createEvalClient({ baseUrl: config.evalUrl }),
    now: () => new Date(),
  };
}
