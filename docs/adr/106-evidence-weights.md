# ADR 106: evidence weight multipliers (`missClass`, confidence, time)

- **Status:** accepted (Pedro, 2026-11-10; values proposed and approved as is)
- **Context:** ADR 105 §4 (points 10–12). LH already delivers `missClass` in practices and confidence (0–100) in quizzes, and the Hub measures response time on cards and exercises, but none of the three entered the computation of P. The original evidence rule only uses `weight` (1; 0.5 for cards).
- **Decision:** the final weight of an event is `weight_base × m`, where `m` is the product of three multipliers clamped to `[WEIGHT_MIN, WEIGHT_MAX]`. `applyEvidence` does not change: it receives the already-multiplied weight, so rebuilding the state from the log gives the same result.

| Multiplier | When it applies | Value |
|---|---|---|
| **`missClass`** | Only `lh_practice` with `correct = false` | `careless` ×0.4 · `execution` ×0.8 · `cue` ×1.0 · `discrimination` ×1.0 · `structural` ×1.2 |
| **Confidence** `c` (0–100) | Any source with non-null `c`, on both hits and misses | ×(0.75 + 0.5·c/100): from ×0.75 (c = 0) to ×1.25 (c = 100). Without confidence, ×1 |
| **Time** `ms` | Only `flashcard` and `hub_exercise` (where the Hub measures it), on both hits and misses | `ms ≤ 5000` ×1.1 · `ms ≥ 30000` ×0.9 · in between ×1 |

- **Clamping:** `m = clamp(missClass × confidence × time, 0.25, 1.5)`.
- **Reading of confidence:** a correct answer with high confidence confirms (weighs more); a correct answer with low confidence may be luck (weighs less); a miss with high confidence is a firm error (penalizes more); a miss with low confidence was to be expected (penalizes less).
- **Constants** (all via env, like the other state thresholds): `WEIGHT_MISS_CARELESS=0.4`, `WEIGHT_MISS_EXECUTION=0.8`, `WEIGHT_MISS_CUE=1`, `WEIGHT_MISS_DISCRIMINATION=1`, `WEIGHT_MISS_STRUCTURAL=1.2`, `WEIGHT_CONF_BASE=0.75`, `WEIGHT_CONF_SPAN=0.5`, `WEIGHT_TIME_FAST_MS=5000`, `WEIGHT_TIME_FAST=1.1`, `WEIGHT_TIME_SLOW_MS=30000`, `WEIGHT_TIME_SLOW=0.9`, `WEIGHT_MIN=0.25`, `WEIGHT_MAX=1.5`.
- **Storage:** `evidence_events.weight` stores the final weight. Migration `003_weights.sql` adds `miss_class`, `response_ms` and `weight_multiplier` for analysis (`hub_profile`, calibration). They are not part of `UNIQUE(source, ref_json)`: ingestion idempotency does not change.
- **History:** events prior to this ADR keep their weight. Nothing is recomputed.
- **Out of scope:** time on LH questions (the time of the question is not in the tool result; it could be estimated but would be noisy). Tuning the LLM judge's weight with data (ADR 105 §4.13, V3).
