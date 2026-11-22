// Tests for prior.ts (ADR 105 §6, points 19 and 20): prior-knowledge bucket and summary in integer percentages.
import { describe, expect, it } from "vitest";
import { priorBucket, summarizePrior, type PriorBucket } from "./prior.ts";

describe("priorBucket", () => {
  // state = EFFECTIVE state (with decay); rawState = deriveState of the stored P, without decay.
  it("relation 'new' → new even if the matched concept is solid", () => {
    expect(priorBucket("new", { state: "solid", rawState: "solid" })).toBe("new");
  });

  it("no match (null) → new, whatever the relation", () => {
    expect(priorBucket("same", null)).toBe("new");
    expect(priorBucket("related", null)).toBe("new");
  });

  it("effective state unknown → new (there is a proposition but no evidence)", () => {
    expect(priorBucket("same", { state: "unknown", rawState: "unknown" })).toBe("new");
  });

  it("effective solid → known (rawState solid)", () => {
    expect(priorBucket("same", { state: "solid", rawState: "solid" })).toBe("known");
  });

  it("you mastered it and it has expired: rawState solid with effective review or weak → stale", () => {
    expect(priorBucket("same", { state: "review", rawState: "solid" })).toBe("stale");
    expect(priorBucket("same", { state: "weak", rawState: "solid" })).toBe("stale");
  });

  it("never was solid: review or weak (also review without decay that decays to weak) → weak", () => {
    expect(priorBucket("same", { state: "review", rawState: "review" })).toBe("weak");
    expect(priorBucket("same", { state: "weak", rawState: "weak" })).toBe("weak");
    expect(priorBucket("same", { state: "weak", rawState: "review" })).toBe("weak");
  });

  it("'same' and 'related' are treated the same in all combinations", () => {
    const states = ["solid", "review", "weak", "unknown"] as const;
    for (const state of states)
      for (const rawState of states) {
        const m = { state, rawState };
        expect(priorBucket("related", m), `${state}/${rawState}`).toBe(priorBucket("same", m));
      }
  });
});

const many = (spec: Partial<Record<PriorBucket, number>>): PriorBucket[] =>
  (["known", "stale", "weak", "new"] as const).flatMap((b) => Array.from({ length: spec[b] ?? 0 }, () => b));

describe("summarizePrior", () => {
  it("counts per bucket and gives exact percentages when they are integers", () => {
    const s = summarizePrior(many({ known: 7, stale: 2, new: 1 }));
    expect(s.total).toBe(10);
    expect(s.counts).toEqual({ known: 7, stale: 2, weak: 0, new: 1 });
    expect(s.percentages).toEqual({ known: 70, stale: 20, weak: 0, new: 10 });
  });

  it("largest remainder: 2/7, 1/7, 1/7, 3/7 → 29, 14, 14, 43 (sums to 100)", () => {
    const s = summarizePrior(many({ known: 2, stale: 1, weak: 1, new: 3 }));
    expect(s.percentages).toEqual({ known: 29, stale: 14, weak: 14, new: 43 });
  });

  it("remainder tie: distributed in the order known, stale, weak, new", () => {
    expect(summarizePrior(many({ known: 1, stale: 1, weak: 1 })).percentages).toEqual({ known: 34, stale: 33, weak: 33, new: 0 });
    expect(summarizePrior(many({ stale: 1, weak: 1, new: 1 })).percentages).toEqual({ known: 0, stale: 34, weak: 33, new: 33 });
    // 1/6 ×3 and 3/6: 2 points left over with three equal remainders → known and stale
    expect(summarizePrior(many({ known: 1, stale: 1, weak: 1, new: 3 })).percentages).toEqual({ known: 17, stale: 17, weak: 16, new: 50 });
  });

  it("input order does not change the result", () => {
    const a = summarizePrior(["new", "known", "new", "stale", "weak", "new", "known"]);
    const b = summarizePrior(many({ known: 2, stale: 1, weak: 1, new: 3 }));
    expect(a).toEqual(b);
  });

  it("percentages are integers and sum exactly to 100 across many mixes", () => {
    for (let k = 0; k < 5; k++)
      for (let s = 0; s < 5; s++)
        for (let w = 0; w < 5; w++)
          for (let n = 0; n < 5; n++) {
            if (k + s + w + n === 0) continue;
            const p = summarizePrior(many({ known: k, stale: s, weak: w, new: n })).percentages;
            const vals = Object.values(p);
            expect(vals.every(Number.isInteger), `${k}/${s}/${w}/${n}`).toBe(true);
            expect(vals.reduce((x, y) => x + y, 0), `${k}/${s}/${w}/${n}`).toBe(100);
          }
  });

  it("an empty bucket stays at 0 even though the others receive rounding points", () => {
    expect(summarizePrior(many({ known: 1, new: 2 })).percentages.weak).toBe(0);
    expect(summarizePrior(many({ known: 1, new: 2 })).percentages.stale).toBe(0);
  });

  it("total 0 → everything 0, no NaN", () => {
    expect(summarizePrior([])).toEqual({
      total: 0,
      counts: { known: 0, stale: 0, weak: 0, new: 0 },
      percentages: { known: 0, stale: 0, weak: 0, new: 0 },
    });
  });

  it("a single element → 100 % in its bucket", () => {
    expect(summarizePrior(["stale"]).percentages).toEqual({ known: 0, stale: 100, weak: 0, new: 0 });
  });
});
