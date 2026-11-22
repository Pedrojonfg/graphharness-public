// Tests for syllabus.ts (ADR 105 §6, point 22): syllabus parser and coverage of a topic by concepts.
import { describe, expect, it } from "vitest";
import { parseSyllabus, syllabusCoverage } from "./syllabus.ts";

describe("parseSyllabus", () => {
  it("one line = one topic; consecutive position from 0; level 0 without indentation", () => {
    const r = parseSyllabus("Matrices\nDeterminants\nVector spaces");
    expect(r.errors).toEqual([]);
    expect(r.items).toEqual([
      { position: 0, level: 0, title: "Matrices" },
      { position: 1, level: 0, title: "Determinants" },
      { position: 2, level: 0, title: "Vector spaces" },
    ]);
  });

  it("strips the optional markers '- ', '* ', '1. ' and '1) ' (also with multi-digit numbers)", () => {
    const r = parseSyllabus("- Matrices\n* Determinants\n1. Rank\n2) Kernel\n12. Image");
    expect(r.items.map((i) => i.title)).toEqual(["Matrices", "Determinants", "Rank", "Kernel", "Image"]);
  });

  it("a number that is not a marker is part of the title", () => {
    expect(parseSyllabus("3D: geometry of space").items[0]!.title).toBe("3D: geometry of space");
  });

  it("2 spaces or one tab of indentation = one level; the marker goes after the indentation", () => {
    const r = parseSyllabus("Topic 1\n  - Subtopic 1.1\n    * Section 1.1.1\n\tSubtopic 1.2\n\t\tSection 1.2.1");
    expect(r.items.map((i) => [i.level, i.title])).toEqual([
      [0, "Topic 1"],
      [1, "Subtopic 1.1"],
      [2, "Section 1.1.1"],
      [1, "Subtopic 1.2"],
      [2, "Section 1.2.1"],
    ]);
  });

  it("the maximum level is 3: deeper indentation is capped at 3 without error", () => {
    const r = parseSyllabus("      Level three\n          Level five\n\t\t\t\t\tLevel five with tabs");
    expect(r.items.map((i) => i.level)).toEqual([3, 3, 3]);
    expect(r.errors).toEqual([]);
  });

  it("empty or whitespace-only lines are ignored and do not consume a position", () => {
    const r = parseSyllabus("\nMatrices\n\n   \n\t\nDeterminants\n");
    expect(r.items).toEqual([
      { position: 0, level: 0, title: "Matrices" },
      { position: 1, level: 0, title: "Determinants" },
    ]);
    expect(r.errors).toEqual([]);
  });

  it("trims the title (trailing spaces and CRLF line end)", () => {
    const r = parseSyllabus("- Matrices   \r\n  Determinants \t\r\n");
    expect(r.items.map((i) => i.title)).toEqual(["Matrices", "Determinants"]);
  });

  it("a 200-character title is valid; 201 → error and it is skipped, with no gap in position", () => {
    const ok = "a".repeat(200);
    const long = "b".repeat(201);
    const r = parseSyllabus(`First\n${long}\n${ok}`);
    expect(r.items).toEqual([
      { position: 0, level: 0, title: "First" },
      { position: 1, level: 0, title: ok },
    ]);
    expect(r.errors).toHaveLength(1);
  });

  it("length is measured on the already trimmed title (without indentation or marker)", () => {
    const r = parseSyllabus(`    - ${"c".repeat(200)}   `);
    expect(r.errors).toEqual([]);
    expect(r.items[0]).toEqual({ position: 0, level: 2, title: "c".repeat(200) });
  });

  it("maximum 300 topics: the rest is discarded with an error", () => {
    const text = Array.from({ length: 305 }, (_, i) => `Topic ${i}`).join("\n");
    const r = parseSyllabus(text);
    expect(r.items).toHaveLength(300);
    expect(r.items.at(-1)).toEqual({ position: 299, level: 0, title: "Topic 299" });
    expect(r.errors.length).toBeGreaterThanOrEqual(1);
  });

  it("exactly 300 topics: no error", () => {
    const r = parseSyllabus(Array.from({ length: 300 }, (_, i) => `Topic ${i}`).join("\n"));
    expect(r.items).toHaveLength(300);
    expect(r.errors).toEqual([]);
  });

  it("empty text → no topics or errors", () => {
    expect(parseSyllabus("")).toEqual({ items: [], errors: [] });
  });
});

const concept = (conceptId: string, name: string, description = "", statements = "") => ({ conceptId, name, description, statements });

describe("syllabusCoverage", () => {
  it("seen if a concept contains all the title's tokens; returns that concept", () => {
    const r = syllabusCoverage("Diagonalization of matrices", [
      concept("c1", "Double integrals"),
      concept("c2", "Diagonalization", "Write matrices as PDP^-1"),
    ]);
    expect(r).toEqual({ conceptId: "c2", matched: 2, total: 2, seen: true });
  });

  it("ignores accents and case on both sides", () => {
    expect(syllabusCoverage("FRÉCHET", [concept("c1", "frechet")]).seen).toBe(true);
    expect(syllabusCoverage("frechet", [concept("c1", "Fréchet")]).seen).toBe(true);
  });

  it("searches name, description and statements together", () => {
    const r = syllabusCoverage("Eigenvalues eigenvectors polynomial", [
      concept("c1", "Eigenvalues", "Roots of the characteristic polynomial", "Each eigenvalue has associated eigenvectors"),
    ]);
    expect(r).toMatchObject({ conceptId: "c1", matched: 3, total: 3, seen: true });
  });

  it("60 % threshold: 3 of 5 tokens → seen", () => {
    const r = syllabusCoverage("Rank kernel image dimension applications", [concept("c1", "Rank", "Kernel and image")]);
    expect(r).toMatchObject({ matched: 3, total: 5, seen: true });
  });

  it("60 % threshold: 2 of 4 tokens (50 %) → not seen", () => {
    const r = syllabusCoverage("Rank kernel dimension applications", [concept("c1", "Rank", "Kernel of a matrix")]);
    // not seen → conceptId null even if there is a better concept
    expect(r).toEqual({ conceptId: null, matched: 2, total: 4, seen: false });
  });

  it("discards tokens shorter than 4 letters (and with them of, the, and, in)", () => {
    // "law" (3) does not count: only "hooke" remains, which the concept contains → 1/1
    expect(syllabusCoverage("Law of Hooke", [concept("c1", "Hooke", "Elastic springs")])).toMatchObject({ matched: 1, total: 1, seen: true });
  });

  it("discards English stopwords ('with') even though they have 4 letters", () => {
    // tokens: applications, matrices (without 'with'). The concept has 'matrices' and 'with' → 1/2 = 50 % → not seen.
    // If 'with' counted, it would be 2/3 ≈ 67 % → seen.
    const r = syllabusCoverage("Applications with matrices", [concept("c1", "Matrices", "Tools with calculators")]);
    expect(r).toEqual({ conceptId: null, matched: 1, total: 2, seen: false });
  });

  it("compares whole normalized tokens, not substrings", () => {
    expect(syllabusCoverage("Matrices", [concept("c1", "Submatrices", "Matricesxx and premultiplication")])).toEqual({ conceptId: null, matched: 0, total: 1, seen: false });
    expect(syllabusCoverage("Rank", [concept("c1", "Ranking", "")]).seen).toBe(false);
  });

  it("title without useful tokens → not seen, total 0, no concept", () => {
    expect(syllabusCoverage("Law of Ohm", [concept("c1", "Law of Ohm", "The law of Ohm")])).toEqual({ conceptId: null, matched: 0, total: 0, seen: false });
  });

  it("no concepts → not seen and no concept", () => {
    expect(syllabusCoverage("Determinants", [])).toEqual({ conceptId: null, matched: 0, total: 1, seen: false });
  });

  it("the concept with the most tokens wins; on a tie, the lowest conceptId", () => {
    const best = syllabusCoverage("Determinants cofactors rule", [
      concept("c_a", "Determinants"),
      concept("c_b", "Determinants", "Expansion by cofactors"),
    ]);
    expect(best).toMatchObject({ conceptId: "c_b", matched: 2 });
    const tie = syllabusCoverage("Determinants", [concept("c_z", "Determinants"), concept("c_m", "Determinants")]);
    expect(tie).toMatchObject({ conceptId: "c_m", matched: 1, seen: true });
  });

  it("tokens from several concepts are not summed: the best concept counts, not the union", () => {
    // c1 has 'rank', c2 has 'kernel' and 'image'; neither reaches 3 of 4 on its own
    const r = syllabusCoverage("Rank kernel image dimension", [concept("c1", "Rank"), concept("c2", "Kernel", "Image")]);
    expect(r).toEqual({ conceptId: null, matched: 2, total: 4, seen: false });
  });
});
