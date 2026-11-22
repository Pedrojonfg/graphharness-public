// Local card grading (D15, ADR 102 §13, ADR 108): strict, no LLM, using the core graders.
// Cards with `answer: null` (confirmation item of a template with an open answer) are not graded
// here: `given` is sent and the Hub grades it with eval.
import type { AnswerValue, Card, CardReviewBody } from "@graphharness/contracts";
import { gradeParsons, gradePredict, gradeSpotBug, gradeText } from "@graphharness/core";

/** What the learner answers: option, text, instance, Parsons order or spot_bug line. */
export type Answered =
  | { optionId: string }
  | { text: string }
  | { value: AnswerValue }
  | { order: string[] }
  | { lineId: string };

/** true/false if graded locally; null if the Hub grades it. */
export function gradeLocally(card: Card, r: Answered): boolean | null {
  const a = card.answer;
  if (a === null) return null;
  if ("optionId" in a) return "optionId" in r && r.optionId === a.optionId;
  if ("order" in a) return "order" in r && gradeParsons(a.order, r.order);
  if ("lineId" in a) return "lineId" in r && gradeSpotBug(a.lineId, r.lineId);
  if ("text" in a) {
    if (card.kind === "predict") {
      const t = "text" in r ? r.text : null;
      if (t === null || !t.trim()) return false;
      return gradePredict(a.text, a.accepted, t);
    }
    const given = "text" in r ? r.text : "value" in r && typeof r.value === "string" ? r.value : null;
    if (given === null || !given.trim()) return false;
    return [a.text, ...a.accepted].some((ok) => gradeText(ok, given));
  }
  return false;
}

function givenOf(r: Answered): AnswerValue {
  if ("optionId" in r) return r.optionId;
  if ("order" in r) return r.order;
  if ("lineId" in r) return r.lineId;
  if ("text" in r) return r.text.slice(0, 200);
  return r.value;
}

/** Body of POST /cards/:id/review: with `correct` if graded locally, only `given` if the Hub grades it. */
export function reviewBody(card: Card, r: Answered, responseMs: number): CardReviewBody {
  const correct = gradeLocally(card, r);
  const base = { responseMs: Math.max(0, Math.min(3_600_000, Math.round(responseMs))), given: givenOf(r) };
  return correct === null ? base : { ...base, correct };
}

/** The card allows "actually I was right" (cloze/text graded locally, D15). */
export function allowsOverride(card: Card): boolean {
  return (card.kind === "cloze" || card.kind === "text" || card.kind === "predict") && card.answer !== null;
}

/** Which input the card asks for. */
export function inputKindOf(card: Card): "mcq" | "instance" | "text" | "parsons" | "spot_bug" {
  if (card.kind === "mcq") return "mcq";
  if (card.kind === "parsons") return "parsons";
  if (card.kind === "spot_bug") return "spot_bug";
  if (card.front.instance && card.answer === null) return "instance";
  return "text";
}

/** Parsons/spot lines on the front. */
export function codeLines(card: Card) {
  return card.front.parsons?.lines ?? [];
}
