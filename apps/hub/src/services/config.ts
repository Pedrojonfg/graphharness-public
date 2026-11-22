// All configuration comes from the environment (D22). Domain constants are read by core/ directly.

import { weightConfigFromEnv, type WeightConfig } from "@graphharness/core";

export interface HubConfig {
  lhBaseUrl: string;
  /** Public URL of LH on the tailnet, used to return session links (https://<lh-host>/chat/<id>). */
  lhPublicUrl: string;
  evalUrl: string;
  port: number;
  dbPath: string;
  mcpToken: string;
  materialsDir: string;
  reportsDir: string;
  /** ADR 108: PDF/SVG of compiled TikZ figures. */
  figuresDir: string;
  sessionIdleCloseMin: number;
  declarationConfirmDeferMin: number;
  declarationExpireDays: number;
  flashcardEvidenceWeight: number;
  /** ADR 106: evidence weight multipliers (missClass, confidence, time). */
  weights: WeightConfig;
  backupRepo: string;
  backupScript: string;
  tikzFragmentMaxChars: number;
  tikzCompileTimeoutSec: number;
  tikzCompileMaxRetries: number;
  /** Slots per day of the N-day plan (ADR 105 §7, point 23). */
  planItemsPerDay: number;
}

function num(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Invalid numeric environment variable: ${raw}`);
  return n;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): HubConfig {
  return {
    lhBaseUrl: env.LH_BASE_URL ?? "http://127.0.0.1:3000",
    lhPublicUrl: env.LH_PUBLIC_URL ?? env.LH_BASE_URL ?? "http://127.0.0.1:3000",
    evalUrl: env.EVAL_URL ?? "http://127.0.0.1:8001",
    port: num(env.HUB_PORT, 4100),
    dbPath: env.HUB_DB ?? "/var/lib/hub/hub.sqlite",
    mcpToken: env.HUB_MCP_TOKEN ?? "",
    materialsDir: env.MATERIALS_DIR ?? "/home/lh/materials",
    reportsDir: env.HUB_REPORTS_DIR ?? "/var/lib/hub/reports",
    figuresDir: env.HUB_FIGURES_DIR ?? "/var/lib/hub/figures",
    sessionIdleCloseMin: num(env.SESSION_IDLE_CLOSE_MIN, 45),
    declarationConfirmDeferMin: num(env.DECLARATION_CONFIRM_DEFER_MIN, 10),
    declarationExpireDays: num(env.DECLARATION_EXPIRE_DAYS, 14),
    flashcardEvidenceWeight: num(env.FLASHCARD_EVIDENCE_WEIGHT, 0.5),
    weights: weightConfigFromEnv(env),
    backupRepo: env.BACKUP_REPO ?? "",
    backupScript: env.BACKUP_SCRIPT ?? "/opt/graphharness/infra/scripts/backup.sh",
    tikzFragmentMaxChars: num(env.TIKZ_FRAGMENT_MAX_CHARS, 8000),
    tikzCompileTimeoutSec: num(env.TIKZ_COMPILE_TIMEOUT_SEC, 25),
    tikzCompileMaxRetries: num(env.TIKZ_COMPILE_MAX_RETRIES, 2),
    planItemsPerDay: num(env.PLAN_ITEMS_PER_DAY, 5),
  };
}
