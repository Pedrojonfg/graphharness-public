// ADR 109 (decisions 6–7): "lens" votes per core node. LH writes them with POST /lens-feedback
// and the teacher reads them (aggregated by label, across all chats) with GET /lens-feedback.
// Concept resolution identical to POST /capture (conceptId XOR conceptQuery, 409 ambiguous_concept, 404).
import type { LlmRequest } from "@graphharness/llm";
import { describe, expect, it } from "vitest";
import { setNow } from "../../src/testing.ts";
import { NOW, autoLlm, call, conceptIn, count, iso, subject, world, type Ctx } from "./helpers.ts";

const T1 = NOW;
const T2 = iso(Date.parse(NOW) + 60_000);
const T3 = iso(Date.parse(NOW) + 120_000);

/** LLM whose resolve_concepts rerank returns these scores (same as in agent-tools.test.ts). */
function rerankLlm(scores: () => { conceptId: string; score: number }[]) {
  return autoLlm({ "resolve-rerank": (_req: LlmRequest) => ({ scores: scores() }) });
}

type Lens = { label: string; liked: boolean };
const vote = (conceptId: string, chatId: string, nodeId: string, lenses: Lens[]) => ({ conceptId, chatId, nodeId, lenses });

function rows(ctx: Ctx) {
  return ctx.db
    .prepare("SELECT chat_id, concept_id, node_id, lens_label, liked, created_at, updated_at FROM lens_feedback ORDER BY chat_id, node_id, lens_label")
    .all();
}

// ---------------------------------------------------------------- POST /lens-feedback

describe("POST /lens-feedback", () => {
  it("by conceptId → 201 { saved, conceptId, conceptName } and one row per lens with liked 0/1 and both dates", async () => {
    const { ctx, app } = world();
    const c = conceptIn(ctx, subject(ctx), "Eigenvalues");
    const r = await call(app, "post", "/lens-feedback", vote(c, "chat-1", "n3", [
      { label: "Analogy from physics", liked: true },
      { label: "Counterexample", liked: false },
    ]));
    expect(r.status).toBe(201);
    expect(r.json).toEqual({ saved: 2, conceptId: c, conceptName: "Eigenvalues" });
    expect(rows(ctx)).toEqual([
      { chat_id: "chat-1", concept_id: c, node_id: "n3", lens_label: "Analogy from physics", liked: 1, created_at: T1, updated_at: T1 },
      { chat_id: "chat-1", concept_id: c, node_id: "n3", lens_label: "Counterexample", liked: 0, created_at: T1, updated_at: T1 },
    ]);
  });

  it("by conceptQuery: the best candidate with score ≥ 0.6 and no tie", async () => {
    let ids: string[] = [];
    const { ctx, app } = world({ llm: rerankLlm(() => [{ conceptId: ids[0]!, score: 0.9 }, { conceptId: ids[1]!, score: 0.6 }]) });
    const s = subject(ctx);
    ids = [conceptIn(ctx, s, "Eigenvalues of a matrix"), conceptIn(ctx, s, "Generalized eigenvalues")];
    const r = await call(app, "post", "/lens-feedback", { conceptQuery: "eigenvalues", chatId: "chat-1", nodeId: "n1", lenses: [{ label: "Drawing", liked: true }] });
    expect(r.status).toBe(201);
    expect(r.json).toEqual({ saved: 1, conceptId: ids[0], conceptName: "Eigenvalues of a matrix" });
    expect(count(ctx.db, "SELECT count(*) FROM lens_feedback WHERE concept_id = ?", ids[0])).toBe(1);
  });

  it("idempotent per (chat, node, label): re-voting updates liked and updated_at, keeps created_at and does not duplicate", async () => {
    const { ctx, app } = world();
    const c = conceptIn(ctx, subject(ctx), "Rank");
    expect((await call(app, "post", "/lens-feedback", vote(c, "chat-1", "n1", [{ label: "Drawing", liked: true }]))).status).toBe(201);
    setNow(ctx, T2);
    const r = await call(app, "post", "/lens-feedback", vote(c, "chat-1", "n1", [{ label: "Drawing", liked: false }]));
    expect(r.status).toBe(201);
    expect(r.json.saved).toBe(1);
    expect(rows(ctx)).toEqual([{ chat_id: "chat-1", concept_id: c, node_id: "n1", lens_label: "Drawing", liked: 0, created_at: T1, updated_at: T2 }]);

    // another node or another chat with the same label do count as distinct rows
    await call(app, "post", "/lens-feedback", vote(c, "chat-1", "n2", [{ label: "Drawing", liked: true }]));
    await call(app, "post", "/lens-feedback", vote(c, "chat-2", "n1", [{ label: "Drawing", liked: true }]));
    expect(count(ctx.db, "SELECT count(*) FROM lens_feedback")).toBe(3);
  });

  it("repeated label in the same body: the last one wins (a single row)", async () => {
    const { ctx, app } = world();
    const c = conceptIn(ctx, subject(ctx), "Rank");
    const r = await call(app, "post", "/lens-feedback", vote(c, "chat-1", "n1", [
      { label: "Drawing", liked: true },
      { label: "Counterexample", liked: true },
      { label: "Drawing", liked: false },
    ]));
    expect(r.status).toBe(201);
    // the contract does not fix `saved` with repeats (distinct lenses or body elements?): it is not checked here.
    expect(ctx.db.prepare("SELECT lens_label, liked FROM lens_feedback ORDER BY lens_label").all()).toEqual([
      { lens_label: "Counterexample", liked: 1 },
      { lens_label: "Drawing", liked: 0 },
    ]);
  });

  it("the label is saved trimmed (trim)", async () => {
    const { ctx, app } = world();
    const c = conceptIn(ctx, subject(ctx), "Rank");
    expect((await call(app, "post", "/lens-feedback", vote(c, "chat-1", "n1", [{ label: "  Drawing  ", liked: true }]))).status).toBe(201);
    expect(ctx.db.prepare("SELECT lens_label FROM lens_feedback").pluck().all()).toEqual(["Drawing"]);
  });

  it("ambiguous conceptQuery → 409 ambiguous_concept with candidates; nothing written", async () => {
    let ids: string[] = [];
    const { ctx, app } = world({ llm: rerankLlm(() => [{ conceptId: ids[0]!, score: 0.55 }, { conceptId: ids[1]!, score: 0.4 }]) });
    const s = subject(ctx);
    ids = [conceptIn(ctx, s, "Eigenvalues of a matrix"), conceptIn(ctx, s, "Generalized eigenvalues")];
    const r = await call(app, "post", "/lens-feedback", { conceptQuery: "eigenvalues", chatId: "chat-1", nodeId: "n1", lenses: [{ label: "Drawing", liked: true }] });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("ambiguous_concept");
    expect(r.json.candidates).toEqual([
      { conceptId: ids[0], name: "Eigenvalues of a matrix", score: 0.55 },
      { conceptId: ids[1], name: "Generalized eigenvalues", score: 0.4 },
    ]);
    expect(count(ctx.db, "SELECT count(*) FROM lens_feedback")).toBe(0);
  });

  it("non-existent concept (conceptId or conceptQuery without candidates) → 404 not_found; the route exists and writes nothing", async () => {
    const { ctx, app } = world();
    const c = conceptIn(ctx, subject(ctx), "Rank");
    expect((await call(app, "post", "/lens-feedback", vote(c, "chat-1", "n1", [{ label: "Drawing", liked: true }]))).status).toBe(201);
    for (const target of [{ conceptId: "01JNOTEXIST0000000000000000" }, { conceptQuery: "zzzzqqqq" }]) {
      const r = await call(app, "post", "/lens-feedback", { ...target, chatId: "chat-2", nodeId: "n1", lenses: [{ label: "Drawing", liked: true }] });
      expect(r.status, JSON.stringify(target)).toBe(404);
      expect(r.json).toMatchObject({ error: "not_found" });
    }
    expect(count(ctx.db, "SELECT count(*) FROM lens_feedback")).toBe(1);
  });

  it("accepted limits: 12 lenses, label of 200, chatId of 200 and nodeId of 100", async () => {
    const { ctx, app } = world();
    const c = conceptIn(ctx, subject(ctx), "Rank");
    const twelve = Array.from({ length: 12 }, (_, i) => ({ label: `Lens ${i}`, liked: i % 2 === 0 }));
    const r1 = await call(app, "post", "/lens-feedback", vote(c, "chat-1", "n1", twelve));
    expect(r1.status).toBe(201);
    expect(r1.json.saved).toBe(12);
    const r2 = await call(app, "post", "/lens-feedback", vote(c, "c".repeat(200), "n".repeat(100), [{ label: "l".repeat(200), liked: true }]));
    expect(r2.status).toBe(201);
    expect(count(ctx.db, "SELECT count(*) FROM lens_feedback")).toBe(13);
  });

  it("invalid body → 400 invalid_request without writing", async () => {
    const { ctx, app } = world();
    const c = conceptIn(ctx, subject(ctx), "Rank");
    const ok = vote(c, "chat-1", "n1", [{ label: "Drawing", liked: true }]);
    expect((await call(app, "post", "/lens-feedback", ok)).status).toBe(201); // the route exists
    const thirteen = Array.from({ length: 13 }, (_, i) => ({ label: `Lens ${i}`, liked: true }));
    const cases: [string, object][] = [
      ["0 lentes", { ...ok, chatId: "chat-2", lenses: [] }],
      ["13 lentes", { ...ok, chatId: "chat-2", lenses: thirteen }],
      ["empty label", { ...ok, chatId: "chat-2", lenses: [{ label: "", liked: true }] }],
      ["whitespace-only label", { ...ok, chatId: "chat-2", lenses: [{ label: "   ", liked: true }] }],
      ["label of 201", { ...ok, chatId: "chat-2", lenses: [{ label: "l".repeat(201), liked: true }] }],
      ["liked not boolean", { ...ok, chatId: "chat-2", lenses: [{ label: "Drawing", liked: "yes" }] }],
      ["conceptId and conceptQuery together", { ...ok, chatId: "chat-2", conceptQuery: "rank" }],
      ["neither conceptId nor conceptQuery", { chatId: "chat-2", nodeId: "n1", lenses: ok.lenses }],
      ["empty chatId", { ...ok, chatId: "" }],
      ["chatId of 201", { ...ok, chatId: "c".repeat(201) }],
      ["no chatId", { conceptId: c, nodeId: "n1", lenses: ok.lenses }],
      ["empty nodeId", { ...ok, chatId: "chat-2", nodeId: "" }],
      ["nodeId of 101", { ...ok, chatId: "chat-2", nodeId: "n".repeat(101) }],
    ];
    for (const [name, body] of cases) {
      const r = await call(app, "post", "/lens-feedback", body);
      expect(r.status, name).toBe(400);
      expect(r.json, name).toMatchObject({ error: "invalid_request" });
    }
    expect(count(ctx.db, "SELECT count(*) FROM lens_feedback")).toBe(1);
  });
});

// ---------------------------------------------------------------- GET /lens-feedback

describe("GET /lens-feedback", () => {
  /** Votes from three chats on one concept, plus noise on another concept that must not count. */
  async function seeded() {
    const w = world();
    const { ctx, app } = w;
    const s = subject(ctx);
    const c = conceptIn(ctx, s, "Eigenvalues");
    const other = conceptIn(ctx, s, "Determinants");
    const post = async (chat: string, node: string, lenses: Lens[], conceptId = c) =>
      expect((await call(app, "post", "/lens-feedback", vote(conceptId, chat, node, lenses))).status).toBe(201);

    // T1
    await post("chat-1", "n1", [
      { label: "Analogy from physics", liked: true },
      { label: "Counterexample", liked: false },
      { label: "Drawing in the plane", liked: true },
      { label: "History of the concept", liked: false },
    ]);
    await post("chat-1", "n2", [
      { label: "Step-by-step algorithm", liked: true },
      { label: "Building blocks", liked: false },
    ]);
    await post("chat-1", "n1", [{ label: "Analogy from physics", liked: true }, { label: "Building blocks", liked: true }], other);
    // T2
    setNow(ctx, T2);
    await post("chat-2", "n1", [
      { label: "Analogy from physics", liked: true },
      { label: "Counterexample", liked: true },
      { label: "Edge case", liked: false },
    ]);
    await post("chat-2", "n2", [{ label: "Drawing in the plane", liked: false }, { label: "Building blocks", liked: false }]);
    // T3: re-vote in chat-1/n1 (adds no row, moves lastAt) and a third chat
    setNow(ctx, T3);
    await post("chat-1", "n1", [{ label: "Counterexample", liked: false }]);
    await post("chat-3", "n1", [{ label: "Building blocks", liked: false }]);
    return { ...w, c, other };
  }

  const EXPECTED = (c: string) => ({
    conceptId: c,
    conceptName: "Eigenvalues",
    lenses: [
      // likedCount desc → shownCount desc → label asc
      { label: "Analogy from physics", likedCount: 2, shownCount: 2, lastAt: T2 },
      { label: "Counterexample", likedCount: 1, shownCount: 2, lastAt: T3 },
      { label: "Drawing in the plane", likedCount: 1, shownCount: 2, lastAt: T2 },
      { label: "Step-by-step algorithm", likedCount: 1, shownCount: 1, lastAt: T1 },
      { label: "Building blocks", likedCount: 0, shownCount: 3, lastAt: T3 },
      { label: "Edge case", likedCount: 0, shownCount: 1, lastAt: T2 },
      { label: "History of the concept", likedCount: 0, shownCount: 1, lastAt: T1 },
    ],
  });

  it("aggregates by label across all the concept's chats and nodes, sorts and gives lastAt = last updated_at", async () => {
    const { app, c } = await seeded();
    const r = await call(app, "get", `/lens-feedback?conceptId=${c}`);
    expect(r.status).toBe(200);
    expect(r.json).toEqual(EXPECTED(c));
  });

  it("by conceptQuery returns the same as by conceptId", async () => {
    let id = "";
    const { ctx, app } = world({ llm: rerankLlm(() => [{ conceptId: id, score: 0.95 }]) });
    id = conceptIn(ctx, subject(ctx), "Eigenvalues");
    expect((await call(app, "post", "/lens-feedback", vote(id, "chat-1", "n1", [{ label: "Drawing", liked: true }]))).status).toBe(201);
    const byId = await call(app, "get", `/lens-feedback?conceptId=${id}`);
    const byQuery = await call(app, "get", `/lens-feedback?conceptQuery=${encodeURIComponent("eigenvalues")}`);
    expect(byQuery.status).toBe(200);
    expect(byQuery.json).toEqual({ conceptId: id, conceptName: "Eigenvalues", lenses: [{ label: "Drawing", likedCount: 1, shownCount: 1, lastAt: T1 }] });
    expect(byQuery.json).toEqual(byId.json);
  });

  it("concept without votes → 200 with lenses: [] (even if other concepts have some)", async () => {
    const { ctx, app } = await seeded();
    const fresh = conceptIn(ctx, subject(ctx, "Physics"), "Kinematics");
    const r = await call(app, "get", `/lens-feedback?conceptId=${fresh}`);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ conceptId: fresh, conceptName: "Kinematics", lenses: [] });
  });

  it("exactly one of conceptId / conceptQuery → otherwise 400; non-existent concept → 404; ambiguous → 409", async () => {
    let ids: string[] = [];
    const { ctx, app } = world({ llm: rerankLlm(() => [{ conceptId: ids[0]!, score: 0.55 }, { conceptId: ids[1]!, score: 0.4 }]) });
    const s = subject(ctx);
    ids = [conceptIn(ctx, s, "Eigenvalues of a matrix"), conceptIn(ctx, s, "Generalized eigenvalues")];
    expect((await call(app, "get", `/lens-feedback?conceptId=${ids[0]}`)).status).toBe(200); // the route exists

    for (const qs of ["", `?conceptId=${ids[0]}&conceptQuery=eigenvalues`, "?conceptQuery="]) {
      const r = await call(app, "get", `/lens-feedback${qs}`);
      expect(r.status, qs).toBe(400);
      expect(r.json, qs).toMatchObject({ error: "invalid_request" });
    }
    const missing = await call(app, "get", "/lens-feedback?conceptId=01JNOEXISTE0000000000000000");
    expect(missing.status).toBe(404);
    expect(missing.json).toMatchObject({ error: "not_found" });

    const amb = await call(app, "get", "/lens-feedback?conceptQuery=eigenvalues");
    expect(amb.status).toBe(409);
    expect(amb.json).toMatchObject({ error: "ambiguous_concept" });
    expect(amb.json.candidates.map((x: { conceptId: string }) => x.conceptId)).toEqual(ids);
  });
});
