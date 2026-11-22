// ADR 103 (1): the curator inherits the subject of the new concept from the folder of its source file (fileSources).
import type { GraphNode, GraphSnapshot } from "@graphharness/lh-client";
import { makeTestContext, seedSubject } from "@graphharness/hub/testing";
import { describe, expect, it } from "vitest";
import { runConceptCurate, runLhSync } from "../../src/handlers/ingest.ts";
import { haystack, lhWith, llmByKind } from "./helpers.ts";

const NOW = "2026-11-10T09:00:00.000Z";
const prop = (id: string, src: string): GraphNode => ({
  id,
  name: `name-${id}`,
  statement: `Statement of ${id}: a result from the topic.`,
  aliases: [],
  provenance: [{ chatId: src, messageId: "" }],
  createdAt: NOW,
});

/** The curator ALWAYS creates a new concept per proposition with subjectId null (it does not decide the subject). */
function setup(graph: GraphSnapshot, subjects: { name: string; folder: string | null }[]) {
  const llm = llmByKind({
    curator: (req) => {
      const ids = [...new Set(haystack(req).match(/n_[0-9a-f]{12}/g) ?? [])];
      return {
        assignments: ids.map((propositionId, i) => ({
          propositionId,
          conceptId: null,
          newConcept: { tempId: `t${i}`, name: `Concept ${propositionId}`, description: "Description.", subjectId: null, computable: false },
        })),
        newEdges: [],
      };
    },
  });
  const ctx = makeTestContext({ lh: lhWith({ graph, chats: [] }), llm });
  const ids = subjects.map((s) => seedSubject(ctx.db, { name: s.name, ...(s.folder ? { lhSourceFolder: s.folder } : {}) }));
  return { ctx, ids };
}
const subjectOfConceptFor = (ctx: ReturnType<typeof setup>["ctx"], propId: string): string | null =>
  ctx.db.prepare("SELECT c.subject_id FROM concept_propositions cp JOIN concepts c ON c.id = cp.concept_id WHERE cp.proposition_id = ?").pluck().get(propId) as string | null;

describe("concept-curate: subject inheritance by fileSources", () => {
  it("proposition with provenance in a src_ whose file is under a subject's folder → the new concept inherits that subject", async () => {
    const graph: GraphSnapshot = {
      propositions: [prop("n_aaaaaaaaaaaa", "src_x"), prop("n_bbbbbbbbbbbb", "src_y")],
      chains: [],
      fileSources: { src_x: "algebra/topic1.pdf", src_y: "physics/agent-notes/2026-11-10-hooke.md" },
    };
    const { ctx, ids } = setup(graph, [{ name: "Algebra", folder: "algebra" }, { name: "Physics", folder: "physics" }, { name: "Other", folder: null }]);
    await runLhSync(ctx);
    const r = await runConceptCurate(ctx);
    expect(r.createdConceptIds).toHaveLength(2);
    expect(subjectOfConceptFor(ctx, "n_aaaaaaaaaaaa")).toBe(ids[0]);
    expect(subjectOfConceptFor(ctx, "n_bbbbbbbbbbbb")).toBe(ids[1]);
  });

  it("nested folders: the most specific one wins", async () => {
    const graph: GraphSnapshot = {
      propositions: [prop("n_aaaaaaaaaaaa", "src_x"), prop("n_bbbbbbbbbbbb", "src_y")],
      chains: [],
      fileSources: { src_x: "maths/algebra/topic1.pdf", src_y: "maths/analysis/topic2.pdf" },
    };
    const { ctx, ids } = setup(graph, [{ name: "Maths", folder: "maths" }, { name: "Algebra", folder: "maths/algebra" }]);
    await runLhSync(ctx);
    await runConceptCurate(ctx);
    expect(subjectOfConceptFor(ctx, "n_aaaaaaaaaaaa")).toBe(ids[1]); // the specific one
    expect(subjectOfConceptFor(ctx, "n_bbbbbbbbbbbb")).toBe(ids[0]); // only the general one matches
  });

  it("a text prefix is not a folder: 'algebra-other/x.pdf' does NOT inherit from the folder 'algebra'", async () => {
    const graph: GraphSnapshot = { propositions: [prop("n_aaaaaaaaaaaa", "src_x")], chains: [], fileSources: { src_x: "algebra-other/x.pdf" } };
    const { ctx } = setup(graph, [{ name: "Algebra", folder: "algebra" }]);
    await runLhSync(ctx);
    await runConceptCurate(ctx);
    expect(subjectOfConceptFor(ctx, "n_aaaaaaaaaaaa")).toBeNull();
  });

  it("source outside every folder (or with no entry in fileSources) → the concept stays without a subject", async () => {
    const graph: GraphSnapshot = {
      propositions: [prop("n_aaaaaaaaaaaa", "src_x"), prop("n_bbbbbbbbbbbb", "src_unknown")],
      chains: [],
      fileSources: { src_x: "loose/x.pdf" },
    };
    const { ctx } = setup(graph, [{ name: "Algebra", folder: "algebra" }]);
    await runLhSync(ctx);
    await runConceptCurate(ctx);
    expect(subjectOfConceptFor(ctx, "n_aaaaaaaaaaaa")).toBeNull();
    expect(subjectOfConceptFor(ctx, "n_bbbbbbbbbbbb")).toBeNull();
  });
});
