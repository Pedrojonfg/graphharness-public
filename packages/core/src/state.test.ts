import { describe, expect, it } from "vitest";
import {
  applyGradeToProbability,
  computeInferenceBump,
  DEFAULT_INFERENCE_BUMP_SCALE,
  DEFAULT_SOLID_PROBABILITY_THRESHOLD,
  deriveState,
  resolveInferenceBumpScale,
  goalPreparedProbability,
} from "./state.ts";

describe("graph evidence domain", () => {
  it("deriveState respects solid threshold", () => {
    expect(deriveState(0.8, DEFAULT_SOLID_PROBABILITY_THRESHOLD)).toBe("solid");
    expect(deriveState(0.75, DEFAULT_SOLID_PROBABILITY_THRESHOLD)).toBe("solid");
    expect(deriveState(0.5, DEFAULT_SOLID_PROBABILITY_THRESHOLD)).toBe("review");
    expect(deriveState(0.1, DEFAULT_SOLID_PROBABILITY_THRESHOLD)).toBe("weak");
  });

  it("applyGradeToProbability bumps from prior", () => {
    expect(applyGradeToProbability(null, true)).toBe(0.65);
    expect(applyGradeToProbability(0.65, true)).toBe(0.8);
    expect(applyGradeToProbability(null, false)).toBe(0.3);
    const state = deriveState(applyGradeToProbability(0.65, true));
    expect(state).toBe(deriveState(0.8));
  });

  it("computeInferenceBump uses shortest path and edge confidence (053)", () => {
    const chain = {
      edges: [
        { from: "p", to: "m", confidence: "high" as const },
        { from: "m", to: "n", confidence: "high" as const },
      ],
    };
    expect(computeInferenceBump(chain, "p", "n")).toBeCloseTo(
      DEFAULT_INFERENCE_BUMP_SCALE * 1 / 2,
    );
    const skipLow = {
      edges: [
        { from: "p", to: "n", confidence: "low" as const },
        { from: "p", to: "n", confidence: "high" as const },
      ],
    };
    expect(computeInferenceBump(skipLow, "p", "n")).toBeCloseTo(DEFAULT_INFERENCE_BUMP_SCALE);
    expect(computeInferenceBump({ edges: [{ from: "p", to: "n", confidence: "low" }] }, "p", "n")).toBeNull();
  });

  it("computeInferenceBump: fork, medium edge and solid threshold (053)", () => {
    const fork = {
      edges: [
        { from: "p", to: "a", confidence: "high" as const },
        { from: "a", to: "n", confidence: "high" as const },
        { from: "p", to: "b", confidence: "medium" as const },
        { from: "b", to: "n", confidence: "medium" as const },
      ],
    };
    expect(computeInferenceBump(fork, "p", "n")).toBeCloseTo(DEFAULT_INFERENCE_BUMP_SCALE / 2);

    const medium = { edges: [{ from: "p", to: "n", confidence: "medium" as const }] };
    const mediumDelta = computeInferenceBump(medium, "p", "n");
    expect(mediumDelta).toBeCloseTo(DEFAULT_INFERENCE_BUMP_SCALE * 0.65);
    expect(deriveState(Math.min(1, 0.5 + (mediumDelta ?? 0)))).toBe("solid");

    const shorterWeaker = {
      edges: [
        { from: "p", to: "n", confidence: "medium" as const },
        { from: "p", to: "m", confidence: "high" as const },
        { from: "m", to: "n", confidence: "high" as const },
      ],
    };
    expect(computeInferenceBump(shorterWeaker, "p", "n")).toBeCloseTo(DEFAULT_INFERENCE_BUMP_SCALE * 0.65);
    expect(computeInferenceBump(fork, "p", "n", 0.9)).toBeCloseTo(0.45);
    expect(resolveInferenceBumpScale("")).toBe(DEFAULT_INFERENCE_BUMP_SCALE);
    expect(resolveInferenceBumpScale("0.2")).toBe(0.2);
    expect(resolveInferenceBumpScale("nope")).toBe(DEFAULT_INFERENCE_BUMP_SCALE);
  });

  it("goalPreparedProbability averages known nodes", () => {
    const map = new Map([["a", 0.8], ["b", 0.4]]);
    expect(goalPreparedProbability(["a", "b", "c"], map)).toBeCloseTo(0.6);
    expect(goalPreparedProbability(["c"], map)).toBeNull();
  });
});
