// L4 — LH sessions: GET /sessions, POST /sessions + MCP start_session, and the entry point of close (ADR 105).
import { CloseSessionResponseSchema, ModelsNotConfiguredErrorSchema, SessionListSchema, StartSessionResponseSchema } from "@graphharness/contracts";
import { LhError, type CreateChatInput } from "@graphharness/lh-client";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sessionsTools } from "../../src/mcp/sessions.ts";
import { fakeLh, seedProposition, seedSubject } from "../../src/testing.ts";
import { call, conceptIn, count, daysFromNow, insertReport, insertSession, mastery, sessionReportData, subject, world, type Ctx } from "../knowledge/helpers.ts";

const LH_PUBLIC = "https://lh.example.ts.net";
const MODELS_503 = JSON.parse(readFileSync(new URL("../../../../packages/lh-client/fixtures/synthetic/http/models-not-configured-503.json", import.meta.url), "utf8"));

interface Rec {
  created: CreateChatInput[];
  sent: { chatId: string; text: string }[];
}

function startWorld(opts: { failCreate?: boolean } = {}) {
  const rec: Rec = { created: [], sent: [] };
  const lh = fakeLh({
    async createChat(input: CreateChatInput) {
      if (opts.failCreate) throw new LhError("POST /api/chats: HTTP 503", { status: 503, code: "models_not_configured", body: MODELS_503 });
      rec.created.push(input);
      return { id: "chat_new_01", title: input.title };
    },
    async sendMessage(chatId: string, text: string) {
      rec.sent.push({ chatId, text });
    },
  });
  const materialsDir = mkdtempSync(join(tmpdir(), "gh-start-"));
  mkdirSync(join(materialsDir, "algebra"));
  mkdirSync(join(materialsDir, "physics"));
  for (const f of ["ch3.pdf", "sheet1.pdf"]) writeFileSync(join(materialsDir, "algebra", f), "%PDF-1.4 fake");
  writeFileSync(join(materialsDir, "physics", "law.pdf"), "%PDF-1.4 fake");
  const w = world({ lh, config: { lhPublicUrl: LH_PUBLIC, materialsDir } });
  // ADR 103: the materials of a session must live under THEIR subject's folder (lh_source_folder).
  const s = seedSubject(w.ctx.db, { name: "Linear Algebra", lhSourceFolder: "algebra" });
  const physics = seedSubject(w.ctx.db, { name: "Physics", lhSourceFolder: "physics" });
  return { ...w, rec, s, physics, materialsDir };
}

/** A concept with n propositions; returns the proposition ids. */
function concept(ctx: Ctx, s: string, name: string, n: number, state?: "solid" | "review" | "weak"): { id: string; props: string[] } {
  const id = conceptIn(ctx, s, name);
  const props = Array.from({ length: n }, (_, i) => seedProposition(ctx.db, { name: `${name}-${i}`, statement: `Statement ${name} ${i}`, conceptId: id }));
  if (state) mastery(ctx, id, state);
  return { id, props };
}

describe("POST /sessions (Today button) and MCP start_session", () => {
  it("createChat receives ≤ 64 picks prioritizing weak/review, sendMessage the goal and the paths; saves lh_sessions; returns the URL", async () => {
    const { ctx, app, rec, s, materialsDir } = startWorld();
    const weak = concept(ctx, s, "Weak", 30, "weak");
    const review = concept(ctx, s, "Review", 20, "review");
    const solid = concept(ctx, s, "Solid", 40, "solid");

    const materials = [join(materialsDir, "algebra", "ch3.pdf"), join(materialsDir, "algebra", "sheet1.pdf")];
    const r = await call(app, "post", "/sessions", {
      subjectId: s, goal: "Review diagonalization for the midterm", kind: "teaching", materialPaths: materials,
      focusConceptIds: [solid.id, review.id, weak.id], // the input order does NOT rule: the state does
    });
    expect(r.status).toBe(201);
    const out = StartSessionResponseSchema.parse(r.json);
    expect(out).toEqual({ chatId: "chat_new_01", url: `${LH_PUBLIC}/chat/chat_new_01` });

    expect(rec.created).toHaveLength(1);
    const input = rec.created[0]!;
    expect(input.kind).toBe("teach"); // the Hub's 'teaching' = LH's 'teach'
    expect(input.title.length).toBeGreaterThan(0);
    const picks = input.graphContext!.propositions;
    expect(picks).toHaveLength(64);
    expect(new Set(picks.map((p) => p.id)).size).toBe(64);
    const ids = new Set(picks.map((p) => p.id));
    for (const id of [...weak.props, ...review.props]) expect(ids.has(id), `prioritizes ${id}`).toBe(true);
    expect(picks.filter((p) => solid.props.includes(p.id))).toHaveLength(14);
    expect(picks[0]).toEqual({ id: expect.any(String), name: expect.any(String), statement: expect.stringContaining("Statement") });

    expect(rec.sent).toHaveLength(1);
    expect(rec.sent[0]!.chatId).toBe("chat_new_01");
    expect(rec.sent[0]!.text).toContain("Review diagonalization for the midterm");
    for (const m of materials) expect(rec.sent[0]!.text).toContain(m);

    expect(ctx.db.prepare("SELECT chat_id, kind, subject_id, started_by, hub_state, title FROM lh_sessions").all()).toEqual([
      { chat_id: "chat_new_01", kind: "teaching", subject_id: s, started_by: "learner", hub_state: "open", title: input.title },
    ]);
  });

  it("ADR 103: materialPaths of ANOTHER subject (or outside the materials dir) → 400, no chat or session is created", async () => {
    const { ctx, app, rec, s, materialsDir } = startWorld();
    const foreign = join(materialsDir, "physics", "law.pdf");
    const r = await call(app, "post", "/sessions", { subjectId: s, goal: "g", kind: "teaching", materialPaths: [foreign] });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("invalid_request");
    // a batch with one good path and one foreign path is rejected as a whole
    const mixed = await call(app, "post", "/sessions", { subjectId: s, goal: "g", kind: "teaching", materialPaths: [join(materialsDir, "algebra", "ch3.pdf"), foreign] });
    expect(mixed.status).toBe(400);
    const outside = await call(app, "post", "/sessions", { subjectId: s, goal: "g", kind: "teaching", materialPaths: ["/etc/passwd"] });
    expect(outside.status).toBe(400);
    await expect(sessionsTools.start_session!(ctx, { subjectId: s, goal: "g", kind: "teaching", materialPaths: [foreign] })).rejects.toMatchObject({ status: 400 });
    expect(rec.created).toEqual([]);
    expect(rec.sent).toEqual([]);
    expect(count(ctx.db, "SELECT count(*) FROM lh_sessions")).toBe(0);
  });

  it("ADR 103: the Physics subject accepts its own materials", async () => {
    const { ctx, rec, physics, materialsDir } = startWorld();
    const p = join(materialsDir, "physics", "law.pdf");
    await sessionsTools.start_session!(ctx, { subjectId: physics, goal: "Hooke", kind: "teaching", materialPaths: [p] });
    expect(rec.sent[0]!.text).toContain(p);
  });

  it("MCP start_session: kind practice → 'practice', started_by 'agent', no materials or focus", async () => {
    const { ctx, rec, s } = startWorld();
    concept(ctx, s, "One", 3, "weak");
    const out = StartSessionResponseSchema.parse(await sessionsTools.start_session!(ctx, { subjectId: s, goal: "Practice", kind: "practice" }));
    expect(out.url).toBe(`${LH_PUBLIC}/chat/${out.chatId}`);
    expect(rec.created[0]!.kind).toBe("practice");
    expect(rec.sent[0]!.text).toContain("Practice");
    expect(ctx.db.prepare("SELECT started_by, kind FROM lh_sessions WHERE chat_id = ?").get(out.chatId)).toEqual({ started_by: "agent", kind: "practice" });
  });

  it("stale (aged) concepts are also prioritized over solid ones", async () => {
    const { ctx, rec, s } = startWorld();
    const stale = concept(ctx, s, "Old", 40); // one hit 50 days ago: P' = 0.65·0.5^(50/60) ≈ 0.365 → weak/stale
    mastery(ctx, stale.id, "review", daysFromNow(-50));
    const fresh = concept(ctx, s, "Fresh", 40, "solid");
    await sessionsTools.start_session!(ctx, { subjectId: s, goal: "g", kind: "teaching", focusConceptIds: [fresh.id, stale.id] });
    const ids = new Set(rec.created[0]!.graphContext!.propositions.map((p) => p.id));
    expect(rec.created[0]!.graphContext!.propositions).toHaveLength(64);
    for (const id of stale.props) expect(ids.has(id)).toBe(true);
  });

  it("models_not_configured (503) passes through unchanged, no session is saved and no message is sent", async () => {
    const { ctx, app, rec, s } = startWorld({ failCreate: true });
    const r = await call(app, "post", "/sessions", { subjectId: s, goal: "g", kind: "teaching" });
    expect(r.status).toBe(503);
    expect(ModelsNotConfiguredErrorSchema.parse(r.json)).toEqual(MODELS_503);
    expect(rec.sent).toEqual([]);
    expect(count(ctx.db, "SELECT count(*) FROM lh_sessions")).toBe(0);
    await expect(sessionsTools.start_session!(ctx, { subjectId: s, goal: "g", kind: "teaching" })).rejects.toMatchObject({ status: 503, code: "models_not_configured" });
  });

  it("LH down → 502 lh_unavailable; unknown subject → 404; invalid body → 400 and LH is not called", async () => {
    const down = fakeLh({ createChat: async () => Promise.reject(new LhError("x", { status: 0, code: "unreachable" })) });
    const w = world({ lh: down });
    const s = subject(w.ctx);
    const r = await call(w.app, "post", "/sessions", { subjectId: s, goal: "g", kind: "teaching" });
    expect(r.status).toBe(502);
    expect(r.json.error).toBe("lh_unavailable");

    const { app, rec } = startWorld();
    expect((await call(app, "post", "/sessions", { subjectId: "nope", goal: "g", kind: "teaching" })).status).toBe(404);
    for (const bad of [{ goal: "g", kind: "teaching" }, { subjectId: "x", goal: " ", kind: "teaching" }, { subjectId: "x", goal: "g", kind: "other" }, { subjectId: "x", goal: "g", kind: "teaching", materialPaths: ["relative.pdf"] }]) {
      const e = await call(app, "post", "/sessions", bad);
      expect(e.status).toBe(400);
      expect(e.json.error).toBe("invalid_request");
    }
    expect(rec.created).toEqual([]);
  });
});

describe("GET /sessions", () => {
  function seed() {
    const w = world();
    const s1 = subject(w.ctx, "Algebra");
    const s2 = subject(w.ctx, "Physics");
    // ids and dates grow together: any "most recent first" criterion gives the same order
    insertSession(w.ctx.db, { chatId: "c_001", title: "First", subjectId: s1, hubState: "closed", settledAt: daysFromNow(-5), closedAt: daysFromNow(-5) });
    insertSession(w.ctx.db, { chatId: "c_002", title: "Second", subjectId: s2, hubState: "closed", settledAt: daysFromNow(-3), closedAt: daysFromNow(-3), startedBy: "agent" });
    insertSession(w.ctx.db, { chatId: "c_003", title: "Third", subjectId: s1, hubState: "open", settledAt: daysFromNow(-1), kind: "practice", startedBy: "learner" });
    insertSession(w.ctx.db, { chatId: "c_004", title: "No subject", hubState: "closing", settledAt: daysFromNow(-0.5) });
    const rep = insertReport(w.ctx.db, { kind: "session", chatId: "c_002", subjectId: s2, data: sessionReportData("c_002", s2) });
    return { ...w, s1, s2, rep };
  }

  it("lists with the contract shape, LH url, reportId, and from the most recent to the oldest", async () => {
    const { app, s2, rep } = seed();
    const r = await call(app, "get", "/sessions");
    expect(r.status).toBe(200);
    const list = SessionListSchema.parse(r.json);
    expect(list.map((x) => x.chatId)).toEqual(["c_004", "c_003", "c_002", "c_001"]);
    expect(list.find((x) => x.chatId === "c_002")).toMatchObject({ title: "Second", kind: "teaching", subjectId: s2, startedBy: "agent", hubState: "closed", reportId: rep });
    expect(list.find((x) => x.chatId === "c_003")).toMatchObject({ kind: "practice", startedBy: "learner", hubState: "open", closedAt: null, reportId: null });
    expect(list.find((x) => x.chatId === "c_004")).toMatchObject({ subjectId: null, startedBy: null });
    for (const x of list) expect(x.url.endsWith(`/chat/${x.chatId}`)).toBe(true);
  });

  it("filters by subjectId and hubState and honors limit", async () => {
    const { app, s1 } = seed();
    expect(SessionListSchema.parse((await call(app, "get", `/sessions?subjectId=${s1}`)).json).map((x) => x.chatId)).toEqual(["c_003", "c_001"]);
    expect(SessionListSchema.parse((await call(app, "get", "/sessions?hubState=closed")).json).map((x) => x.chatId)).toEqual(["c_002", "c_001"]);
    expect(SessionListSchema.parse((await call(app, "get", "/sessions?limit=2")).json).map((x) => x.chatId)).toEqual(["c_004", "c_003"]);
    expect((await call(app, "get", "/sessions?hubState=weird")).status).toBe(400);
    expect((await call(app, "get", "/sessions?limit=0")).status).toBe(400);
  });
});

describe("POST /sessions/:chatId/close and MCP close_session", () => {
  const jobs = (ctx: Ctx) => ctx.db.prepare("SELECT type, payload_json AS p, status FROM jobs WHERE type = 'session-close'").all();

  it("moves to closing and enqueues session-close only once (idempotent)", async () => {
    const { ctx, app } = world();
    insertSession(ctx.db, { chatId: "c_open", hubState: "open" });
    const r = await call(app, "post", "/sessions/c_open/close");
    expect(r.status).toBe(202);
    expect(CloseSessionResponseSchema.parse(r.json)).toEqual({ chatId: "c_open", hubState: "closing", queued: true });
    expect(ctx.db.prepare("SELECT hub_state FROM lh_sessions WHERE chat_id = 'c_open'").pluck().get()).toBe("closing");
    expect(jobs(ctx)).toEqual([{ type: "session-close", p: JSON.stringify({ chatId: "c_open" }), status: "queued" }]);

    const again = await call(app, "post", "/sessions/c_open/close");
    expect(again.status).toBe(202);
    expect(CloseSessionResponseSchema.parse(again.json)).toEqual({ chatId: "c_open", hubState: "closing", queued: false });
    expect(jobs(ctx)).toHaveLength(1);
  });

  it("404 for an unknown session (REST and MCP)", async () => {
    const { ctx, app } = world();
    expect((await call(app, "post", "/sessions/nope/close")).status).toBe(404);
    await expect(sessionsTools.close_session!(ctx, { chatId: "nope" })).rejects.toMatchObject({ status: 404 });
    expect(jobs(ctx)).toEqual([]);
  });

  it("MCP close_session does the same as REST", async () => {
    const { ctx } = world();
    insertSession(ctx.db, { chatId: "c_mcp", hubState: "open" });
    expect(CloseSessionResponseSchema.parse(await sessionsTools.close_session!(ctx, { chatId: "c_mcp" }))).toEqual({ chatId: "c_mcp", hubState: "closing", queued: true });
    expect(ctx.db.prepare("SELECT hub_state FROM lh_sessions WHERE chat_id = 'c_mcp'").pluck().get()).toBe("closing");
    expect(jobs(ctx)).toHaveLength(1);
    expect(CloseSessionResponseSchema.parse(await sessionsTools.close_session!(ctx, { chatId: "c_mcp" })).queued).toBe(false);
    expect(jobs(ctx)).toHaveLength(1);
  });
});
