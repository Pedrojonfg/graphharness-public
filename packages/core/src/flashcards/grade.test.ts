import { describe, expect, it } from "vitest";
import {
  gradeParsons,
  gradePredict,
  gradeSpotBug,
  visibleDistractorCount,
} from "./grade.ts";

describe("gradeParsons", () => {
  const order = ["a", "b", "c"] as const;

  it("correct order", () => {
    expect(gradeParsons(order, ["a", "b", "c"])).toBe(true);
  });

  it("different length", () => {
    expect(gradeParsons(order, ["a", "b"])).toBe(false);
    expect(gradeParsons(order, ["a", "b", "c", "d"])).toBe(false);
  });

  it("wrong order", () => {
    expect(gradeParsons(order, ["b", "a", "c"])).toBe(false);
  });
});

describe("gradePredict", () => {
  it("expected and variants via normalizeAnswer", () => {
    expect(gradePredict("6*x^2 + 1", [], "6*x^2+1")).toBe(true);
    expect(gradePredict("no-match", ["6x^2+1"], "6x^2+1")).toBe(true);
    expect(gradePredict("-3/4", ["0.75"], " −3/4 ")).toBe(true);
    expect(gradePredict("1,5", [], "1.5")).toBe(true);
    expect(gradePredict("5", ["6"], "7")).toBe(false);
    expect(gradePredict("x", ["y"], "Y")).toBe(true);
  });
});

describe("gradeSpotBug", () => {
  it("correct id", () => {
    expect(gradeSpotBug("line-2", "line-2")).toBe(true);
  });

  it("wrong id or non-string", () => {
    expect(gradeSpotBug("line-2", "line-1")).toBe(false);
    expect(gradeSpotBug("line-2", 2)).toBe(false);
  });
});

describe("visibleDistractorCount", () => {
  const total = 4;

  it("0–1 failures → all", () => {
    expect(visibleDistractorCount(total, 0)).toBe(total);
    expect(visibleDistractorCount(total, 1)).toBe(total);
  });

  it("2 failures → half (ceil)", () => {
    expect(visibleDistractorCount(total, 2)).toBe(2);
    expect(visibleDistractorCount(5, 2)).toBe(3);
  });

  it("≥3 failures → none", () => {
    expect(visibleDistractorCount(total, 3)).toBe(0);
    expect(visibleDistractorCount(total, 10)).toBe(0);
  });
});
