// Ported from graphlearn/packages/contracts/src/error-pattern.ts (65b56d6).
import { createHash } from "node:crypto";

/** ADR 048 — canonical form without PII in global tables (only the hash is aggregated). */
function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) out[key] = sortJsonValue(obj[key]);
    return out;
  }
  return value;
}

export function canonicalUserInputJson(userInput: Record<string, unknown>): string {
  return JSON.stringify(sortJsonValue(userInput));
}

export function userInputPatternHash(userInput: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalUserInputJson(userInput), "utf8").digest("hex");
}
