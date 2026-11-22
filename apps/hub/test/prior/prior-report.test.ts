// ADR 105 §6 (19, 20) — buildPriorReport: match new propositions against the existing ones (lexical + `cheap` LLM) and
// classify them into known/stale/weak/new according to the effective state of the matched concept (as in mastery.ts).
import type { LlmRequest } from "@graphharness/llm";
import { describe, expect, it } from "vitest";
import { buildPriorReport } from "../../src/services/prior.ts";
import { fakeLlm, seedProposition, setNow, type LlmResponder } from "../../src/testing.ts";
import { brokenLlm, call, conceptIn, count, daysFromNow, mastery, subject, world, NOW, type Ctx } from "../knowledge/helpers.ts";

const haystack = (req: LlmRequest): string => JSON.stringify([req.system, req.messages]);

type Match = { matchedPropositionId: string | null; relation: "same" | "related" | "new" };

/**
 * Answers `prior-match` with what `table` says for each new proposition that appears in the request.
 * Those not in `table` are omitted (the service must treat them as new).
 */
const matchBy =
  (table: Record<string, Match>): LlmResponder =>
  (req) => ({
    matches: Object.entries(table)
      .filter(([pid]) => haystack(req).includes(pid))
      .map(([propositionId, m]) => ({ propositionId, ...m })),
  });

function setup(responder: LlmResponder = matchBy({})) {
  const llm = fakeLlm({ "prior-match": responder });
  const w = world({ llm });
  const s = subject(w.ctx);
  return { ...w, llm, s };
}

/** Proposition with name = statement (so the lexical overlap depends only on the chosen words). */
const prop = (ctx: Ctx, text: string, conceptId?: string, provenance?: { chatId: string; messageId: string }[]): string =>
  seedProposition(ctx.db, { name: text, statement: text, ...(conceptId ? { conceptId } : {}), ...(provenance ? { provenance } : {}) });

const priorCalls = (llm: { calls: LlmRequest[] }) => llm.calls.filter((c) => c.task === "prior-match");
const itemOf = (r: Awaited<ReturnType<typeof buildPriorReport>>, pid: string) => r.items.find((i) => i.propositionId === pid);

describe("buildPriorReport: candidates by lexical overlap", () => {
  it("no existing proposition sharing words → new and the LLM is NOT called", async () => {
    const { ctx, llm, s } = setup();
    const c = conceptIn(ctx, s, "Eigenvalues");
    prop(ctx, "eigenvalues spectrum", c);
    mastery(ctx, c, "solid");
    const n = prop(ctx, "elastic spring hooke");

    const r = await buildPriorReport(ctx, { subjectId: s, propositionIds: [n] });
    expect(llm.calls).toHaveLength(0);
    expect(r.items).toEqual([{ propositionId: n, name: "elastic spring hooke", bucket: "new", relation: "new", matchedConceptId: null, matchedConceptName: null }]);
    expect(r).toMatchObject({ subjectId: s, total: 1, counts: { known: 0, stale: 0, weak: 0, new: 1 }, percentages: { known: 0, stale: 0, weak: 0, new: 100 } });
  });

  it("the candidates offered to the LLM include the overlapping existing one and not the unrelated one", async () => {
    const { ctx, llm, s } = setup();
    const overlap = prop(ctx, "eigenvalues spectrum");
    const unrelated = prop(ctx, "elastic spring hooke");
    const n = prop(ctx, "eigenvalues symmetric real");

    await buildPriorReport(ctx, { subjectId: s, propositionIds: [n] });
    const calls = priorCalls(llm);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.tier).toBe("cheap");
    const h = haystack(calls[0]!);
    expect(h).toContain(n);
    expect(h).toContain(overlap);
    expect(h).not.toContain(unrelated);
  });

  it("at most 5 candidates per new proposition", async () => {
    const { ctx, llm, s } = setup();
    const olds = Array.from({ length: 8 }, (_, i) => prop(ctx, `eigenvalues variant${"abcdefgh"[i]}`));
    const n = prop(ctx, "eigenvalues symmetric");

    await buildPriorReport(ctx, { subjectId: s, propositionIds: [n] });
    const h = haystack(priorCalls(llm)[0]!);
    const offered = olds.filter((id) => h.includes(id));
    expect(offered.length).toBeGreaterThanOrEqual(1);
    expect(offered.length).toBeLessThanOrEqual(5);
  });

  it("the propositions of the import itself, the deleted ones and those of excluded paths are not candidates", async () => {
    const { ctx, llm, s } = setup();
    // srcId → LH path map that lh-sync stores in meta (the worker's META_LH_FILE_SOURCES key)
    ctx.db
      .prepare("INSERT INTO meta (key, value, updated_at) VALUES ('lh_file_sources', ?, ?)")
      .run(JSON.stringify({ src_topic3: "algebra/topic3.md", src_other: "algebra/other.md" }), NOW);
    const dead = prop(ctx, "eigenvalues deleted");
    ctx.db.prepare("UPDATE lh_propositions SET deleted = 1 WHERE id = ?").run(dead);
    prop(ctx, "eigenvalues previous", undefined, [{ chatId: "src_topic3", messageId: "" }]); // same file being imported
    const n1 = prop(ctx, "eigenvalues real");
    const n2 = prop(ctx, "eigenvalues complex");

    const r = await buildPriorReport(ctx, { subjectId: s, propositionIds: [n1, n2], excludeSourcePaths: ["algebra/topic3.md"] });
    expect(llm.calls).toHaveLength(0);
    expect(r.items.map((i) => i.bucket)).toEqual(["new", "new"]);
  });

  it("an existing one from ANOTHER file (not excluded) is a candidate", async () => {
    const { ctx, llm, s } = setup();
    ctx.db
      .prepare("INSERT INTO meta (key, value, updated_at) VALUES ('lh_file_sources', ?, ?)")
      .run(JSON.stringify({ src_topic3: "algebra/topic3.md", src_other: "algebra/other.md" }), NOW);
    const other = prop(ctx, "eigenvalues previous", undefined, [{ chatId: "src_other", messageId: "" }]);
    const n = prop(ctx, "eigenvalues real", undefined, [{ chatId: "src_topic3", messageId: "" }]);

    await buildPriorReport(ctx, { subjectId: s, propositionIds: [n], excludeSourcePaths: ["algebra/topic3.md"] });
    expect(priorCalls(llm)).toHaveLength(1);
    expect(haystack(priorCalls(llm)[0]!)).toContain(other);
  });
});

describe("buildPriorReport: buckets according to the matched proposition's concept", () => {
  // priorBucket with state = EFFECTIVE state (with decay, as in mastery.ts) and rawState = deriveState of
  // concept_state.probability WITHOUT decay: effective solid → known; was solid and no longer → stale; review|weak → weak;
  // unknown or without a concept → new.
  function seeded() {
    const ids: Record<string, string> = {};
    const t = setup((req) => matchBy(table())(req));
    const { ctx, s } = t;
    const cSolid = conceptIn(ctx, s, "Eigenvalues");
    const cOld = conceptIn(ctx, s, "Determinants");
    const cWeak = conceptIn(ctx, s, "Kernel");
    const cUnknown = conceptIn(ctx, s, "Rank");
    mastery(ctx, cSolid, "solid"); // fresh: P 0.95 → solid effective and stored
    mastery(ctx, cOld, "solid", daysFromNow(-200)); // concept_state P 0.95 with updated_at 200 days ago: stored solid, effective weak
    mastery(ctx, cWeak, "weak"); // just missed: P 0.30 → weak stored and effective
    ids.eSolid = prop(ctx, "eigenvalues spectrum", cSolid);
    ids.eOld = prop(ctx, "determinant cofactors", cOld);
    ids.eWeak = prop(ctx, "kernel application", cWeak);
    ids.eUnknown = prop(ctx, "rank columns", cUnknown);
    ids.eOrphan = prop(ctx, "trace diagonal"); // synced but without a concept
    ids.nKnown = prop(ctx, "eigenvalues real");
    ids.nRelated = prop(ctx, "spectrum operator");
    ids.nOld = prop(ctx, "determinant laplace");
    ids.nWeak = prop(ctx, "kernel dimension");
    ids.nUnknown = prop(ctx, "rank rows");
    ids.nOrphan = prop(ctx, "trace summation");
    const table = (): Record<string, Match> => ({
      [ids.nKnown!]: { matchedPropositionId: ids.eSolid!, relation: "same" },
      [ids.nRelated!]: { matchedPropositionId: ids.eSolid!, relation: "related" },
      [ids.nOld!]: { matchedPropositionId: ids.eOld!, relation: "same" },
      [ids.nWeak!]: { matchedPropositionId: ids.eWeak!, relation: "same" },
      [ids.nUnknown!]: { matchedPropositionId: ids.eUnknown!, relation: "same" },
      [ids.nOrphan!]: { matchedPropositionId: ids.eOrphan!, relation: "same" },
    });
    const news = ["nKnown", "nRelated", "nOld", "nWeak", "nUnknown", "nOrphan"].map((k) => ids[k]!);
    return { ...t, ids, news, cSolid, cOld, cWeak, cUnknown };
  }

  it("fresh solid → known (same and related); was solid 200 days ago → stale; just-missed weak → weak; unknown → new; without a concept → new", async () => {
    const { ctx, s, ids, news, cSolid, cOld, cWeak, cUnknown } = seeded();
    // the seed of the stale case: stored P high and last evidence 200 days ago
    expect(ctx.db.prepare("SELECT probability, updated_at FROM concept_state WHERE concept_id = ?").get(cOld)).toMatchObject({
      probability: expect.closeTo(0.95, 2),
      updated_at: daysFromNow(-200),
    });
    const r = await buildPriorReport(ctx, { subjectId: s, propositionIds: news });

    expect(r.items.map((i) => i.propositionId).sort()).toEqual([...news].sort());
    expect(itemOf(r, ids.nKnown!)).toEqual({ propositionId: ids.nKnown, name: "eigenvalues real", bucket: "known", relation: "same", matchedConceptId: cSolid, matchedConceptName: "Eigenvalues" });
    expect(itemOf(r, ids.nRelated!)).toMatchObject({ bucket: "known", relation: "related", matchedConceptId: cSolid });
    expect(itemOf(r, ids.nWeak!)).toMatchObject({ bucket: "weak", relation: "same", matchedConceptId: cWeak, matchedConceptName: "Kernel" });
    expect(itemOf(r, ids.nOld!)).toMatchObject({ bucket: "stale", relation: "same", matchedConceptId: cOld, matchedConceptName: "Determinants" });
    expect(itemOf(r, ids.nUnknown!)).toMatchObject({ bucket: "new", relation: "same", matchedConceptId: cUnknown });
    expect(itemOf(r, ids.nOrphan!)).toMatchObject({ bucket: "new", matchedConceptId: null, matchedConceptName: null });
  });

  it("totals and integer percentages that add up to 100 (2/6, 1/6, 1/6, 2/6 → 33, 17, 17, 33)", async () => {
    const { ctx, s, news } = seeded();
    const r = await buildPriorReport(ctx, { subjectId: s, propositionIds: news });
    expect(r.total).toBe(6);
    expect(r.counts).toEqual({ known: 2, stale: 1, weak: 1, new: 2 });
    expect(r.percentages).toEqual({ known: 33, stale: 17, weak: 17, new: 33 });
  });

  it("the state is read with the current clock: the same match 400 days later goes from known to stale", async () => {
    const { ctx, s, ids } = seeded();
    setNow(ctx, daysFromNow(400));
    const r = await buildPriorReport(ctx, { subjectId: s, propositionIds: [ids.nKnown!] });
    expect(itemOf(r, ids.nKnown!)).toMatchObject({ bucket: "stale" });
  });

  it("candidates may belong to ANOTHER subject (the matched concept is not limited to the report's)", async () => {
    const { ctx, s } = setup();
    const other = subject(ctx, "Physics");
    const c = conceptIn(ctx, other, "Oscillations");
    mastery(ctx, c, "solid");
    const e = prop(ctx, "harmonic oscillator", c);
    const n = prop(ctx, "damped oscillator");
    // the responder is set now that we know the ids
    const llm = fakeLlm({ "prior-match": matchBy({ [n]: { matchedPropositionId: e, relation: "related" } }) });
    const r = await buildPriorReport({ ...ctx, llm }, { subjectId: s, propositionIds: [n] });
    expect(itemOf(r, n)).toMatchObject({ bucket: "known", relation: "related", matchedConceptId: c, matchedConceptName: "Oscillations" });
  });
});

describe("buildPriorReport: code validation of the LLM's output", () => {
  function pair() {
    let table: Record<string, Match> = {};
    const t = setup((req) => matchBy(table)(req));
    const c = conceptIn(t.ctx, t.s, "Eigenvalues");
    mastery(t.ctx, c, "solid");
    const eA = prop(t.ctx, "eigenvalues spectrum", c);
    const eB = prop(t.ctx, "determinant cofactors", c);
    const nA = prop(t.ctx, "eigenvalues real");
    const nB = prop(t.ctx, "determinant laplace");
    return { ...t, c, eA, eB, nA, nB, set: (x: Record<string, Match>) => (table = x) };
  }

  it("an invented matchedPropositionId → new", async () => {
    const { ctx, s, nA, set } = pair();
    set({ [nA]: { matchedPropositionId: "n_invented000", relation: "same" } });
    const r = await buildPriorReport(ctx, { subjectId: s, propositionIds: [nA] });
    expect(itemOf(r, nA)).toMatchObject({ bucket: "new", relation: "new", matchedConceptId: null });
  });

  it("a matchedPropositionId that exists but was NOT offered for that proposition → new", async () => {
    const { ctx, s, nA, nB, eB, c, set } = pair();
    // eB is only a candidate of nB (they share "determinant"); it was not offered for nA
    set({ [nA]: { matchedPropositionId: eB, relation: "same" }, [nB]: { matchedPropositionId: eB, relation: "same" } });
    const r = await buildPriorReport(ctx, { subjectId: s, propositionIds: [nA, nB] });
    expect(itemOf(r, nA)).toMatchObject({ bucket: "new", relation: "new", matchedConceptId: null });
    expect(itemOf(r, nB)).toMatchObject({ bucket: "known", relation: "same", matchedConceptId: c });
  });

  it("relation 'new' with a valid matchedPropositionId → the match is ignored", async () => {
    const { ctx, s, nA, eA, set } = pair();
    set({ [nA]: { matchedPropositionId: eA, relation: "new" } });
    const r = await buildPriorReport(ctx, { subjectId: s, propositionIds: [nA] });
    expect(itemOf(r, nA)).toMatchObject({ bucket: "new", relation: "new", matchedConceptId: null, matchedConceptName: null });
  });

  it("a proposition the LLM omits → new (and the others carry on)", async () => {
    const { ctx, s, nA, nB, eB, c, set } = pair();
    set({ [nB]: { matchedPropositionId: eB, relation: "same" } });
    const r = await buildPriorReport(ctx, { subjectId: s, propositionIds: [nA, nB] });
    expect(itemOf(r, nA)).toMatchObject({ bucket: "new", relation: "new", matchedConceptId: null });
    expect(itemOf(r, nB)).toMatchObject({ bucket: "known", matchedConceptId: c });
  });
});

describe("buildPriorReport: batches, persistence and failures", () => {
  it("more than 40 propositions with candidates → batches of at most 40 (41 = 2 calls)", async () => {
    let existing = "";
    const { ctx, llm, s } = setup((req) => {
      const ids = [...new Set(haystack(req).match(/n_[0-9a-z]{12}/g) ?? [])].filter((id) => id !== existing);
      return { matches: ids.map((propositionId) => ({ propositionId, matchedPropositionId: existing, relation: "same" as const })) };
    });
    const c = conceptIn(ctx, s, "Eigenvalues");
    mastery(ctx, c, "solid");
    existing = prop(ctx, "eigenvalues spectrum", c);
    const news = Array.from({ length: 41 }, (_, i) => prop(ctx, `eigenvalues case${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`));

    const r = await buildPriorReport(ctx, { subjectId: s, propositionIds: news });
    const calls = priorCalls(llm);
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(news.filter((id) => haystack(call).includes(id)).length).toBeLessThanOrEqual(40);
    expect(r.total).toBe(41);
    expect(r.counts.known).toBe(41);
  });

  it("saves the report in prior_reports and it is retrieved identically through GET /prior-reports/:id", async () => {
    const { ctx, app, s } = setup();
    const n = prop(ctx, "elastic spring hooke");
    const r = await buildPriorReport(ctx, { subjectId: s, propositionIds: [n], excludeSourcePaths: ["algebra/topic3.md"] });
    expect(r.createdAt).toBe(NOW);
    expect(ctx.db.prepare("SELECT subject_id FROM prior_reports WHERE id = ?").pluck().get(r.id)).toBe(s);
    const got = await call(app, "get", `/prior-reports/${r.id}`);
    expect(got.status).toBe(200);
    expect(got.json).toEqual(r);
  });

  it("without propositions → report with total 0 and percentages 0 (no NaN), without calling the LLM", async () => {
    const { ctx, llm, s } = setup();
    const r = await buildPriorReport(ctx, { subjectId: s, propositionIds: [] });
    expect(llm.calls).toHaveLength(0);
    expect(r).toMatchObject({ total: 0, items: [], counts: { known: 0, stale: 0, weak: 0, new: 0 }, percentages: { known: 0, stale: 0, weak: 0, new: 0 } });
  });

  it("if the LLM fails, the error propagates (the runner retries) and no report is saved", async () => {
    const w = world({ llm: brokenLlm() });
    const s = subject(w.ctx);
    prop(w.ctx, "eigenvalues spectrum");
    const n = prop(w.ctx, "eigenvalues real");
    await expect(buildPriorReport(w.ctx, { subjectId: s, propositionIds: [n] })).rejects.toThrow(/LLM unavailable/);
    expect(count(w.ctx.db, "SELECT count(*) FROM prior_reports")).toBe(0);
  });
});
