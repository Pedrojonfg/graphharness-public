import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ContractError, HubError, NetworkError } from "./api.ts";
import { cardText, queue, fakeFetch, priorReport, priorReports, plan, syllabus } from "./fixtures.ts";

afterEach(() => vi.unstubAllGlobals());

describe("API client", () => {
  it("validates the response with contracts and returns it typed", async () => {
    const f = fakeFetch(() => [200, queue([cardText()])]);
    vi.stubGlobal("fetch", f.fn);
    const q = await api.cardQueue(20, 10);
    expect(q.cards[0]!.id).toBe("c_text");
    expect(f.calls[0]).toMatchObject({ method: "GET", url: "/api/v1/cards/queue?offset=20&limit=10" });
  });

  it("rejects with ContractError a response that breaks the contract (e.g. a leaked solution)", async () => {
    const q = queue([cardText()]);
    const withSolution = { ...q, cards: [{ ...q.cards[0], front: { text: null, instance: { ...instance, answer: "3" } } }] };
    vi.stubGlobal("fetch", fakeFetch(() => [200, withSolution]).fn);
    await expect(api.cardQueue(0)).rejects.toBeInstanceOf(ContractError);
  });

  it("propagates the 409 weak_prerequisites with its prerequisites", async () => {
    const weak = [{ conceptId: "k0", name: "Determinants", state: "weak", path: ["k0", "k1"] }];
    vi.stubGlobal("fetch", fakeFetch(() => [409, { error: "weak_prerequisites", weakPrerequisites: weak }]).fn);
    const e = await api.setConceptState("k1", { targetState: "solid", justification: "saw it in class" }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(HubError);
    expect((e as HubError).status).toBe(409);
    expect((e as HubError).code).toBe("weak_prerequisites");
    expect((e as HubError).weakPrerequisites).toEqual(weak);
  });

  it("takes the LH 503 code from `code` (LH envelope as is)", async () => {
    vi.stubGlobal("fetch", fakeFetch(() => [503, { error: "Configure a model", code: "models_not_configured", missing: ["chat"] }]).fn);
    const e = await api.startSession({ subjectId: "s1", goal: "Diagonalize", kind: "teaching" }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(HubError);
    expect((e as HubError).code).toBe("models_not_configured");
  });

  it("validates the body before sending: an invalid one never reaches the network", async () => {
    const f = fakeFetch(() => [200, {}]);
    vi.stubGlobal("fetch", f.fn);
    await expect(api.setConceptState("k1", { targetState: "solid", justification: "  " })).rejects.toBeInstanceOf(ContractError);
    expect(f.calls).toHaveLength(0);
  });

  it("turns a network failure into NetworkError", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("Failed to fetch")));
    await expect(api.health()).rejects.toBeInstanceOf(NetworkError);
  });
});

describe("API client: plan, prior knowledge and syllabus (ADR 105 §6 and §7)", () => {
  it("plan: GET /plan with optional `days` and validated response", async () => {
    const f = fakeFetch(() => [200, plan()]);
    vi.stubGlobal("fetch", f.fn);
    const p = await api.plan(10);
    expect(p.days.map((d) => d.date)).toEqual(["2026-11-09", "2026-11-10", "2026-11-11"]);
    expect(p.unscheduledCount).toBe(3);
    await api.plan();
    expect(f.calls.map((c) => [c.method, c.url])).toEqual([
      ["GET", "/api/v1/plan?days=10"],
      ["GET", "/api/v1/plan"],
    ]);
  });

  it("priorReports: GET /prior-reports, filtering by subject if requested", async () => {
    const f = fakeFetch(() => [200, priorReports()]);
    vi.stubGlobal("fetch", f.fn);
    const r = await api.priorReports("s1");
    expect(r.reports.map((x) => x.id)).toEqual(["p1", "p2"]);
    await api.priorReports();
    expect(f.calls.map((c) => [c.method, c.url])).toEqual([
      ["GET", "/api/v1/prior-reports?subjectId=s1"],
      ["GET", "/api/v1/prior-reports"],
    ]);
  });

  it("priorReport: GET /prior-reports/:id with its propositions; the 404 arrives as HubError", async () => {
    const f = fakeFetch((_, url) => (url.endsWith("/p1") ? [200, priorReport()] : [404, { error: "not_found" }]));
    vi.stubGlobal("fetch", f.fn);
    const r = await api.priorReport("p1");
    expect(r.items.map((i) => i.bucket)).toEqual(["known", "known", "known", "stale", "new"]);
    expect(f.calls[0]).toMatchObject({ method: "GET", url: "/api/v1/prior-reports/p1" });
    const e = await api.priorReport("missing").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(HubError);
    expect((e as HubError).status).toBe(404);
  });

  it("syllabus: GET /syllabus/:subjectId", async () => {
    const f = fakeFetch(() => [200, syllabus()]);
    vi.stubGlobal("fetch", f.fn);
    const t = await api.syllabus("s1");
    expect(t.items.filter((i) => i.seen)).toHaveLength(2);
    expect(f.calls[0]).toMatchObject({ method: "GET", url: "/api/v1/syllabus/s1" });
  });

  it("putSyllabus: PUT /syllabus/:subjectId with {text} and returns count and errors", async () => {
    const f = fakeFetch(() => [200, { count: 2, errors: ["Line 3: empty topic"] }]);
    vi.stubGlobal("fetch", f.fn);
    const r = await api.putSyllabus("s1", "Vector spaces\n  Bases");
    expect(r).toEqual({ count: 2, errors: ["Line 3: empty topic"] });
    expect(f.calls[0]).toEqual({ method: "PUT", url: "/api/v1/syllabus/s1", body: { text: "Vector spaces\n  Bases" } });
  });

  it.each([
    ["plan (extra field on an item)", () => api.plan(), { ...plan(), days: [{ date: "2026-11-09", items: [{ ...plan().days[0]!.items[0]!, extra: 1 }] }] }],
    ["plan (unknown kind)", () => api.plan(), { ...plan(), days: [{ date: "2026-11-09", items: [{ ...plan().days[0]!.items[0]!, kind: "nap" }] }] }],
    ["priorReports (no `reports` wrapper)", () => api.priorReports(), priorReports().reports],
    ["priorReport (unknown bucket)", () => api.priorReport("p1"), { ...priorReport(), items: [{ ...priorReport().items[0]!, bucket: "meh" }] }],
    ["syllabus (level out of range)", () => api.syllabus("s1"), { items: [{ ...syllabus().items[0]!, level: 7 }] }],
    ["putSyllabus (no `errors`)", () => api.putSyllabus("s1", "x"), { count: 1 }],
  ])("rejects a malformed response with ContractError: %s", async (_, call, body) => {
    vi.stubGlobal("fetch", fakeFetch(() => [200, body]).fn);
    await expect(call()).rejects.toBeInstanceOf(ContractError);
  });
});

const instance = { recipeVersion: 1, statement: "x", answerKind: "number", shape: null, variables: [], choices: null };
