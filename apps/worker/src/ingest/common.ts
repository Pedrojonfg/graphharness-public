// Ingest lane: utilities shared by the ingest jobs (LLM with validated JSON, session cursor, meta).
import { isoNow } from "@graphharness/core";
import type { Db } from "@graphharness/db";
import { fillPrompt, loadPrompt } from "@graphharness/llm";
import type { HubContext } from "@graphharness/hub/services/context";
import type { ZodType } from "zod";

/**
 * `cheap` LLM call with the versioned prompt `<task>.v<N>.md` (instructions + data via `{{var}}`) as the
 * `system` message, with JSON output validated by zod (a retry with the error is done by the client).
 */
export async function askJson<T>(ctx: HubContext, task: string, vars: Record<string, string | number>, schema: ZodType<T>): Promise<T> {
  const prompt = loadPrompt(task);
  const res = await ctx.llm.complete({
    task,
    tier: "cheap",
    system: fillPrompt(prompt.text, vars),
    messages: [{ role: "user", content: "Return only the requested JSON object, with no surrounding text." }],
    jsonSchema: schema,
    promptVersion: prompt.version,
  });
  if (res.json === undefined) throw new Error(`${task}: the LLM did not return JSON`);
  return res.json;
}

/** Human-readable JSON for embedding in a prompt. */
export const pretty = (value: unknown): string => JSON.stringify(value, null, 2);

/**
 * `lh_sessions.ingest_cursor_json`: `messageId` = last message processed by session-ingest; `updatedAt` and
 * `messageCount` = the last values seen in the LH record (lh-sync notes them when it enqueues the ingest, and session-ingest when it finishes; lh-sync compares them with `GET /api/chats` to know whether there is a new turn).
 */
export interface IngestCursor {
  messageId?: string | null;
  updatedAt?: string;
  messageCount?: number;
}

export function parseCursor(json: string | null | undefined): IngestCursor {
  if (!json) return {};
  const v = JSON.parse(json) as unknown;
  return v && typeof v === "object" && !Array.isArray(v) ? (v as IngestCursor) : {};
}

export function setMeta(db: Db, key: string, value: string, now: Date): void {
  db.prepare(
    "INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  ).run(key, value, isoNow(now));
}

export function getMeta(db: Db, key: string): string | null {
  return (db.prepare("SELECT value FROM meta WHERE key = ?").pluck().get(key) as string | undefined) ?? null;
}

/** `meta` key holding the srcId → path map of the notes imported into LH (written by lh-sync, read by the curator). */
export const META_LH_FILE_SOURCES = "lh_file_sources";
/** `meta` key with the time of the last successful lh-sync (for /health). */
export const META_LAST_LH_SYNC = "last_lh_sync_at";
