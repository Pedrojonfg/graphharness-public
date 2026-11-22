// lh-sync with the REAL graph and chats from packages/lh-client/fixtures.
import { describe, expect, it } from "vitest";
import { makeTestContext, seedConcept } from "@graphharness/hub/testing";
import { recordEvidence } from "@graphharness/hub/services/evidence";
import { handlers, runLhSync } from "../../src/handlers/ingest.ts";
import { PRACTICE_ID, TEACH_ID, GRAPH_CHAINS, GRAPH_PROPOSITIONS, FIRST_LAW_PROP, PRACTICE_TARGET, SAMPLE_CHAIN, count, jobs, loadChats, loadGraph, lhWith } from "./helpers.ts";

const fresh = () => {
  const ctx = makeTestContext({ lh: lhWith() });
  return ctx;
};

describe("lh-sync: propositions and chains", () => {
  it("inserts exactly the propositions and chains of the real snapshot", async () => {
    const ctx = fresh();
    const r = await runLhSync(ctx);
    expect(r.newPropositions).toBe(GRAPH_PROPOSITIONS);
    expect(count(ctx.db, "SELECT count(*) FROM lh_propositions")).toBe(GRAPH_PROPOSITIONS);
    expect(count(ctx.db, "SELECT count(*) FROM lh_chains")).toBe(GRAPH_CHAINS);
    expect(count(ctx.db, "SELECT count(*) FROM lh_propositions WHERE deleted = 1")).toBe(0);
    const p = ctx.db.prepare("SELECT * FROM lh_propositions WHERE id = ?").get(FIRST_LAW_PROP) as Record<string, string>;
    const g = loadGraph().propositions.find((x) => x.id === FIRST_LAW_PROP)!;
    expect(p.name).toBe(g.name);
    expect(p.statement).toBe(g.statement);
    expect(JSON.parse(p.provenance_json)).toEqual(g.provenance);
    expect(JSON.parse(p.aliases_json)).toEqual(g.aliases);
    const ch = ctx.db.prepare("SELECT * FROM lh_chains WHERE id = ?").get(SAMPLE_CHAIN.id) as Record<string, string>;
    expect(JSON.parse(ch.premises_json)).toEqual([...SAMPLE_CHAIN.premises]);
    expect(ch.conclusion).toBe(SAMPLE_CHAIN.conclusion);
  });

  it("is idempotent: the second run neither duplicates nor reports new ones", async () => {
    const ctx = fresh();
    await runLhSync(ctx);
    const r2 = await runLhSync(ctx);
    expect(r2.newPropositions).toBe(0);
    expect(count(ctx.db, "SELECT count(*) FROM lh_propositions")).toBe(GRAPH_PROPOSITIONS);
    expect(count(ctx.db, "SELECT count(*) FROM lh_chains")).toBe(GRAPH_CHAINS);
    expect(count(ctx.db, "SELECT count(*) FROM lh_sessions")).toBe(2);
  });

  it("a proposition and a chain that disappear are marked deleted=1 and the evidence remains", async () => {
    const ctx = fresh();
    await runLhSync(ctx);
    const concept = seedConcept(ctx.db);
    ctx.db.prepare("INSERT INTO concept_propositions (proposition_id, concept_id, assigned_by, assigned_at) VALUES (?, ?, 'curator', ?)").run(PRACTICE_TARGET.solved, concept, "2026-11-10T09:00:00.000Z");
    recordEvidence(ctx.db, { conceptId: concept, at: "2026-11-10T08:00:00.000Z", source: "lh_probe", correct: true, responseFormat: "mcq", ref: { chatId: "c", toolCallId: "t" } }, ctx.now());
    const g = loadGraph();
    const smaller = {
      propositions: g.propositions.filter((p) => p.id !== PRACTICE_TARGET.solved),
      chains: g.chains.filter((c) => c.id !== SAMPLE_CHAIN.id),
    };
    ctx.lh = lhWith({ graph: smaller });
    await runLhSync(ctx);
    expect(count(ctx.db, "SELECT count(*) FROM lh_propositions")).toBe(GRAPH_PROPOSITIONS);
    expect(count(ctx.db, "SELECT count(*) FROM lh_propositions WHERE deleted = 1")).toBe(1);
    expect(count(ctx.db, "SELECT deleted FROM lh_propositions WHERE id = ?", PRACTICE_TARGET.solved)).toBe(1);
    expect(count(ctx.db, "SELECT count(*) FROM lh_chains WHERE deleted = 1")).toBe(1);
    expect(count(ctx.db, "SELECT deleted FROM lh_chains WHERE id = ?", SAMPLE_CHAIN.id)).toBe(1);
    expect(count(ctx.db, "SELECT count(*) FROM evidence_events WHERE concept_id = ?", concept)).toBe(1);
    expect(count(ctx.db, "SELECT count(*) FROM concept_state WHERE concept_id = ?", concept)).toBe(1);
  });
});

describe("lh-sync: sessions", () => {
  it("upserts lh_sessions with kind teaching/practice and is idempotent", async () => {
    const ctx = fresh();
    await runLhSync(ctx);
    await runLhSync(ctx);
    const rows = ctx.db.prepare("SELECT chat_id, title, kind, hub_state FROM lh_sessions ORDER BY chat_id").all() as Record<string, string>[];
    expect(rows).toHaveLength(2);
    const chats = loadChats();
    const teach = rows.find((r) => r.chat_id === TEACH_ID)!;
    const practice = rows.find((r) => r.chat_id === PRACTICE_ID)!;
    expect(teach.kind).toBe("teaching");
    expect(teach.title).toBe(chats.find((c) => c.id === TEACH_ID)!.title);
    expect(practice.kind).toBe("practice");
    expect(practice.title).toBe("Practice: ideal gas processes");
    expect(teach.hub_state).toBe("open");
  });
});

describe("lh-sync: queueing", () => {
  it("enqueues concept-curate (there are propositions without a concept) and one session-ingest per chat", async () => {
    const ctx = fresh();
    const r = await runLhSync(ctx);
    expect(jobs(ctx.db, "concept-curate", "queued")).toHaveLength(1);
    const ing = jobs(ctx.db, "session-ingest", "queued");
    expect(ing.map((j) => j.payload.chatId).sort()).toEqual([PRACTICE_ID, TEACH_ID].sort());
    expect(r.chatsToIngest.sort()).toEqual([PRACTICE_ID, TEACH_ID].sort());
  });

  it("without propositions lacking a concept it does not enqueue concept-curate; without changes in the chats it does not re-enqueue session-ingest", async () => {
    const ctx = fresh();
    await runLhSync(ctx);
    const concept = seedConcept(ctx.db);
    ctx.db.prepare("INSERT INTO concept_propositions SELECT id, ?, 'curator', ? FROM lh_propositions").run(concept, "2026-11-10T09:00:00.000Z");
    ctx.db.prepare("UPDATE jobs SET status = 'done'").run();
    const r = await runLhSync(ctx);
    expect(r.newPropositions).toBe(0);
    expect(r.chatsToIngest).toEqual([]);
    expect(jobs(ctx.db, undefined, "queued")).toEqual([]);
  });

  it("a chat with new activity (more messages) is re-enqueued, and only that one", async () => {
    const ctx = fresh();
    await runLhSync(ctx);
    ctx.db.prepare("UPDATE jobs SET status = 'done'").run();
    const chats = loadChats().map((c) =>
      c.id === PRACTICE_ID ? { ...c, messageCount: c.messageCount + 2, updatedAt: "2026-10-11T10:00:00.000Z" } : c,
    );
    ctx.lh = lhWith({ chats });
    const r = await runLhSync(ctx);
    expect(r.chatsToIngest).toEqual([PRACTICE_ID]);
    expect(jobs(ctx.db, "session-ingest", "queued").map((j) => j.payload.chatId)).toEqual([PRACTICE_ID]);
  });

  it("the 'lh-sync' handler runs the synchronization", async () => {
    const ctx = fresh();
    await handlers["lh-sync"]!(ctx, { id: "j", type: "lh-sync", payload: {}, status: "running", attempts: 1, runAfter: "", lastError: null });
    expect(count(ctx.db, "SELECT count(*) FROM lh_propositions")).toBe(GRAPH_PROPOSITIONS);
  });
});
