// L1 — Map, concept detail, manual state change, maintenance and suggestions (REST).
import {
  AcceptSuggestionResponseSchema,
  ConceptDetailSchema,
  ConceptSuggestionListSchema,
  ConceptSuggestionSchema,
  DeclarationRecordedSchema,
  MergeConceptsResponseSchema,
  PatchConceptEdgesResponseSchema,
  SplitConceptResponseSchema,
  SubjectMapSchema,
  WeakPrerequisitesErrorSchema,
} from "@graphharness/contracts";
import { describe, expect, it } from "vitest";
import { seedEdge, seedProposition } from "../../src/testing.ts";
import { rebuildAllStates } from "../../src/services/evidence.ts";
import { NOW, call, conceptIn, count, daysFromNow, insertSuggestion, insertTemplate, mastery, subject, world, type Ctx } from "./helpers.ts";

const stateRow = (ctx: Ctx, id: string) =>
  ctx.db.prepare("SELECT probability, decay_class AS decayClass, source, manual_confirmation AS mc, updated_at AS updatedAt FROM concept_state WHERE concept_id = ?").get(id) as
    | { probability: number; decayClass: string; source: string; mc: string | null; updatedAt: string }
    | undefined;

describe("GET /subjects/:id/map", () => {
  it("returns active concepts with effective state, counters and only the non-removed edges", async () => {
    const { ctx, app } = world();
    const s = subject(ctx);
    const solid = conceptIn(ctx, s, "Solid", ["Statement one", "Statement two"]);
    const review = conceptIn(ctx, s, "To review");
    const weak = conceptIn(ctx, s, "Weak");
    const unknown = conceptIn(ctx, s, "No record");
    const pending = conceptIn(ctx, s, "Declared");
    const merged = conceptIn(ctx, s, "Merged");
    const other = conceptIn(ctx, subject(ctx, "Another"), "From another subject");
    ctx.db.prepare("UPDATE concepts SET status = 'merged', merged_into = ? WHERE id = ?").run(solid, merged);
    mastery(ctx, solid, "solid");
    mastery(ctx, review, "review");
    mastery(ctx, weak, "weak");
    mastery(ctx, pending, "pending");
    // a deleted proposition does not count; neither does a failed template
    const deadProp = seedProposition(ctx.db, { statement: "Deleted", conceptId: solid });
    ctx.db.prepare("UPDATE lh_propositions SET deleted = 1 WHERE id = ?").run(deadProp);
    insertTemplate(ctx.db, solid, { status: "active" });
    insertTemplate(ctx.db, solid, { status: "failed" });
    seedEdge(ctx.db, weak, review, "high");
    seedEdge(ctx.db, review, solid, "low");
    seedEdge(ctx.db, unknown, solid, "medium");
    seedEdge(ctx.db, unknown, pending, "high");
    ctx.db.prepare("UPDATE concept_edges SET removed = 1 WHERE from_concept = ? AND to_concept = ?").run(unknown, pending);

    const r = await call(app, "get", `/subjects/${s}/map`);
    expect(r.status).toBe(200);
    const map = SubjectMapSchema.parse(r.json);
    expect(map.subject.id).toBe(s);
    const byId = new Map(map.concepts.map((c) => [c.id, c]));
    expect(byId.size).toBe(5);
    expect(byId.has(merged)).toBe(false);
    expect(byId.has(other)).toBe(false);

    expect(byId.get(solid)).toMatchObject({ state: "solid", stale: false, manualConfirmation: null, templateCount: 1, propositionCount: 2 });
    expect(byId.get(solid)!.probability).toBeCloseTo(0.95, 6);
    expect(byId.get(review)).toMatchObject({ state: "review", templateCount: 0, propositionCount: 0 });
    expect(byId.get(review)!.probability).toBeCloseTo(0.65, 6);
    expect(byId.get(weak)).toMatchObject({ state: "weak" });
    expect(byId.get(weak)!.probability).toBeCloseTo(0.3, 6);
    expect(byId.get(unknown)).toMatchObject({ state: "unknown", probability: null, stale: false, manualConfirmation: null });
    // unconfirmed declaration: P = 0.85 → solid, but "pending"
    expect(byId.get(pending)).toMatchObject({ state: "solid", manualConfirmation: "pending" });
    expect(byId.get(pending)!.probability).toBeCloseTo(0.85, 6);

    const edges = map.edges.map((e) => `${e.from}>${e.to}:${e.confidence}`).sort();
    expect(edges).toEqual([`${weak}>${review}:high`, `${review}>${solid}:low`, `${unknown}>${solid}:medium`].sort());
  });

  it("applies decay: an open hit (P 0.65, half-life 60 d) at 60 days is worth 0.325 → weak", async () => {
    const { ctx, app } = world();
    const s = subject(ctx);
    const c = conceptIn(ctx, s, "Old");
    mastery(ctx, c, "review", daysFromNow(-60));
    const map = SubjectMapSchema.parse((await call(app, "get", `/subjects/${s}/map`)).json);
    const mc = map.concepts.find((x) => x.id === c)!;
    expect(mc.probability).toBeCloseTo(0.325, 4);
    expect(mc.state).toBe("weak");
  });

  it("404 if the subject does not exist", async () => {
    const { app } = world();
    const r = await call(app, "get", "/subjects/nope/map");
    expect(r.status).toBe(404);
    expect(r.json).toEqual({ error: "not_found" });
  });
});

describe("GET /concepts/:id", () => {
  it("full detail: live propositions, templates, recent evidence (newest first), notes and state", async () => {
    const { ctx, app } = world();
    const s = subject(ctx, "Linear Algebra");
    const c = conceptIn(ctx, s, "Eigenvalues", ["An eigenvalue λ satisfies det(A-λI)=0."]);
    const dead = seedProposition(ctx.db, { statement: "Deleted", conceptId: c });
    ctx.db.prepare("UPDATE lh_propositions SET deleted = 1 WHERE id = ?").run(dead);
    insertTemplate(ctx.db, c, { name: "Characteristic polynomial" });
    mastery(ctx, c, "review", daysFromNow(-2)); // hit
    mastery(ctx, c, "weak", daysFromNow(-1)); // miss, most recent
    ctx.db.prepare("INSERT INTO notes (id, concept_id, text, origin, created_at) VALUES ('n1', ?, 'Sure to be on it', 'agent', ?)").run(c, NOW);

    const r = await call(app, "get", `/concepts/${c}`);
    expect(r.status).toBe(200);
    const d = ConceptDetailSchema.parse(r.json);
    expect(d).toMatchObject({ id: c, subjectId: s, subjectName: "Linear Algebra", name: "Eigenvalues", status: "active", mergedInto: null, createdBy: "curator" });
    expect(d.propositions).toHaveLength(1);
    expect(d.propositions[0]!.statement).toContain("eigenvalue");
    expect(d.templates.map((t) => t.name)).toEqual(["Characteristic polynomial"]);
    expect(d.notes).toMatchObject([{ id: "n1", text: "Sure to be on it", origin: "agent", conceptId: c }]);
    expect(d.recentEvidence).toHaveLength(2);
    expect(d.recentEvidence[0]!.at > d.recentEvidence[1]!.at).toBe(true);
    expect(d.recentEvidence[0]!.correct).toBe(false);
    expect(d.state.conceptId).toBe(c);
    expect(d.state.state).not.toBe("unknown");
  });

  it("concept without evidence → unknown; 404 if it does not exist", async () => {
    const { ctx, app } = world();
    const c = conceptIn(ctx, null, "Loose");
    const d = ConceptDetailSchema.parse((await call(app, "get", `/concepts/${c}`)).json);
    expect(d.subjectId).toBeNull();
    expect(d.subjectName).toBeNull();
    expect(d.state).toMatchObject({ state: "unknown", probability: null, manualConfirmation: null, lastEvidenceAt: null });
    expect((await call(app, "get", "/concepts/nope")).status).toBe(404);
  });
});

describe("PATCH /concepts/:id/state (GL-013)", () => {
  const body = { targetState: "solid", justification: "I got it in class today" };

  async function target(over: { edge?: "high" | "medium" | "low"; removed?: boolean } = {}) {
    const w = world();
    const s = subject(w.ctx);
    const t = conceptIn(w.ctx, s, "Diagonalization");
    const p = conceptIn(w.ctx, s, "Eigenvalues");
    mastery(w.ctx, p, "weak");
    seedEdge(w.ctx.db, p, t, over.edge ?? "high");
    if (over.removed) w.ctx.db.prepare("UPDATE concept_edges SET removed = 1").run();
    return { ...w, s, t, p };
  }

  it("weak prerequisite via a high edge → 409 weak_prerequisites with path and nothing recorded", async () => {
    const { ctx, app, t, p } = await target({ edge: "high" });
    const r = await call(app, "patch", `/concepts/${t}/state`, body);
    expect(r.status).toBe(409);
    const e = WeakPrerequisitesErrorSchema.parse(r.json);
    expect(e.weakPrerequisites).toEqual([{ conceptId: p, name: "Eigenvalues", state: "weak", path: [p, t] }]);
    expect(count(ctx.db, "SELECT count(*) FROM declarations")).toBe(0);
    expect(count(ctx.db, "SELECT count(*) FROM evidence_events WHERE concept_id = ?", t)).toBe(0);
  });

  it("a medium edge also warns", async () => {
    const { app, t, p } = await target({ edge: "medium" });
    const r = await call(app, "patch", `/concepts/${t}/state`, body);
    expect(r.status).toBe(409);
    expect(WeakPrerequisitesErrorSchema.parse(r.json).weakPrerequisites.map((w) => w.conceptId)).toEqual([p]);
  });

  it("a prerequisite without evidence (unknown) also warns", async () => {
    const w = world();
    const s = subject(w.ctx);
    const t = conceptIn(w.ctx, s, "T");
    const p = conceptIn(w.ctx, s, "P");
    seedEdge(w.ctx.db, p, t, "high");
    const r = await call(w.app, "patch", `/concepts/${t}/state`, body);
    expect(r.status).toBe(409);
    expect(WeakPrerequisitesErrorSchema.parse(r.json).weakPrerequisites[0]).toMatchObject({ conceptId: p, state: "unknown" });
  });

  it("does NOT warn for a low edge or a removed edge", async () => {
    for (const over of [{ edge: "low" as const }, { edge: "high" as const, removed: true }]) {
      const { app, t } = await target(over);
      const r = await call(app, "patch", `/concepts/${t}/state`, body);
      expect(r.status).toBe(200);
      expect(DeclarationRecordedSchema.parse(r.json).weakPrerequisites).toEqual([]);
    }
  });

  it("does NOT warn for a prerequisite more than 3 levels away; it does at 3", async () => {
    const w = world();
    const s = subject(w.ctx);
    const mk = (n: string, k: "solid" | "weak") => {
      const id = conceptIn(w.ctx, s, n);
      mastery(w.ctx, id, k);
      return id;
    };
    // far: A → B → C → D → T (A at depth 4)
    const [A, B, C, D, T] = [mk("A", "weak"), mk("B", "solid"), mk("C", "solid"), mk("D", "solid"), mk("T", "solid")] as [string, string, string, string, string];
    seedEdge(w.ctx.db, A, B); seedEdge(w.ctx.db, B, C); seedEdge(w.ctx.db, C, D); seedEdge(w.ctx.db, D, T);
    expect((await call(w.app, "patch", `/concepts/${T}/state`, body)).status).toBe(200);
    // near: A2 → B2 → C2 → T2 (A2 at depth 3)
    const [A2, B2, C2, T2] = [mk("A2", "weak"), mk("B2", "solid"), mk("C2", "solid"), mk("T2", "solid")] as [string, string, string, string];
    seedEdge(w.ctx.db, A2, B2); seedEdge(w.ctx.db, B2, C2); seedEdge(w.ctx.db, C2, T2);
    const r = await call(w.app, "patch", `/concepts/${T2}/state`, body);
    expect(r.status).toBe(409);
    expect(WeakPrerequisitesErrorSchema.parse(r.json).weakPrerequisites).toEqual([{ conceptId: A2, name: "A2", state: "weak", path: [A2, B2, C2, T2] }]);
  });

  it("with ackWeakPrerequisites → 200 recorded, pending declaration and P=0.85 manual_pending", async () => {
    const { ctx, app, t, p } = await target();
    const r = await call(app, "patch", `/concepts/${t}/state`, { ...body, ackWeakPrerequisites: true });
    expect(r.status).toBe(200);
    const out = DeclarationRecordedSchema.parse(r.json);
    expect(out.status).toBe("recorded");
    expect(out.weakPrerequisites.map((w) => w.conceptId)).toEqual([p]);
    expect(out.conceptState).toMatchObject({ conceptId: t, state: "solid", manualConfirmation: "pending", lastEvidenceAt: NOW });
    expect(out.conceptState.probability).toBeCloseTo(0.85, 6);
    // 1–2 confirmation items with the contract's shape (the schema is strict)
    expect(out.confirmationItems.length).toBeGreaterThanOrEqual(1);
    expect(out.confirmationItems.length).toBeLessThanOrEqual(2);
    for (const it of out.confirmationItems) expect(it.conceptId).toBe(t);

    const decl = ctx.db.prepare("SELECT * FROM declarations WHERE id = ?").get(out.declarationId) as Record<string, unknown>;
    expect(decl).toMatchObject({ concept_id: t, target_state: "solid", origin: "pwa", status: "pending", ack_weak_prereqs: 1, justification: body.justification });
    const st = stateRow(ctx, t)!;
    expect(st).toMatchObject({ decayClass: "manual_pending", source: "manual", mc: "pending" });
    expect(st.probability).toBeCloseTo(0.85, 6);
    const evs = ctx.db.prepare("SELECT source, target_state AS ts, correct FROM evidence_events WHERE concept_id = ?").all(t);
    expect(evs).toEqual([{ source: "declaration", ts: "solid", correct: null }]);
    // the confirmation items were saved as cards of the declaration (ADR 102 §10)
    expect(count(ctx.db, "SELECT count(*) FROM cards WHERE declaration_id = ? AND purpose = 'confirmation'", out.declarationId)).toBe(out.confirmationItems.length);
  });

  it("without weak prerequisites it records directly; 404 and 400", async () => {
    const w = world();
    const t = conceptIn(w.ctx, subject(w.ctx), "Libre");
    const r = await call(w.app, "patch", `/concepts/${t}/state`, { targetState: "weak", justification: "No me sale" });
    expect(r.status).toBe(200);
    const out = DeclarationRecordedSchema.parse(r.json);
    expect(out.weakPrerequisites).toEqual([]);
    expect(out.conceptState.probability).toBeCloseTo(0.25, 6);
    expect(out.conceptState.state).toBe("weak");
    expect((await call(w.app, "patch", "/concepts/nope/state", body)).status).toBe(404);
    for (const bad of [{}, { targetState: "unknown", justification: "x" }, { targetState: "solid", justification: "  " }]) {
      const e = await call(w.app, "patch", `/concepts/${t}/state`, bad);
      expect(e.status).toBe(400);
      expect(e.json.error).toBe("invalid_request");
    }
  });
});

describe("POST /concepts/:id/merge (invariant)", () => {
  it("re-points evidence and propositions to the target, retires the source and recomputes the state", async () => {
    const { ctx, app } = world();
    const s = subject(ctx);
    const target = conceptIn(ctx, s, "Target", ["P target"]);
    const source = conceptIn(ctx, s, "Source", ["P source"]);
    mastery(ctx, target, "weak", "2026-11-05T09:00:00.000Z"); // miss: P 0.30, class strain
    mastery(ctx, source, "solid", NOW); // 3 open hits

    const r = await call(app, "post", `/concepts/${target}/merge`, { sourceIds: [source] });
    expect(r.status).toBe(200);
    const out = MergeConceptsResponseSchema.parse(r.json);
    expect(out).toMatchObject({ targetId: target, mergedIds: [source] });
    expect(out.concept.id).toBe(target);
    expect(out.concept.propositions).toHaveLength(2);

    expect(ctx.db.prepare("SELECT status, merged_into AS m FROM concepts WHERE id = ?").get(source)).toEqual({ status: "merged", m: target });
    expect(count(ctx.db, "SELECT count(*) FROM evidence_events WHERE concept_id = ?", source)).toBe(0);
    expect(count(ctx.db, "SELECT count(*) FROM evidence_events WHERE concept_id = ?", target)).toBe(4);
    expect(count(ctx.db, "SELECT count(*) FROM concept_propositions WHERE concept_id = ?", target)).toBe(2);
    expect(stateRow(ctx, source)).toBeUndefined();

    // by hand: miss 0.30 (strain, 21 d) → at 5 days 0.30·0.5^(5/21)=0.2543; +0.15·3 = 0.7043
    const st = stateRow(ctx, target)!;
    expect(st.probability).toBeCloseTo(0.7043, 3);
    // invariant: rebuilding from the log gives exactly what was materialised
    const before = JSON.stringify(st);
    rebuildAllStates(ctx.db);
    expect(JSON.stringify(stateRow(ctx, target))).toBe(before);
    // and reading through the API reflects the merged state
    const d = ConceptDetailSchema.parse((await call(app, "get", `/concepts/${target}`)).json);
    expect(d.state).toMatchObject({ state: "review" });
    expect(d.state.probability).toBeCloseTo(0.7043, 3);
  });

  it("errors: 404 for a non-existent target/source, 409 invalid_merge if the source is the target itself", async () => {
    const { ctx, app } = world();
    const c = conceptIn(ctx, null, "C");
    expect((await call(app, "post", "/concepts/nope/merge", { sourceIds: [c] })).status).toBe(404);
    expect((await call(app, "post", `/concepts/${c}/merge`, { sourceIds: ["nope"] })).status).toBe(404);
    const self = await call(app, "post", `/concepts/${c}/merge`, { sourceIds: [c] });
    expect(self.status).toBe(409);
    expect(self.json).toMatchObject({ error: "invalid_merge" });
    expect((await call(app, "post", `/concepts/${c}/merge`, { sourceIds: [] })).status).toBe(400);
  });
});

describe("POST /concepts/:id/split", () => {
  function setup() {
    const w = world();
    const s = subject(w.ctx);
    const x = conceptIn(w.ctx, s, "Grande");
    const ps = [1, 2, 3, 4].map((i) => seedProposition(w.ctx.db, { statement: `Statement ${i}`, conceptId: x }));
    return { ...w, s, x, ps };
  }

  it("creates new concepts with their propositions; the original stays active if it keeps any", async () => {
    const { ctx, app, x, ps, s } = setup();
    const r = await call(app, "post", `/concepts/${x}/split`, {
      parts: [
        { name: "Part A", description: "First half", propositionIds: [ps[0], ps[1]] },
        { name: "Part B", description: "Second", propositionIds: [ps[2]] },
      ],
    });
    expect(r.status).toBe(201);
    const out = SplitConceptResponseSchema.parse(r.json);
    expect(out.sourceId).toBe(x);
    expect(out.sourceStatus).toBe("active");
    expect(out.createdIds).toHaveLength(2);
    const owner = (p: string) => ctx.db.prepare("SELECT concept_id FROM concept_propositions WHERE proposition_id = ?").pluck().get(p);
    expect(owner(ps[0]!)).toBe(out.createdIds[0]);
    expect(owner(ps[1]!)).toBe(out.createdIds[0]);
    expect(owner(ps[2]!)).toBe(out.createdIds[1]);
    expect(owner(ps[3]!)).toBe(x);
    expect(ctx.db.prepare("SELECT name, description, subject_id AS s, status FROM concepts WHERE id = ?").get(out.createdIds[0])).toEqual({
      name: "Part A", description: "First half", s, status: "active",
    });
  });

  it("if all the propositions are taken, the original ends up retired", async () => {
    const { ctx, app, x, ps } = setup();
    const r = await call(app, "post", `/concepts/${x}/split`, {
      parts: [
        { name: "A", description: "a", propositionIds: [ps[0], ps[1]] },
        { name: "B", description: "b", propositionIds: [ps[2], ps[3]] },
      ],
    });
    expect(r.status).toBe(201);
    expect(SplitConceptResponseSchema.parse(r.json).sourceStatus).toBe("retired");
    expect(ctx.db.prepare("SELECT status FROM concepts WHERE id = ?").pluck().get(x)).toBe("retired");
  });

  it("proposition not belonging to the concept → 409 invalid_split and nothing changes; 404; 400 with a single part", async () => {
    const { ctx, app, x, ps } = setup();
    const foreign = seedProposition(ctx.db, { statement: "Foreign", conceptId: conceptIn(ctx, null, "Other") });
    const r = await call(app, "post", `/concepts/${x}/split`, {
      parts: [
        { name: "A", description: "a", propositionIds: [ps[0]] },
        { name: "B", description: "b", propositionIds: [foreign] },
      ],
    });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ error: "invalid_split" });
    expect(count(ctx.db, "SELECT count(*) FROM concepts")).toBe(2);
    expect((await call(app, "post", "/concepts/nope/split", { parts: [{ name: "A", description: "a", propositionIds: ["p"] }, { name: "B", description: "b", propositionIds: ["q"] }] })).status).toBe(404);
    expect((await call(app, "post", `/concepts/${x}/split`, { parts: [{ name: "A", description: "a", propositionIds: [ps[0]] }] })).status).toBe(400);
  });
});

describe("PATCH /concepts/:id", () => {
  it("edits fields, assigns a subject and re-assigns propositions (assigned_by = 'pwa')", async () => {
    const { ctx, app } = world();
    const s = subject(ctx);
    const c = conceptIn(ctx, null, "No subject");
    const other = conceptIn(ctx, s, "Other", ["Foreign proposition"]);
    const prop = ctx.db.prepare("SELECT proposition_id FROM concept_propositions WHERE concept_id = ?").pluck().get(other) as string;
    const r = await call(app, "patch", `/concepts/${c}`, { name: "With subject", subjectId: s, optional: true, addPropositionIds: [prop] });
    expect(r.status).toBe(200);
    const d = ConceptDetailSchema.parse(r.json);
    expect(d).toMatchObject({ id: c, name: "With subject", subjectId: s, optional: true });
    expect(d.propositions.map((p) => p.id)).toEqual([prop]);
    expect(ctx.db.prepare("SELECT concept_id AS c, assigned_by AS b FROM concept_propositions WHERE proposition_id = ?").get(prop)).toEqual({ c, b: "pwa" });
    const retired = await call(app, "patch", `/concepts/${c}`, { status: "retired" });
    expect(ConceptDetailSchema.parse(retired.json).status).toBe("retired");
    expect((await call(app, "patch", "/concepts/nope", { name: "x" })).status).toBe(404);
    expect((await call(app, "patch", `/concepts/${c}`, {})).status).toBe(400);
    expect((await call(app, "patch", `/concepts/${c}`, { status: "merged" })).status).toBe(400);
  });
});

describe("PATCH /concept-edges", () => {
  it("adds manual edges, removes with removed=1 and rejects cycles", async () => {
    const { ctx, app } = world();
    const s = subject(ctx);
    const [a, b, c] = [conceptIn(ctx, s, "A"), conceptIn(ctx, s, "B"), conceptIn(ctx, s, "C")] as [string, string, string];
    seedEdge(ctx.db, a, c, "high");

    const r = await call(app, "patch", "/concept-edges", {
      add: [{ from: a, to: b, justification: "A is used in B" }],
      remove: [{ from: a, to: c, justification: "Not needed" }],
    });
    expect(r.status).toBe(200);
    const out = PatchConceptEdgesResponseSchema.parse(r.json);
    expect(out.added).toHaveLength(1);
    expect(out.added[0]).toMatchObject({ from: a, to: b, relation: "requires", source: "manual", justification: "A is used in B" });
    expect(out.removed).toEqual([{ from: a, to: c }]);
    expect(ctx.db.prepare("SELECT source, removed FROM concept_edges WHERE from_concept = ? AND to_concept = ?").get(a, b)).toMatchObject({ source: "manual", removed: 0 });
    expect(ctx.db.prepare("SELECT removed FROM concept_edges WHERE from_concept = ? AND to_concept = ?").pluck().get(a, c)).toBe(1);

    // B → A would close a cycle with A → B
    const cyc = await call(app, "patch", "/concept-edges", { add: [{ from: b, to: a, justification: "cycle" }] });
    expect(cyc.status).toBe(409);
    expect(cyc.json).toMatchObject({ error: "cycle" });
    expect(ctx.db.prepare("SELECT 1 FROM concept_edges WHERE from_concept = ? AND to_concept = ?").get(b, a)).toBeUndefined();
  });

  it("404 with non-existent concepts and 400 with an empty body or a self-edge", async () => {
    const { ctx, app } = world();
    const a = conceptIn(ctx, null, "A");
    expect((await call(app, "patch", "/concept-edges", { add: [{ from: a, to: "nope", justification: "x" }] })).status).toBe(404);
    expect((await call(app, "patch", "/concept-edges", {})).status).toBe(400);
    expect((await call(app, "patch", "/concept-edges", { add: [{ from: a, to: a, justification: "x" }] })).status).toBe(400);
  });
});

describe("concept-suggestions", () => {
  function setup() {
    const w = world();
    const s = subject(w.ctx);
    const t = conceptIn(w.ctx, s, "Target", ["One"]);
    const src = conceptIn(w.ctx, s, "Duplicate", ["Two"]);
    const big = conceptIn(w.ctx, s, "Huge");
    const [p1, p2] = [seedProposition(w.ctx.db, { statement: "x1", conceptId: big }), seedProposition(w.ctx.db, { statement: "x2", conceptId: big })] as [string, string];
    const merge = insertSuggestion(w.ctx.db, "merge", { sourceIds: [src], targetId: t });
    const split = insertSuggestion(w.ctx.db, "split", {
      conceptId: big,
      parts: [{ name: "Huge 1", description: "d1", propositionIds: [p1] }, { name: "Huge 2", description: "d2", propositionIds: [p2] }],
    });
    const old = insertSuggestion(w.ctx.db, "merge", { sourceIds: [src], targetId: t }, { status: "dismissed" });
    return { ...w, t, src, big, merge, split, old };
  }

  it("lists the open ones by default, with names; ?status filters", async () => {
    const { app, merge, split, old, t, src } = setup();
    const open = ConceptSuggestionListSchema.parse((await call(app, "get", "/concept-suggestions")).json);
    expect(open.map((x) => x.id).sort()).toEqual([merge, split].sort());
    const m = open.find((x) => x.id === merge)!;
    expect(m).toMatchObject({ kind: "merge", targetId: t, sourceIds: [src], status: "open", resolvedAt: null, rationale: "Because." });
    expect(m.conceptNames).toMatchObject({ [t]: "Target", [src]: "Duplicate" });
    const dis = ConceptSuggestionListSchema.parse((await call(app, "get", "/concept-suggestions?status=dismissed")).json);
    expect(dis.map((x) => x.id)).toEqual([old]);
    expect((await call(app, "get", "/concept-suggestions?status=other")).status).toBe(400);
  });

  it("accept applies the merge; accepting again → 409 not_open", async () => {
    const { ctx, app, merge, t, src } = setup();
    const r = await call(app, "post", `/concept-suggestions/${merge}/accept`);
    expect(r.status).toBe(200);
    expect(AcceptSuggestionResponseSchema.parse(r.json)).toEqual({ suggestionId: merge, kind: "merge", conceptIds: [t] });
    expect(ctx.db.prepare("SELECT status FROM concepts WHERE id = ?").pluck().get(src)).toBe("merged");
    expect(ctx.db.prepare("SELECT status FROM concept_suggestions WHERE id = ?").pluck().get(merge)).toBe("accepted");
    const again = await call(app, "post", `/concept-suggestions/${merge}/accept`);
    expect(again.status).toBe(409);
    expect(again.json).toMatchObject({ error: "not_open" });
  });

  it("accepting a split creates the new concepts", async () => {
    const { app, split, big } = setup();
    const r = await call(app, "post", `/concept-suggestions/${split}/accept`);
    expect(r.status).toBe(200);
    const out = AcceptSuggestionResponseSchema.parse(r.json);
    expect(out.kind).toBe("split");
    expect(out.conceptIds).toHaveLength(2);
    expect(out.conceptIds).not.toContain(big);
  });

  it("dismiss leaves the suggestion 'dismissed'; dismissing again or accepting a dismissed one → 409 not_open", async () => {
    const { ctx, app, split } = setup();
    const r = await call(app, "post", `/concept-suggestions/${split}/dismiss`);
    expect(r.status).toBe(200);
    const s = ConceptSuggestionSchema.parse(r.json);
    expect(s).toMatchObject({ id: split, kind: "split", status: "dismissed" });
    expect(s.resolvedAt).toBe(NOW);
    expect(count(ctx.db, "SELECT count(*) FROM concepts")).toBe(3);
    expect((await call(app, "post", `/concept-suggestions/${split}/dismiss`)).json).toMatchObject({ error: "not_open" });
    const acc = await call(app, "post", `/concept-suggestions/${split}/accept`);
    expect(acc.status).toBe(409);
    expect(acc.json).toMatchObject({ error: "not_open" });
  });

  it("404 with an unknown id", async () => {
    const { app } = setup();
    expect((await call(app, "post", "/concept-suggestions/nope/accept")).status).toBe(404);
    expect((await call(app, "post", "/concept-suggestions/nope/dismiss")).status).toBe(404);
  });
});
