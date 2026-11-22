# ADR 101 — Decay is applied before adding the delta

- **Status:** accepted (Pedro, 2026-11-09)
- **Context:** GL (`apps/api/src/evidence/record-step-outcome.ts`) added a grade's delta on top of the stored P without decaying it. A forgotten concept went back to "solid" after a single correct answer.
- **Decision:** `applyEvidence` (packages/core/src/evidence.ts) computes `base = decayedProbability(P, class, age)` and then adds `±Δ·weight` (step 3 of the evidence-recording procedure). The same applies to confirmations (step 2).
- **Consequence:** a deliberate deviation from GL; the core tests pin it down.
