// Contract tests for evidence.ts (ADR 101). Expected values computed by hand from the decay constants.
import { describe, expect, it } from "vitest";
import type { ResponseFormat } from "./decay.ts";
import type { ManualTargetState } from "./manual.ts";
import {
  applyEvidence,
  effectiveState,
  flashcardGeneratesEvidence,
  rebuildState,
  type ConceptStateRecord,
  type EvidenceEvent,
  type EvidenceEventSource,
} from "./evidence.ts";

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
/** ISO of the instant T0 + n days. */
const day = (n: number): string => new Date(T0 + n * 86_400_000).toISOString();
const dateAt = (n: number): Date => new Date(T0 + n * 86_400_000);

function grade(at: string, correct: boolean, responseFormat: ResponseFormat = "open", weight = 1, source: EvidenceEventSource = "hub_exercise"): EvidenceEvent {
  return { at, source, correct, responseFormat, weight };
}

function declaration(at: string, targetState: ManualTargetState): EvidenceEvent {
  return { at, source: "declaration", correct: null, responseFormat: null, weight: 1, targetState };
}

function confirmation(at: string, correct: boolean, responseFormat: ResponseFormat = "open"): EvidenceEvent {
  return { at, source: "confirmation", correct, responseFormat, weight: 1 };
}

describe("applyEvidence — grades without previous state", () => {
  it("a success starts from the prior: 0.50 + 0.15 = 0.65", () => {
    const r = applyEvidence(null, grade(day(0), true, "open"));
    expect(r.probability).toBeCloseTo(0.65, 10);
    expect(r.decayClass).toBe("reasoned");
    expect(r.source).toBe("grade");
    expect(r.manualConfirmation).toBeNull();
    expect(r.updatedAt).toBe(day(0));
  });

  it("a failure starts from the prior: 0.50 − 0.20 = 0.30", () => {
    const r = applyEvidence(null, grade(day(0), false, "mcq"));
    expect(r.probability).toBeCloseTo(0.3, 10);
    expect(r.decayClass).toBe("strain");
    expect(r.source).toBe("grade");
    expect(r.manualConfirmation).toBeNull();
  });

  it("weight 0.5 (flashcard, D26) applies half the delta", () => {
    const ok = applyEvidence(null, grade(day(0), true, "mcq", 0.5, "flashcard"));
    expect(ok.probability).toBeCloseTo(0.575, 10);
    const ko = applyEvidence(null, grade(day(0), false, "open", 0.5, "flashcard"));
    expect(ko.probability).toBeCloseTo(0.4, 10);
  });

  it("weight 0.15 (diagnostic inference) scales the delta", () => {
    const r = applyEvidence(null, grade(day(0), true, "mcq", 0.15, "hub_diagnostic"));
    expect(r.probability).toBeCloseTo(0.5 + 0.15 * 0.15, 10);
  });
});

describe("applyEvidence — ADR 101: decay before the delta", () => {
  it("prev 0.9 'reasoned' from 60 days ago → base 0.45 → +0.15 = 0.60 (not 1.0)", () => {
    const prev: ConceptStateRecord = { probability: 0.9, decayClass: "reasoned", source: "grade", manualConfirmation: null, updatedAt: day(0) };
    const r = applyEvidence(prev, grade(day(60), true, "open"));
    expect(r.probability).toBeCloseTo(0.6, 10);
    expect(r.decayClass).toBe("reasoned");
    expect(r.updatedAt).toBe(day(60));
  });

  it("decays with the class of the PREVIOUS STATE, not the new event's", () => {
    // prev 'strain' (21 d): 0.8 · 0.5^(42/21) = 0.2 → failure → 0.2 − 0.2 = 0.
    const prev: ConceptStateRecord = { probability: 0.8, decayClass: "strain", source: "grade", manualConfirmation: null, updatedAt: day(0) };
    const ko = applyEvidence(prev, grade(day(42), false, "open"));
    expect(ko.probability).toBeCloseTo(0, 10);
    // prev 'quick' (30 d): 0.8 · 0.5 = 0.4 → open success (new class 'reasoned') → 0.55.
    const prevQuick: ConceptStateRecord = { ...prev, decayClass: "quick" };
    const ok = applyEvidence(prevQuick, grade(day(30), true, "open"));
    expect(ok.probability).toBeCloseTo(0.55, 10);
    expect(ok.decayClass).toBe("reasoned");
  });

  it("respects opts.halfLifeDays", () => {
    const halfLifeDays = { reasoned: 10, quick: 30, strain: 21, manual_pending: 5, manual_confirmed: 45 };
    const prev: ConceptStateRecord = { probability: 0.8, decayClass: "reasoned", source: "grade", manualConfirmation: null, updatedAt: day(0) };
    const r = applyEvidence(prev, grade(day(10), true, "mcq"), { halfLifeDays });
    expect(r.probability).toBeCloseTo(0.55, 10);
  });

  it("event with `at` earlier than prev.updatedAt counts age 0 (P does not grow)", () => {
    const prev: ConceptStateRecord = { probability: 0.6, decayClass: "reasoned", source: "grade", manualConfirmation: null, updatedAt: day(10) };
    const r = applyEvidence(prev, grade(day(0), true, "open"));
    expect(r.probability).toBeCloseTo(0.75, 10);
    expect(r.updatedAt).toBe(day(0));
  });

  it("same instant → no decay", () => {
    const prev: ConceptStateRecord = { probability: 0.6, decayClass: "strain", source: "grade", manualConfirmation: null, updatedAt: day(3) };
    expect(applyEvidence(prev, grade(day(3), false, "mcq")).probability).toBeCloseTo(0.4, 10);
  });
});

describe("applyEvidence — grade decay class", () => {
  const cases: [boolean, ResponseFormat, string][] = [
    [true, "open", "reasoned"],
    [true, "mcq", "quick"],
    [false, "open", "strain"],
    [false, "mcq", "strain"],
  ];
  for (const [correct, fmt, expected] of cases) {
    it(`correct=${correct}, ${fmt} → ${expected}`, () => {
      const prev: ConceptStateRecord = { probability: 0.5, decayClass: "manual_confirmed", source: "manual", manualConfirmation: "confirmed", updatedAt: day(0) };
      const r = applyEvidence(prev, grade(day(1), correct, fmt));
      expect(r.decayClass).toBe(expected);
      expect(r.source).toBe("grade");
      // 'confirmed' is kept even if it fails (only 'pending' changes).
      expect(r.manualConfirmation).toBe("confirmed");
    });
  }
});

describe("applyEvidence — clamp a [0, 1]", () => {
  it("does not exceed 1", () => {
    const prev: ConceptStateRecord = { probability: 0.95, decayClass: "reasoned", source: "grade", manualConfirmation: null, updatedAt: day(0) };
    expect(applyEvidence(prev, grade(day(0), true)).probability).toBe(1);
  });

  it("does not go below 0", () => {
    const prev: ConceptStateRecord = { probability: 0.1, decayClass: "strain", source: "grade", manualConfirmation: null, updatedAt: day(0) };
    expect(applyEvidence(prev, grade(day(0), false)).probability).toBe(0);
  });
});

describe("applyEvidence — declarations", () => {
  const prevHigh: ConceptStateRecord = { probability: 0.95, decayClass: "reasoned", source: "grade", manualConfirmation: "confirmed", updatedAt: day(0) };
  const targets: [ManualTargetState, number][] = [
    ["solid", 0.85],
    ["review", 0.55],
    ["weak", 0.25],
  ];
  for (const [target, p] of targets) {
    it(`target ${target} → P=${p}, ignoring the previous P`, () => {
      const r = applyEvidence(prevHigh, declaration(day(2), target));
      expect(r.probability).toBeCloseTo(p, 10);
      expect(r.decayClass).toBe("manual_pending");
      expect(r.source).toBe("manual");
      expect(r.manualConfirmation).toBe("pending");
      expect(r.updatedAt).toBe(day(2));
    });
  }

  it("without previous state also sets the provisional P", () => {
    const r = applyEvidence(null, declaration(day(0), "weak"));
    expect(r.probability).toBeCloseTo(0.25, 10);
    expect(r.manualConfirmation).toBe("pending");
    expect(r.source).toBe("manual");
  });
});

describe("applyEvidence — confirmations", () => {
  const declared: ConceptStateRecord = { probability: 0.85, decayClass: "manual_pending", source: "manual", manualConfirmation: "pending", updatedAt: day(0) };

  it("correct: prev decays (0.85 → 0.425 at 5 d) + 0.15 → manual_confirmed / confirmed", () => {
    const r = applyEvidence(declared, confirmation(day(5), true));
    expect(r.probability).toBeCloseTo(0.575, 10);
    expect(r.decayClass).toBe("manual_confirmed");
    expect(r.manualConfirmation).toBe("confirmed");
    expect(r.source).toBe("manual");
    expect(r.updatedAt).toBe(day(5));
  });

  it("incorrect: 0.425 − 0.20 = 0.225, strain, stays pending", () => {
    const r = applyEvidence(declared, confirmation(day(5), false));
    expect(r.probability).toBeCloseTo(0.225, 10);
    expect(r.decayClass).toBe("strain");
    expect(r.manualConfirmation).toBe("pending");
    expect(r.source).toBe("manual");
  });

  it("the class comes from correct, not from the format (correct mcq → manual_confirmed, not quick)", () => {
    const r = applyEvidence(declared, confirmation(day(0), true, "mcq"));
    expect(r.decayClass).toBe("manual_confirmed");
    expect(r.probability).toBeCloseTo(1, 10);
  });

  it("source does not change: keeps prev.source even if it is 'grade'", () => {
    const prevGrade: ConceptStateRecord = { ...declared, source: "grade" };
    expect(applyEvidence(prevGrade, confirmation(day(1), true)).source).toBe("grade");
  });

  it("no previous state → source 'grade'", () => {
    const r = applyEvidence(null, confirmation(day(0), true));
    expect(r.source).toBe("grade");
    expect(r.manualConfirmation).toBe("confirmed");
    expect(r.decayClass).toBe("manual_confirmed");
  });
});

describe("applyEvidence — grade after pending declaration", () => {
  const pending: ConceptStateRecord = { probability: 0.55, decayClass: "manual_pending", source: "manual", manualConfirmation: "pending", updatedAt: day(0) };

  it("correct grade → confirmed; 0.55·0.5 + 0.15 = 0.425; source grade; the grade's class", () => {
    const r = applyEvidence(pending, grade(day(5), true, "mcq"));
    expect(r.manualConfirmation).toBe("confirmed");
    expect(r.probability).toBeCloseTo(0.425, 10);
    expect(r.source).toBe("grade");
    expect(r.decayClass).toBe("quick");
  });

  it("incorrect grade → stays pending; 0.275 − 0.20 = 0.075; strain", () => {
    const r = applyEvidence(pending, grade(day(5), false, "open"));
    expect(r.manualConfirmation).toBe("pending");
    expect(r.probability).toBeCloseTo(0.075, 10);
    expect(r.decayClass).toBe("strain");
    expect(r.source).toBe("grade");
  });

  it("without a previous confirmation stays null even if correct", () => {
    const prev: ConceptStateRecord = { probability: 0.5, decayClass: "quick", source: "grade", manualConfirmation: null, updatedAt: day(0) };
    expect(applyEvidence(prev, grade(day(1), true)).manualConfirmation).toBeNull();
  });
});

describe("rebuildState", () => {
  it("no events → null", () => {
    expect(rebuildState([])).toBeNull();
  });

  it("sorts by `at` even if the input comes out of order", () => {
    // Real order: mcq failure on day 0 (0.30, strain) → open success on day 60.
    const r = rebuildState([grade(day(60), true, "open"), grade(day(0), false, "mcq")]);
    expect(r).not.toBeNull();
    expect(r!.probability).toBeCloseTo(0.3 * 0.5 ** (60 / 21) + 0.15, 10);
    expect(r!.decayClass).toBe("reasoned");
    expect(r!.updatedAt).toBe(day(60));
  });

  it("sorts by instant (not by position) with several events", () => {
    const r = rebuildState([grade(day(2), true, "open"), declaration(day(1), "weak"), grade(day(0), false, "open")]);
    // 0.30 (d0) → weak declaration 0.25 pending (d1) → success: 0.25·0.5^(1/5) + 0.15, confirmed.
    expect(r!.probability).toBeCloseTo(0.25 * 0.5 ** (1 / 5) + 0.15, 10);
    expect(r!.manualConfirmation).toBe("confirmed");
    expect(r!.updatedAt).toBe(day(2));
  });

  it("tie on `at`: respects input order", () => {
    const a = rebuildState([declaration(day(0), "solid"), grade(day(0), false, "open")]);
    expect(a!.probability).toBeCloseTo(0.65, 10);
    expect(a!.decayClass).toBe("strain");
    expect(a!.manualConfirmation).toBe("pending");
    expect(a!.source).toBe("grade");

    const b = rebuildState([grade(day(0), false, "open"), declaration(day(0), "solid")]);
    expect(b!.probability).toBeCloseTo(0.85, 10);
    expect(b!.decayClass).toBe("manual_pending");
    expect(b!.source).toBe("manual");
  });

  it("property: incremental fold in `at` order === rebuildState of the shuffled sequence (300 cases)", () => {
    const rand = mulberry32(0x5eed_1234);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
    const sources: EvidenceEventSource[] = ["lh_quiz", "lh_probe", "lh_recall", "lh_practice", "hub_exercise", "hub_diagnostic", "flashcard", "declaration", "confirmation"];
    const formats: ResponseFormat[] = ["open", "mcq"];
    const targets: ManualTargetState[] = ["solid", "review", "weak"];

    for (let c = 0; c < 300; c++) {
      const n = 1 + Math.floor(rand() * 12);
      // Distinct instants (in hours), so that the order by `at` is unique.
      const offsets = new Set<number>();
      while (offsets.size < n) offsets.add(Math.floor(rand() * 24 * 200));
      const sorted = [...offsets].sort((x, y) => x - y).map((h): EvidenceEvent => {
        const at = new Date(T0 + h * 3_600_000).toISOString();
        const source = pick(sources);
        if (source === "declaration") return declaration(at, pick(targets));
        const weight = source === "flashcard" ? 0.5 : pick([1, 1, 0.15]);
        return { at, source, correct: rand() < 0.6, responseFormat: pick(formats), weight };
      });

      let folded: ConceptStateRecord | null = null;
      for (const ev of sorted) {
        folded = applyEvidence(folded, ev);
        expect(folded.probability).toBeGreaterThanOrEqual(0);
        expect(folded.probability).toBeLessThanOrEqual(1);
      }

      const shuffled = [...sorted];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
      }
      expect(rebuildState(shuffled)).toEqual(folded);
    }
  });
});

/** Deterministic PRNG (mulberry32). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe("effectiveState", () => {
  it("no record → unknown, P null, stale false", () => {
    expect(effectiveState(null, dateAt(0))).toEqual({ state: "unknown", probability: null, stale: false });
  });

  // 0.9 'reasoned' (60 d) crosses 0.75 at d = 60·log2(1.2) ≈ 15.78 days.
  const rec: ConceptStateRecord = { probability: 0.9, decayClass: "reasoned", source: "grade", manualConfirmation: null, updatedAt: day(0) };

  it("at the same instant P' = P", () => {
    const e = effectiveState(rec, dateAt(0));
    expect(e.probability).toBeCloseTo(0.9, 10);
    expect(e.state).toBe("solid");
    expect(e.stale).toBe(false);
  });

  it("day 15 is still solid; day 16 becomes review", () => {
    const d15 = effectiveState(rec, dateAt(15));
    expect(d15.probability).toBeCloseTo(0.9 * 0.5 ** (15 / 60), 10);
    expect(d15.state).toBe("solid");
    const d16 = effectiveState(rec, dateAt(16));
    expect(d16.probability).toBeCloseTo(0.9 * 0.5 ** (16 / 60), 10);
    expect(d16.state).toBe("review");
  });

  it("stale when P' < 0.55 (d > 60·log2(0.9/0.55) ≈ 42.63), even with age < half-life", () => {
    expect(effectiveState(rec, dateAt(42)).stale).toBe(false);
    expect(effectiveState(rec, dateAt(43)).stale).toBe(true);
  });

  it("stale and P' use the half-life from opts", () => {
    const halfLifeDays = { reasoned: 60, quick: 2, strain: 21, manual_pending: 5, manual_confirmed: 45 };
    const quick: ConceptStateRecord = { ...rec, probability: 1, decayClass: "quick" };
    const e = effectiveState(quick, dateAt(3), { halfLifeDays });
    expect(e.probability).toBeCloseTo(0.5 ** 1.5, 10);
    expect(e.state).toBe("weak");
    expect(e.stale).toBe(true);
  });

  it("uses the record's class: manual_pending 0.85 at 5 d → 0.425 review and stale", () => {
    const pending: ConceptStateRecord = { probability: 0.85, decayClass: "manual_pending", source: "manual", manualConfirmation: "pending", updatedAt: day(0) };
    const e = effectiveState(pending, dateAt(5));
    expect(e.probability).toBeCloseTo(0.425, 10);
    expect(e.state).toBe("review");
    expect(e.stale).toBe(true);
  });

  it("low P with evidence is weak, not unknown", () => {
    const low: ConceptStateRecord = { ...rec, probability: 0.1, decayClass: "strain" };
    expect(effectiveState(low, dateAt(0)).state).toBe("weak");
  });

  it("respects opts.halfLifeDays: 0.8 quick with half-life 10 at 20 d → 0.2 weak", () => {
    const halfLifeDays = { reasoned: 60, quick: 10, strain: 21, manual_pending: 5, manual_confirmed: 45 };
    const e = effectiveState({ ...rec, probability: 0.8, decayClass: "quick" }, dateAt(20), { halfLifeDays });
    expect(e.probability).toBeCloseTo(0.2, 10);
    expect(e.state).toBe("weak");
  });
});

describe("flashcardGeneratesEvidence", () => {
  it("correct early review → generates no evidence", () => {
    expect(flashcardGeneratesEvidence({ early: true, correct: true })).toBe(false);
  });
  it("the rest do", () => {
    expect(flashcardGeneratesEvidence({ early: true, correct: false })).toBe(true);
    expect(flashcardGeneratesEvidence({ early: false, correct: true })).toBe(true);
    expect(flashcardGeneratesEvidence({ early: false, correct: false })).toBe(true);
  });
});
