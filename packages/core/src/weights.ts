// ADR 106: evidence weight multipliers (missClass, confidence, time).
// final weight = weight_base × m, with m = clamp(missClass × confidence × time, WEIGHT_MIN, WEIGHT_MAX).
import type { EvidenceEventSource } from "./evidence.ts";

export type MissClass = "cue" | "discrimination" | "execution" | "careless" | "structural";

export interface WeightInput {
  source: EvidenceEventSource;
  correct: boolean | null;
  missClass?: MissClass | null;
  confidence?: number | null;
  responseMs?: number | null;
}

/** ADR 106 constants (all configurable via env). */
export interface WeightConfig {
  miss: Record<MissClass, number>;
  confBase: number;
  confSpan: number;
  timeFastMs: number;
  timeFast: number;
  timeSlowMs: number;
  timeSlow: number;
  min: number;
  max: number;
}

/** Finite number from env; empty or non-numeric → default value (like the half-lives in decay.ts). */
function envNum(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function weightConfigFromEnv(env: Record<string, string | undefined>): WeightConfig {
  return {
    miss: {
      careless: envNum(env.WEIGHT_MISS_CARELESS, 0.4),
      execution: envNum(env.WEIGHT_MISS_EXECUTION, 0.8),
      cue: envNum(env.WEIGHT_MISS_CUE, 1),
      discrimination: envNum(env.WEIGHT_MISS_DISCRIMINATION, 1),
      structural: envNum(env.WEIGHT_MISS_STRUCTURAL, 1.2),
    },
    confBase: envNum(env.WEIGHT_CONF_BASE, 0.75),
    confSpan: envNum(env.WEIGHT_CONF_SPAN, 0.5),
    timeFastMs: envNum(env.WEIGHT_TIME_FAST_MS, 5000),
    timeFast: envNum(env.WEIGHT_TIME_FAST, 1.1),
    timeSlowMs: envNum(env.WEIGHT_TIME_SLOW_MS, 30000),
    timeSlow: envNum(env.WEIGHT_TIME_SLOW, 0.9),
    min: envNum(env.WEIGHT_MIN, 0.25),
    max: envNum(env.WEIGHT_MAX, 1.5),
  };
}

const DEFAULT_CONFIG = weightConfigFromEnv({});

export function evidenceWeightMultiplier(input: WeightInput, cfg: WeightConfig = DEFAULT_CONFIG): number {
  if (input.correct === null) return 1;
  let m = 1;
  if (input.source === "lh_practice" && input.correct === false && input.missClass) m *= cfg.miss[input.missClass];
  if (input.confidence !== null && input.confidence !== undefined) {
    m *= cfg.confBase + (cfg.confSpan * Math.min(100, Math.max(0, input.confidence))) / 100;
  }
  if ((input.source === "flashcard" || input.source === "hub_exercise") && input.responseMs !== null && input.responseMs !== undefined) {
    if (input.responseMs <= cfg.timeFastMs) m *= cfg.timeFast;
    else if (input.responseMs >= cfg.timeSlowMs) m *= cfg.timeSlow;
  }
  return Math.min(cfg.max, Math.max(cfg.min, m));
}
