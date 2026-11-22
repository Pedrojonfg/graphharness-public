// Ported from graphlearn/packages/contracts/src/manual-state.ts (65b56d6). The HTTP schema lives in contracts; only the domain logic is here.

export type ManualTargetState = "solid" | "review" | "weak";
/** Origin of a declaration (the `origin` field is part of the declaration). */
export type DeclarationOrigin = "agent" | "pwa";

/** ADR 041 — provisional P until confirmed. */
export function manualTargetProbability(target: ManualTargetState): number {
  if (target === "solid") return 0.85;
  if (target === "review") return 0.55;
  return 0.25;
}
