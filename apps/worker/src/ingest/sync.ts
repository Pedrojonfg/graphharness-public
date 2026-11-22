// lh-sync: mirror of LH propositions, chains and sessions (only through lh-client; never LH_DATA_DIR).
import { isoNow } from "@graphharness/core";
import { enqueueJob } from "@graphharness/hub/services/jobs";
import { refreshConceptFts } from "@graphharness/hub/services/fts";
import type { HubContext } from "@graphharness/hub/services/context";
import { META_LAST_LH_SYNC, META_LH_FILE_SOURCES, parseCursor, setMeta } from "./common.ts";

interface PropRow {
  id: string;
  statement: string;
  deleted: number;
}

interface SessionRow {
  chat_id: string;
  hub_state: string;
  last_turn_started_at: string | null;
  last_turn_settled_at: string | null;
  ingest_cursor_json: string;
}

export async function runLhSync(ctx: HubContext): Promise<{ newPropositions: number; chatsToIngest: string[] }> {
  const { db } = ctx;
  const graph = await ctx.lh.getGraph();
  const chats = await ctx.lh.listChats();
  const now = isoNow(ctx.now());

  const { newPropositions, newUnassigned, changedConcepts } = db.transaction(() => {
    // Propositions: upsert the live ones; those that are no longer present → deleted = 1.
    const before = new Map((db.prepare("SELECT id, statement, deleted FROM lh_propositions").all() as PropRow[]).map((r) => [r.id, r]));
    const upsertProp = db.prepare(
      `INSERT INTO lh_propositions (id, name, statement, aliases_json, provenance_json, deleted, first_seen_at, last_synced_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, statement = excluded.statement, aliases_json = excluded.aliases_json,
         provenance_json = excluded.provenance_json, deleted = 0, last_synced_at = excluded.last_synced_at`,
    );
    const changed: string[] = [];
    const appeared: string[] = [];
    const live = new Set<string>();
    for (const p of graph.propositions) {
      live.add(p.id);
      const prev = before.get(p.id);
      upsertProp.run(p.id, p.name, p.statement, JSON.stringify(p.aliases), JSON.stringify(p.provenance.map((x) => ({ chatId: x.chatId, messageId: x.messageId }))), now, now);
      if (!prev || prev.deleted === 1) appeared.push(p.id);
      if (!prev || prev.deleted === 1 || prev.statement !== p.statement) changed.push(p.id);
    }
    const markDeleted = db.prepare("UPDATE lh_propositions SET deleted = 1, last_synced_at = ? WHERE id = ?");
    for (const r of before.values()) {
      if (r.deleted === 0 && !live.has(r.id)) {
        markDeleted.run(now, r.id);
        changed.push(r.id);
      }
    }

    // Chains: same.
    const upsertChain = db.prepare(
      `INSERT INTO lh_chains (id, premises_json, conclusion, deleted, last_synced_at) VALUES (?, ?, ?, 0, ?)
       ON CONFLICT(id) DO UPDATE SET premises_json = excluded.premises_json, conclusion = excluded.conclusion, deleted = 0,
         last_synced_at = excluded.last_synced_at`,
    );
    for (const c of graph.chains) upsertChain.run(c.id, JSON.stringify(c.premises), c.conclusion, now);
    const liveChains = new Set(graph.chains.map((c) => c.id));
    const markChain = db.prepare("UPDATE lh_chains SET deleted = 1, last_synced_at = ? WHERE id = ?");
    for (const id of db.prepare("SELECT id FROM lh_chains WHERE deleted = 0").pluck().all() as string[]) if (!liveChains.has(id)) markChain.run(now, id);

    // Concepts whose indexed text changed (new/deleted/rewritten proposition that is already assigned).
    const conceptOf = db.prepare("SELECT concept_id FROM concept_propositions WHERE proposition_id = ?").pluck();
    const changedConcepts = new Set<string>();
    for (const id of changed) {
      const c = conceptOf.get(id) as string | undefined;
      if (c) changedConcepts.add(c);
    }
    const newUnassigned = appeared.filter((id) => conceptOf.get(id) === undefined).length;
    if (graph.fileSources) setMeta(db, META_LH_FILE_SOURCES, JSON.stringify(graph.fileSources), ctx.now());
    return { newPropositions: appeared.length, newUnassigned, changedConcepts };
  })();
  for (const c of changedConcepts) refreshConceptFts(db, c);

  // Sessions: upsert of title and kind; subject_id/started_by/hub_state belong to the Hub and are not overwritten.
  const chatsToIngest: string[] = [];
  db.transaction(() => {
    const get = db.prepare("SELECT chat_id, hub_state, last_turn_started_at, last_turn_settled_at, ingest_cursor_json FROM lh_sessions WHERE chat_id = ?");
    const upsert = db.prepare(
      `INSERT INTO lh_sessions (chat_id, title, kind) VALUES (?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET title = excluded.title, kind = excluded.kind`,
    );
    for (const chat of chats) {
      const prev = get.get(chat.id) as SessionRow | undefined;
      upsert.run(chat.id, chat.title, chat.kind === "practice" ? "practice" : "teaching");
      const cursor = parseCursor(prev?.ingest_cursor_json);
      // Reopening: a closed session with messages newer than its last ingest goes back to `open`.
      if (prev?.hub_state === "closed" && cursor.messageCount !== undefined && chat.messageCount > cursor.messageCount)
        db.prepare("UPDATE lh_sessions SET hub_state = 'open', closed_at = NULL WHERE chat_id = ?").run(chat.id);
      // If the turn-settled was lost (SSE down) and LH no longer has a turn in progress, it is settled at updatedAt.
      if (!chat.busy && prev?.last_turn_started_at && prev.last_turn_started_at > (prev.last_turn_settled_at ?? ""))
        db.prepare("UPDATE lh_sessions SET last_turn_settled_at = ? WHERE chat_id = ?").run(
          chat.updatedAt > prev.last_turn_started_at ? chat.updatedAt : prev.last_turn_started_at,
          chat.id,
        );
      // New turn = the record changed since it was last seen (by this sync or by the ingest). A chat with a turn in
      // progress waits for its turn-settled. What was seen is noted when enqueuing: the next sync without changes does not re-enqueue.
      const changed = cursor.updatedAt !== chat.updatedAt || cursor.messageCount !== chat.messageCount;
      if (!chat.busy && chat.messageCount > 0 && changed) {
        chatsToIngest.push(chat.id);
        db.prepare("UPDATE lh_sessions SET ingest_cursor_json = json_set(ingest_cursor_json, '$.updatedAt', ?, '$.messageCount', ?) WHERE chat_id = ?").run(
          chat.updatedAt,
          chat.messageCount,
          chat.id,
        );
      }
    }
  })();

  if (newUnassigned > 0) enqueueJob(db, "concept-curate", {}, { now: ctx.now() });
  for (const chatId of chatsToIngest) enqueueJob(db, "session-ingest", { chatId }, { now: ctx.now() });
  setMeta(db, META_LAST_LH_SYNC, now, ctx.now());
  return { newPropositions, chatsToIngest };
}
