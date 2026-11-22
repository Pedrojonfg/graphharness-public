// Declarations (D3, D4): weak-prerequisite warning, `pending` declaration + `declaration` evidence
// + confirmation items; and expiry (`declarations-expire`).
import { isoNow, ulid, weakPrerequisites as findWeakPrerequisites, type ConceptEdge as CoreEdge } from "@graphharness/core";
import type { ConceptStateView, ConfirmationItem, ManualTargetState, WeakPrerequisite } from "@graphharness/contracts";
import { notFound } from "../errors.ts";
import { getConceptRow, stateView } from "./concepts.ts";
import { createConfirmationItems } from "./confirmations.ts";
import type { HubContext } from "./context.ts";
import { effectiveStates, recordEvidence } from "./evidence.ts";

/** Weak-prerequisite check over the stored graph, with names so they can be reported. */
export function weakPrerequisitesOf(ctx: HubContext, conceptId: string): WeakPrerequisite[] {
  const rows = ctx.db.prepare("SELECT from_concept, to_concept, relation, confidence, removed FROM concept_edges").all() as {
    from_concept: string;
    to_concept: string;
    relation: "requires" | "illustrates";
    confidence: "high" | "medium" | "low";
    removed: number;
  }[];
  const edges: CoreEdge[] = rows.map((r) => ({ from: r.from_concept, to: r.to_concept, relation: r.relation, confidence: r.confidence, removed: r.removed === 1 }));
  const ids = [...new Set(edges.flatMap((e) => [e.from, e.to]))];
  const states = effectiveStates(ctx.db, ctx.now(), ids);
  const found = findWeakPrerequisites(conceptId, edges, (id) => states.get(id)?.state ?? "unknown");
  const name = ctx.db.prepare("SELECT name FROM concepts WHERE id = ?").pluck();
  return found.map((w) => ({ conceptId: w.conceptId, name: (name.get(w.conceptId) as string | undefined) ?? w.conceptId, state: w.state, path: w.path }));
}

export type DeclareResult =
  | { status: "needs_ack"; weakPrerequisites: WeakPrerequisite[] }
  | {
      status: "recorded";
      declarationId: string;
      conceptState: ConceptStateView;
      weakPrerequisites: WeakPrerequisite[];
      confirmationItems: ConfirmationItem[];
    };

/**
 * Common flow of MCP `declare_learning` (origin 'agent') and PATCH /concepts/:id/state (origin 'pwa').
 * With weak prerequisites and no ack it records nothing.
 */
export async function declareLearning(
  ctx: HubContext,
  input: {
    conceptId: string;
    targetState: ManualTargetState;
    justification: string;
    rawText?: string | null;
    ackWeakPrerequisites?: boolean;
    origin: "agent" | "pwa";
  },
): Promise<DeclareResult> {
  const concept = getConceptRow(ctx.db, input.conceptId);
  if (concept.status !== "active") throw notFound();
  const weak = weakPrerequisitesOf(ctx, input.conceptId);
  if (weak.length > 0 && !input.ackWeakPrerequisites) return { status: "needs_ack", weakPrerequisites: weak };

  const now = ctx.now();
  const declarationId = ulid(now.getTime());
  ctx.db.transaction(() => {
    ctx.db
      .prepare(
        `INSERT INTO declarations (id, concept_id, target_state, justification, origin, raw_text, weak_prereqs_json, ack_weak_prereqs, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        declarationId,
        input.conceptId,
        input.targetState,
        input.justification,
        input.origin,
        input.rawText ?? null,
        JSON.stringify(weak),
        input.ackWeakPrerequisites ? 1 : 0,
        isoNow(now),
      );
    recordEvidence(
      ctx.db,
      {
        conceptId: input.conceptId,
        at: isoNow(now),
        source: "declaration",
        correct: null,
        responseFormat: null,
        targetState: input.targetState,
        justification: input.justification,
        ref: { declarationId },
      },
      now,
    );
  })();

  let confirmationItems: ConfirmationItem[] = [];
  try {
    confirmationItems = await createConfirmationItems(ctx, { declarationId, conceptId: input.conceptId });
  } catch (err) {
    // the declaration is already recorded; without items it expires on its own. The failure is logged.
    console.error(`[hub] could not create the confirmation items of ${declarationId}:`, err);
  }
  return { status: "recorded", declarationId, conceptState: stateView(ctx, input.conceptId), weakPrerequisites: weak, confirmationItems };
}

/**
 * `pending` declarations older than DECLARATION_EXPIRE_DAYS become `expired`, and their unanswered confirmation items
 * are removed from the queue. Evidence is untouched: it keeps decaying with `manual_pending`. Idempotent.
 */
export function expireDeclarations(ctx: HubContext): number {
  const now = ctx.now();
  const cutoff = isoNow(new Date(now.getTime() - ctx.config.declarationExpireDays * 86_400_000));
  return ctx.db.transaction(() => {
    const ids = ctx.db.prepare("SELECT id FROM declarations WHERE status = 'pending' AND created_at < ?").pluck().all(cutoff) as string[];
    const expire = ctx.db.prepare("UPDATE declarations SET status = 'expired', resolved_at = ? WHERE id = ?");
    const retire = ctx.db.prepare("UPDATE cards SET retired = 1 WHERE declaration_id = ? AND purpose = 'confirmation' AND retired = 0");
    for (const id of ids) {
      expire.run(isoNow(now), id);
      retire.run(id);
    }
    return ids.length;
  })();
}
