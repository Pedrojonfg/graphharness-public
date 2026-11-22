// LH agent tools over the Hub (ADR 105 §5, points 15–16): GET /errors (hub_errors),
// GET /profile (hub_profile) and POST /capture (hub_capture). No auth, like /mastery (ADR 104).
import { ulid } from "@graphharness/core";
import type { Db } from "@graphharness/db";
import type { LlmRequest } from "@graphharness/llm";
import { describe, expect, it } from "vitest";
import {
  NOW,
  autoLlm,
  brokenLlm,
  call,
  conceptIn,
  count,
  daysFromNow,
  insertTemplate,
  insertTemplateError,
  subject,
  world,
} from "./helpers.ts";

// ---------------------------------------------------------------- local seeds

/** Typical error with an explicit origin (the shared helper only seeds 'recipe'). */
function templateError(db: Db, templateId: string, key: string, o: { origin?: "recipe" | "personal"; timesSeen?: number; description?: string } = {}): string {
  const id = ulid();
  const timesSeen = o.timesSeen ?? 0;
  db.prepare(
    "INSERT INTO template_errors (id, template_id, key, description, expr, origin, times_seen, last_seen_at) VALUES (?, ?, ?, ?, '0', ?, ?, ?)",
  ).run(id, templateId, key, o.description ?? `Description of ${key}`, o.origin ?? "recipe", timesSeen, timesSeen > 0 ? NOW : null);
  return id;
}

let refSeq = 0;
/** Evidence event via SQL (miss_class comes from migration 003; recordEvidence does not write it yet). */
function evidence(
  db: Db,
  o: { conceptId: string; at?: string; source?: string; correct?: boolean; confidence?: number | null; missClass?: string | null },
): void {
  db.prepare(
    `INSERT INTO evidence_events (id, concept_id, at, source, correct, response_format, inferred, weight, confidence, ref_json, ingested_at, miss_class)
     VALUES (?, ?, ?, ?, ?, 'open', 0, 1, ?, ?, ?, ?)`,
  ).run(
    ulid(),
    o.conceptId,
    o.at ?? NOW,
    o.source ?? "lh_practice",
    o.correct === false ? 0 : 1,
    o.confidence ?? null,
    JSON.stringify({ chatId: "c_seed", toolCallId: `t${++refSeq}` }),
    NOW,
    o.missClass ?? null,
  );
}

/** LLM whose resolve_concepts rerank returns these scores (by concept name → id resolved on the spot). */
function rerankLlm(scores: () => { conceptId: string; score: number }[]) {
  return autoLlm({ "resolve-rerank": (_req: LlmRequest) => ({ scores: scores() }) });
}

// ---------------------------------------------------------------- GET /errors

describe("GET /errors", () => {
  it("sorts personal first, then timesSeen desc and then errorKey; brings concept, template and lastSeenAt", async () => {
    const { ctx, app } = world();
    const c = conceptIn(ctx, subject(ctx), "Eigenvalues");
    const t = insertTemplate(ctx.db, c);
    templateError(ctx.db, t, "b_signo", { timesSeen: 5 });
    templateError(ctx.db, t, "a_traza", { timesSeen: 5 });
    templateError(ctx.db, t, "z_nunca", { timesSeen: 0 });
    templateError(ctx.db, t, "y_propio", { origin: "personal", timesSeen: 1, description: "Forgets the characteristic polynomial" });

    const r = await call(app, "get", `/errors?conceptIds=${c}`);
    expect(r.status).toBe(200);
    expect(r.json.errors.map((e: { errorKey: string }) => e.errorKey)).toEqual(["y_propio", "a_traza", "b_signo", "z_nunca"]);
    expect(r.json.errors[0]).toEqual({
      conceptId: c,
      conceptName: "Eigenvalues",
      templateId: t,
      errorKey: "y_propio",
      description: "Forgets the characteristic polynomial",
      origin: "personal",
      timesSeen: 1,
      lastSeenAt: NOW,
    });
    expect(r.json.errors[3]).toMatchObject({ errorKey: "z_nunca", origin: "recipe", timesSeen: 0, lastSeenAt: null });
  });

  it("default limit 10; an explicit limit trims", async () => {
    const { ctx, app } = world();
    const c = conceptIn(ctx, subject(ctx), "Rank");
    const t = insertTemplate(ctx.db, c);
    for (let i = 0; i < 12; i++) insertTemplateError(ctx.db, t, `err_${String(i).padStart(2, "0")}`, `Error ${i}`, i);

    const def = await call(app, "get", `/errors?conceptIds=${c}`);
    expect(def.status).toBe(200);
    expect(def.json.errors).toHaveLength(10);
    expect(def.json.errors[0]).toMatchObject({ errorKey: "err_11", timesSeen: 11 });

    const three = await call(app, "get", `/errors?conceptIds=${c}&limit=3`);
    expect(three.json.errors.map((e: { errorKey: string }) => e.errorKey)).toEqual(["err_11", "err_10", "err_09"]);
  });

  it("several conceptIds combine their errors; those of other concepts do not appear", async () => {
    const { ctx, app } = world();
    const s = subject(ctx);
    const a = conceptIn(ctx, s, "A");
    const b = conceptIn(ctx, s, "B");
    const other = conceptIn(ctx, s, "Other");
    insertTemplateError(ctx.db, insertTemplate(ctx.db, a), "de_a", "x", 3);
    insertTemplateError(ctx.db, insertTemplate(ctx.db, b), "de_b", "x", 2);
    insertTemplateError(ctx.db, insertTemplate(ctx.db, other), "from_other", "x", 9);

    const r = await call(app, "get", `/errors?conceptIds=${a},${b}`);
    expect(r.status).toBe(200);
    expect(r.json.errors.map((e: { errorKey: string; conceptName: string }) => [e.errorKey, e.conceptName])).toEqual([
      ["de_a", "A"],
      ["de_b", "B"],
    ]);
  });

  it("query resolves concepts by text (FTS, as in /mastery)", async () => {
    const { ctx, app } = world();
    const s = subject(ctx);
    const spectral = conceptIn(ctx, s, "Spectral theorem", ["Every real symmetric matrix is diagonalizable"]);
    const other = conceptIn(ctx, s, "Double integrals");
    insertTemplateError(ctx.db, insertTemplate(ctx.db, spectral), "forgets_symmetry", "Does not check the symmetry", 2);
    insertTemplateError(ctx.db, insertTemplate(ctx.db, other), "fubini", "Swaps the order without justification", 4);

    const r = await call(app, "get", "/errors?query=spectral");
    expect(r.status).toBe(200);
    expect(r.json.errors).toHaveLength(1);
    expect(r.json.errors[0]).toMatchObject({ conceptId: spectral, errorKey: "forgets_symmetry", description: "Does not check the symmetry" });
  });

  it("without conceptIds or query → 400 invalid_request", async () => {
    const { app } = world();
    const r = await call(app, "get", "/errors");
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ error: "invalid_request" });
  });

  it("excludes non-active templates and merged or retired concepts", async () => {
    const { ctx, app } = world();
    const s = subject(ctx);
    const live = conceptIn(ctx, s, "Live");
    const merged = conceptIn(ctx, s, "Merged");
    const retired = conceptIn(ctx, s, "Retired");
    insertTemplateError(ctx.db, insertTemplate(ctx.db, live), "active_one", "x", 1);
    insertTemplateError(ctx.db, insertTemplate(ctx.db, live, { status: "failed" }), "plantilla_fallida", "x", 9);
    insertTemplateError(ctx.db, insertTemplate(ctx.db, live, { status: "retired" }), "plantilla_retirada", "x", 9);
    insertTemplateError(ctx.db, insertTemplate(ctx.db, merged), "de_fusionado", "x", 9);
    insertTemplateError(ctx.db, insertTemplate(ctx.db, retired), "de_retirado", "x", 9);
    ctx.db.prepare("UPDATE concepts SET status = 'merged', merged_into = ? WHERE id = ?").run(live, merged);
    ctx.db.prepare("UPDATE concepts SET status = 'retired' WHERE id = ?").run(retired);

    const r = await call(app, "get", `/errors?conceptIds=${live},${merged},${retired}`);
    expect(r.status).toBe(200);
    expect(r.json.errors.map((e: { errorKey: string }) => e.errorKey)).toEqual(["active_one"]);
  });
});

// ---------------------------------------------------------------- GET /profile

describe("GET /profile", () => {
  it("Empty Hub: no recurring errors, the five missClass at 0 and no calibration", async () => {
    const { app } = world();
    const r = await call(app, "get", "/profile");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      recurringErrors: [],
      missClassCounts: { cue: 0, discrimination: 0, execution: 0, careless: 0, structural: 0 },
      calibration: [],
    });
  });

  it("recurringErrors: at most 5, only timesSeen ≥ 2, from most to least seen; no inactive templates", async () => {
    const { ctx, app } = world();
    const c = conceptIn(ctx, subject(ctx), "Eigenvalues");
    const t = insertTemplate(ctx.db, c);
    for (const [key, n] of [["e1", 1], ["e2", 2], ["e3", 3], ["e4", 4], ["e5", 5], ["e6", 6], ["e7", 7]] as const) insertTemplateError(ctx.db, t, key, `Error ${key}`, n);
    insertTemplateError(ctx.db, insertTemplate(ctx.db, c, { status: "retired" }), "old", "x", 50);

    const r = await call(app, "get", "/profile");
    expect(r.status).toBe(200);
    expect(r.json.recurringErrors.map((e: { errorKey: string }) => e.errorKey)).toEqual(["e7", "e6", "e5", "e4", "e3"]);
    expect(r.json.recurringErrors[0]).toMatchObject({ conceptId: c, conceptName: "Eigenvalues", templateId: t, timesSeen: 7, origin: "recipe" });
  });

  it("missClassCounts: only lh_practice events with miss_class from the last 90 days", async () => {
    const { ctx, app } = world();
    const c = conceptIn(ctx, subject(ctx), "Rank");
    evidence(ctx.db, { conceptId: c, correct: false, missClass: "cue" });
    evidence(ctx.db, { conceptId: c, correct: false, missClass: "cue", at: daysFromNow(-89) });
    evidence(ctx.db, { conceptId: c, correct: false, missClass: "execution" });
    evidence(ctx.db, { conceptId: c, correct: false, missClass: "structural", at: daysFromNow(-91) }); // outside the window
    evidence(ctx.db, { conceptId: c, correct: false, missClass: "careless", source: "lh_quiz" }); // not a practice event
    evidence(ctx.db, { conceptId: c, correct: false, missClass: null }); // no class

    const r = await call(app, "get", "/profile");
    expect(r.status).toBe(200);
    expect(r.json.missClassCounts).toEqual({ cue: 2, discrimination: 0, execution: 1, careless: 0, structural: 0 });
  });

  it("per-subject calibration: mean confidence (1 decimal), hit rate (3 decimals) and inclusive 75/25 thresholds", async () => {
    const { ctx, app } = world();
    const alg = subject(ctx, "Linear Algebra");
    const calc = subject(ctx, "Calculus");
    subject(ctx, "History"); // no events: does not appear
    const a = conceptIn(ctx, alg, "Eigenvalues");
    const k = conceptIn(ctx, calc, "Limits");
    // Algebra: 6 events with confidence; 3 hits out of 6.
    evidence(ctx.db, { conceptId: a, correct: false, confidence: 75 }); // overconfidentWrong (exact limit)
    evidence(ctx.db, { conceptId: a, correct: false, confidence: 74 }); // does not count
    evidence(ctx.db, { conceptId: a, correct: true, confidence: 25 }); // underconfidentRight (exact limit)
    evidence(ctx.db, { conceptId: a, correct: true, confidence: 26 }); // does not count
    evidence(ctx.db, { conceptId: a, correct: true, confidence: 100, source: "lh_quiz" }); // any source with confidence
    evidence(ctx.db, { conceptId: a, correct: false, confidence: 0 });
    evidence(ctx.db, { conceptId: a, correct: true, confidence: null }); // no confidence: excluded
    evidence(ctx.db, { conceptId: a, correct: false, confidence: 99, at: daysFromNow(-91) }); // outside the window
    // Calculus: 1 out of 3.
    evidence(ctx.db, { conceptId: k, correct: true, confidence: 50, at: daysFromNow(-89) });
    evidence(ctx.db, { conceptId: k, correct: false, confidence: 50 });
    evidence(ctx.db, { conceptId: k, correct: false, confidence: 51 });

    const r = await call(app, "get", "/profile");
    expect(r.status).toBe(200);
    const bySubject = Object.fromEntries(r.json.calibration.map((x: { subjectId: string }) => [x.subjectId, x]));
    expect(Object.keys(bySubject).sort()).toEqual([alg, calc].sort());
    // (75+74+25+26+100+0)/6 = 50
    expect(bySubject[alg]).toEqual({
      subjectId: alg,
      subjectName: "Linear Algebra",
      n: 6,
      meanConfidence: 50,
      accuracy: 0.5,
      overconfidentWrong: 1,
      underconfidentRight: 1,
    });
    // (50+50+51)/3 = 50.333… → 50.3; 1/3 → 0.333
    expect(bySubject[calc]).toEqual({
      subjectId: calc,
      subjectName: "Calculus",
      n: 3,
      meanConfidence: 50.3,
      accuracy: 0.333,
      overconfidentWrong: 0,
      underconfidentRight: 0,
    });
  });
});

// ---------------------------------------------------------------- POST /capture

describe("POST /capture", () => {
  it("note by conceptId → 201 with id, concept and name; ends up in notes", async () => {
    const { ctx, app } = world();
    const c = conceptIn(ctx, subject(ctx), "Eigenvalues");
    const r = await call(app, "post", "/capture", { kind: "note", conceptId: c, text: "Review the geometric multiplicity." });
    expect(r.status).toBe(201);
    expect(r.json).toEqual({ kind: "note", id: expect.any(String), conceptId: c, conceptName: "Eigenvalues" });
    const row = ctx.db.prepare("SELECT concept_id, text FROM notes WHERE id = ?").get(r.json.id);
    expect(row).toEqual({ concept_id: c, text: "Review the geometric multiplicity." });
  });

  it("note by conceptQuery: the best candidate with score ≥ 0.6 and no tie", async () => {
    let ids: string[] = [];
    const { ctx, app } = world({ llm: rerankLlm(() => [{ conceptId: ids[0]!, score: 0.9 }, { conceptId: ids[1]!, score: 0.6 }]) });
    const s = subject(ctx);
    ids = [conceptIn(ctx, s, "Eigenvalues of a matrix"), conceptIn(ctx, s, "Generalized eigenvalues")];
    const r = await call(app, "post", "/capture", { kind: "note", conceptQuery: "eigenvalues", text: "Watch out for the trace." });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ kind: "note", conceptId: ids[0], conceptName: "Eigenvalues of a matrix" });
    expect(count(ctx.db, "SELECT count(*) FROM notes WHERE concept_id = ?", ids[0])).toBe(1);
  });

  it("cloze card → 201; saved as a new review card with a first interval of 1 day without an exam", async () => {
    const { ctx, app } = world();
    const c = conceptIn(ctx, subject(ctx), "Rank");
    const r = await call(app, "post", "/capture", { kind: "card", conceptId: c, type: "cloze", front: "The rank of $I_n$ is {{c1}}.", answer: "$n$" });
    expect(r.status).toBe(201);
    expect(r.json).toEqual({ kind: "card", id: expect.any(String), conceptId: c, conceptName: "Rank" });
    const row = ctx.db
      .prepare("SELECT concept_id, kind, purpose, front_text, answer_json, interval_days, repetitions, reviewed, retired, t_ref FROM cards WHERE id = ?")
      .get(r.json.id) as Record<string, unknown>;
    expect(row).toMatchObject({ concept_id: c, kind: "cloze", purpose: "review", front_text: "The rank of $I_n$ is {{c1}}.", interval_days: 1, repetitions: 0, reviewed: 0, retired: 0, t_ref: Date.parse(NOW) });
    expect(JSON.parse(row.answer_json as string)).toMatchObject({ text: "$n$" });
  });

  it("text card: the first interval comes from the subject's nearest exam, as in generation", async () => {
    const { ctx, app } = world();
    const s = subject(ctx);
    const c = conceptIn(ctx, s, "Rank");
    // NOW = 2026-11-10; exam in 20 days → floor(20/4) = 5 days
    ctx.db.prepare("INSERT INTO exams (id, subject_id, title, date, created_at) VALUES (?, ?, 'Midterm', '2026-11-30', ?)").run(ulid(), s, NOW);
    const r = await call(app, "post", "/capture", { kind: "card", conceptId: c, type: "text", front: "Rank of the identity of order 3?", answer: "3" });
    expect(r.status).toBe(201);
    expect(ctx.db.prepare("SELECT kind, interval_days FROM cards WHERE id = ?").get(r.json.id)).toEqual({ kind: "text", interval_days: 5 });
  });

  it("ambiguous conceptQuery → 409 ambiguous_concept with candidates; nothing written", async () => {
    let ids: string[] = [];
    const { ctx, app } = world({ llm: rerankLlm(() => [{ conceptId: ids[0]!, score: 0.55 }, { conceptId: ids[1]!, score: 0.4 }]) });
    const s = subject(ctx);
    ids = [conceptIn(ctx, s, "Eigenvalues of a matrix"), conceptIn(ctx, s, "Generalized eigenvalues")];
    const r = await call(app, "post", "/capture", { kind: "note", conceptQuery: "eigenvalues", text: "x" });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("ambiguous_concept");
    expect(r.json.candidates).toEqual([
      { conceptId: ids[0], name: "Eigenvalues of a matrix", score: 0.55 },
      { conceptId: ids[1], name: "Generalized eigenvalues", score: 0.4 },
    ]);
    expect(count(ctx.db, "SELECT count(*) FROM notes")).toBe(0);
  });

  it("tie on the best score (even if ≥ 0.6) → 409", async () => {
    let ids: string[] = [];
    const { ctx, app } = world({ llm: rerankLlm(() => [{ conceptId: ids[0]!, score: 0.8 }, { conceptId: ids[1]!, score: 0.8 }]) });
    const s = subject(ctx);
    ids = [conceptIn(ctx, s, "Eigenvalues of a matrix"), conceptIn(ctx, s, "Generalized eigenvalues")];
    const r = await call(app, "post", "/capture", { kind: "card", conceptQuery: "eigenvalues", type: "text", front: "?", answer: "x" });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("ambiguous_concept");
    expect(r.json.candidates.map((x: { conceptId: string }) => x.conceptId).sort()).toEqual([...ids].sort());
    expect(count(ctx.db, "SELECT count(*) FROM cards")).toBe(0);
  });

  it("if the rerank fails (FTS scores < 0.6) it is also ambiguous, never guessed", async () => {
    const { ctx, app } = world({ llm: brokenLlm() });
    const c = conceptIn(ctx, subject(ctx), "Spectral theorem");
    const r = await call(app, "post", "/capture", { kind: "note", conceptQuery: "spectral", text: "x" });
    expect(r.status).toBe(409);
    expect(r.json.candidates).toEqual([expect.objectContaining({ conceptId: c, name: "Spectral theorem" })]);
  });

  it("conceptQuery without candidates → 404 not_found (and the route exists: the same body with conceptId works)", async () => {
    const { ctx, app } = world();
    const c = conceptIn(ctx, subject(ctx), "Rank");
    expect((await call(app, "post", "/capture", { kind: "note", conceptId: c, text: "x" })).status).toBe(201);
    const r = await call(app, "post", "/capture", { kind: "note", conceptQuery: "zzzzqqqq", text: "x" });
    expect(r.status).toBe(404);
    expect(r.json).toMatchObject({ error: "not_found" });
    expect(count(ctx.db, "SELECT count(*) FROM notes")).toBe(1);
  });

  it("validates the card like generation: answer ≤ 60, non-empty, `$` in pairs; 400 invalid_request without writing", async () => {
    const { ctx, app } = world();
    const c = conceptIn(ctx, subject(ctx), "Rank");
    const card = (over: object) => ({ kind: "card", conceptId: c, type: "cloze", front: "The rank is {{c1}}.", answer: "n", ...over });

    expect((await call(app, "post", "/capture", card({ answer: "a".repeat(60) }))).status).toBe(201); // exact limit
    const rejected = [
      card({ answer: "a".repeat(61) }),
      card({ answer: "   " }),
      card({ answer: "$n" }),
      card({ front: "The rank of $I_n is {{c1}}." }),
      card({ type: "text", answer: "a".repeat(61) }),
    ];
    for (const body of rejected) {
      const r = await call(app, "post", "/capture", body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.json).toMatchObject({ error: "invalid_request" });
    }
    expect(count(ctx.db, "SELECT count(*) FROM cards")).toBe(1);
  });

  it("note: text of 1 to 2000 characters", async () => {
    const { ctx, app } = world();
    const c = conceptIn(ctx, subject(ctx), "Rank");
    expect((await call(app, "post", "/capture", { kind: "note", conceptId: c, text: "a".repeat(2000) })).status).toBe(201);
    for (const text of ["a".repeat(2001), ""]) {
      const r = await call(app, "post", "/capture", { kind: "note", conceptId: c, text });
      expect(r.status).toBe(400);
      expect(r.json).toMatchObject({ error: "invalid_request" });
    }
    expect(count(ctx.db, "SELECT count(*) FROM notes")).toBe(1);
  });

  it("exactly one of conceptId / conceptQuery, and only kind note|card and type cloze|text → otherwise, 400", async () => {
    const { ctx, app } = world();
    const c = conceptIn(ctx, subject(ctx), "Rank");
    const bodies = [
      { kind: "note", text: "x" },
      { kind: "note", conceptId: c, conceptQuery: "rank", text: "x" },
      { kind: "card", conceptId: c, type: "mcq", front: "?", answer: "x" },
      { kind: "flashcard", conceptId: c, text: "x" },
    ];
    for (const body of bodies) {
      const r = await call(app, "post", "/capture", body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.json).toMatchObject({ error: "invalid_request" });
    }
    expect(count(ctx.db, "SELECT count(*) FROM notes") + count(ctx.db, "SELECT count(*) FROM cards")).toBe(0);
  });
});
