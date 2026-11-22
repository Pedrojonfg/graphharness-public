// Free-form notes on a concept (`notes`; MCP `add_concept_note`).
import { isoNow, ulid } from "@graphharness/core";
import type { Note } from "@graphharness/contracts";
import { getConceptRow } from "./concepts.ts";
import type { HubContext } from "./context.ts";

export function addConceptNote(ctx: HubContext, input: { conceptId: string; text: string; origin: Note["origin"] }): Note {
  getConceptRow(ctx.db, input.conceptId);
  const note: Note = { id: ulid(ctx.now().getTime()), conceptId: input.conceptId, text: input.text, origin: input.origin, createdAt: isoNow(ctx.now()) };
  ctx.db
    .prepare("INSERT INTO notes (id, concept_id, text, origin, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(note.id, note.conceptId, note.text, note.origin, note.createdAt);
  return note;
}
