import { describe, expect, it } from "vitest";
import {
  classifyGradeEvent,
  classifyManualDecayClass,
  decayedProbability,
  DEFAULT_EVIDENCE_HALFLIFE_QUICK_DAYS,
  DEFAULT_EVIDENCE_HALFLIFE_REASONED_DAYS,
  effectiveEvidenceState,
  evidenceHalfLifeDaysFromEnv,
  isEvidenceStaleForDiagnostic,
  resolveEvidenceHalfLifeQuickDays,
} from "./decay.ts";

const HALF = evidenceHalfLifeDaysFromEnv();
const NOW = new Date("2026-10-18T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

describe("classifyGradeEvent (040)", () => {
  it("maps correct open / MCQ and failure to strain", () => {
    expect(classifyGradeEvent({ correct: true, responseFormat: "open" })).toBe("reasoned");
    expect(classifyGradeEvent({ correct: true, responseFormat: "mcq" })).toBe("quick");
    expect(classifyGradeEvent({ correct: false, responseFormat: "open" })).toBe("strain");
    expect(classifyGradeEvent({ correct: false, responseFormat: "mcq" })).toBe("strain");
  });
});

describe("classifyManualDecayClass", () => {
  it("distinguishes pending and confirmed", () => {
    expect(classifyManualDecayClass("pending")).toBe("manual_pending");
    expect(classifyManualDecayClass("confirmed")).toBe("manual_confirmed");
  });
});

describe("decayedProbability", () => {
  it("applies exponential half-life", () => {
    expect(decayedProbability(0.8, "reasoned", 0, HALF)).toBe(0.8);
    expect(decayedProbability(0.8, "reasoned", DEFAULT_EVIDENCE_HALFLIFE_REASONED_DAYS, HALF)).toBe(0.4);
  });
});

describe("effectiveEvidenceState", () => {
  it("re-derives state with P' after decay", () => {
    const { probability, state } = effectiveEvidenceState({
      probability: 0.8,
      decayClass: "reasoned",
      updatedAt: daysAgo(DEFAULT_EVIDENCE_HALFLIFE_REASONED_DAYS),
      now: NOW,
      halfLifeDays: HALF,
    });
    expect(probability).toBe(0.4);
    expect(state).toBe("review");
  });
});

describe("isEvidenceStaleForDiagnostic", () => {
  it("marks stale if ageDays > half-life", () => {
    expect(
      isEvidenceStaleForDiagnostic({
        probability: 0.9,
        decayClass: "quick",
        updatedAt: daysAgo(DEFAULT_EVIDENCE_HALFLIFE_QUICK_DAYS + 1),
        now: NOW,
        halfLifeDays: HALF,
      }),
    ).toBe(true);
  });

  it("marks stale if P' < 0.55 even if the half-life has not passed", () => {
    expect(
      isEvidenceStaleForDiagnostic({
        probability: 0.8,
        decayClass: "reasoned",
        updatedAt: daysAgo(DEFAULT_EVIDENCE_HALFLIFE_REASONED_DAYS),
        now: NOW,
        halfLifeDays: HALF,
      }),
    ).toBe(true);
  });

  it("does not mark stale with recent evidence and high P'", () => {
    expect(
      isEvidenceStaleForDiagnostic({
        probability: 0.85,
        decayClass: "quick",
        updatedAt: daysAgo(1),
        now: NOW,
        halfLifeDays: HALF,
      }),
    ).toBe(false);
  });
});

describe("resolveEvidenceHalfLifeQuickDays", () => {
  it("uses default or valid env", () => {
    expect(resolveEvidenceHalfLifeQuickDays(undefined)).toBe(DEFAULT_EVIDENCE_HALFLIFE_QUICK_DAYS);
    expect(resolveEvidenceHalfLifeQuickDays("45")).toBe(45);
    expect(resolveEvidenceHalfLifeQuickDays("x")).toBe(DEFAULT_EVIDENCE_HALFLIFE_QUICK_DAYS);
  });
});
