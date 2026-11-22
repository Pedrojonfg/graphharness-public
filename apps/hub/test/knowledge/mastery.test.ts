// GET /mastery — what LH's hub_mastery tool reads (P3a, ADR 104).
import { MasterySchema } from "@graphharness/contracts";
import { describe, expect, it } from "vitest";
import { seedProposition } from "../../src/testing.ts";
import { NOW, call, conceptIn, daysFromNow, mastery, subject, world } from "./helpers.ts";
import { setNow } from "../../src/testing.ts";

describe("GET /mastery", () => {
  it("groups propositions by concept with state, age and staleness; separates the ones it does not know", async () => {
    const { ctx, app } = world();
    const s = subject(ctx);
    const solid = conceptIn(ctx, s, "Eigenvalues");
    const weak = conceptIn(ctx, s, "Matrix diagonalization");
    const p1 = seedProposition(ctx.db, { conceptId: solid });
    const p2 = seedProposition(ctx.db, { conceptId: solid });
    const p3 = seedProposition(ctx.db, { conceptId: weak });
    const dead = seedProposition(ctx.db, { conceptId: solid });
    ctx.db.prepare("UPDATE lh_propositions SET deleted = 1 WHERE id = ?").run(dead);
    const orphan = seedProposition(ctx.db, {}); // synced but without a concept yet
    mastery(ctx, solid, "solid");
    mastery(ctx, weak, "weak");

    const r = await call(app, "get", `/mastery?propositionIds=${[p1, p2, p3, dead, orphan, "n_nope"].join(",")}`);
    expect(r.status).toBe(200);
    const m = MasterySchema.parse(r.json);
    expect(m.unmappedPropositionIds.sort()).toEqual([dead, orphan, "n_nope"].sort());
    expect(m.concepts.map((c) => c.name)).toEqual(["Eigenvalues", "Matrix diagonalization"]);
    expect(m.concepts[0]).toMatchObject({ conceptId: solid, state: "solid", stale: false, ageDays: 0, lastEvidenceAt: NOW });
    expect(m.concepts[0]!.propositionIds.sort()).toEqual([p1, p2].sort());
    expect(m.concepts[1]).toMatchObject({ conceptId: weak, state: "weak", propositionIds: [p3] });
  });

  it("a solid concept with old evidence comes out stale and with its age in days", async () => {
    const { ctx, app } = world();
    const c = conceptIn(ctx, subject(ctx), "Rank");
    const p = seedProposition(ctx.db, { conceptId: c });
    mastery(ctx, c, "solid");
    setNow(ctx, daysFromNow(400));
    const m = MasterySchema.parse((await call(app, "get", `/mastery?propositionIds=${p}`)).json);
    expect(m.concepts[0]).toMatchObject({ conceptId: c, stale: true, ageDays: 400 });
  });

  it("a concept without evidence is unknown with age null", async () => {
    const { ctx, app } = world();
    const c = conceptIn(ctx, subject(ctx), "Kernel");
    const p = seedProposition(ctx.db, { conceptId: c });
    const m = MasterySchema.parse((await call(app, "get", `/mastery?propositionIds=${p}`)).json);
    expect(m.concepts[0]).toMatchObject({ state: "unknown", stale: false, lastEvidenceAt: null, ageDays: null });
  });

  it("query searches concepts by text (FTS) without needing propositions", async () => {
    const { ctx, app } = world();
    const s = subject(ctx);
    const c = conceptIn(ctx, s, "Spectral theorem", ["Every real symmetric matrix is diagonalizable"]);
    conceptIn(ctx, s, "Double integrals");
    mastery(ctx, c, "review");
    const m = MasterySchema.parse((await call(app, "get", `/mastery?query=spectral`)).json);
    expect(m.concepts).toHaveLength(1);
    expect(m.concepts[0]).toMatchObject({ conceptId: c, state: "review", propositionIds: [] });
  });

  it("without propositionIds or query → 400; more than 100 ids → 400", async () => {
    const { app } = world();
    expect((await call(app, "get", "/mastery")).status).toBe(400);
    const many = Array.from({ length: 101 }, (_, i) => `n_${i}`).join(",");
    expect((await call(app, "get", `/mastery?propositionIds=${many}`)).status).toBe(400);
  });

  it("a merged concept does not appear", async () => {
    const { ctx, app } = world();
    const s = subject(ctx);
    const a = conceptIn(ctx, s, "A");
    const b = conceptIn(ctx, s, "B");
    const p = seedProposition(ctx.db, { conceptId: a });
    ctx.db.prepare("UPDATE concepts SET status = 'merged', merged_into = ? WHERE id = ?").run(b, a);
    const m = MasterySchema.parse((await call(app, "get", `/mastery?propositionIds=${p}`)).json);
    expect(m.concepts).toEqual([]);
    expect(m.unmappedPropositionIds).toEqual([p]);
  });
});
