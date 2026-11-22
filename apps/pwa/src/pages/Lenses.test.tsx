// ADR 109 (decision 7, UI/MCP parity): read-only "Lenses" block on the concept page,
// fed by GET /lens-feedback?conceptId=...; with no votes it is not rendered.
import { render, screen, waitFor, within } from "@testing-library/react";
import type { ConceptDetail } from "@graphharness/contracts";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeFetch } from "../fixtures.ts";
import { ConceptPage } from "./MapPage.tsx";

afterEach(() => vi.unstubAllGlobals());

const AT = "2026-11-10T09:00:00.000Z";

function concept(): ConceptDetail {
  return {
    id: "c1",
    subjectId: "s1",
    subjectName: "Linear algebra",
    name: "Eigenvalues",
    description: "Scalars λ with Av = λv.",
    computable: false,
    optional: false,
    status: "active",
    mergedInto: null,
    createdBy: "curator",
    createdAt: AT,
    updatedAt: AT,
    state: { conceptId: "c1", state: "review", probability: 0.65, stale: false, manualConfirmation: null, lastEvidenceAt: AT },
    propositions: [],
    templates: [],
    recentEvidence: [],
    notes: [],
    errors: [],
  };
}

const isLenses = (url: string) => url.startsWith("/api/v1/lens-feedback");

function mount(lenses: unknown[]) {
  const f = fakeFetch((method, url) => {
    if (method === "GET" && url === "/api/v1/concepts/c1") return [200, concept()];
    if (method === "GET" && url.startsWith("/api/v1/mastery")) return [200, { concepts: [], unmappedPropositionIds: [] }];
    if (method === "GET" && isLenses(url)) return [200, { conceptId: "c1", conceptName: "Eigenvalues", lenses }];
    return [404, { error: "not_found" }];
  });
  vi.stubGlobal("fetch", f.fn);
  render(
    <MemoryRouter initialEntries={["/concepts/c1"]}>
      <Routes>
        <Route path="/concepts/:id" element={<ConceptPage />} />
      </Routes>
    </MemoryRouter>,
  );
  return f;
}

describe("concept page: 'Lenses' block", () => {
  it("requests the concept's GET /lens-feedback and lists each label with 'helped you X of Y times', in the Hub's order", async () => {
    const f = mount([
      { label: "Physical analogy", likedCount: 2, shownCount: 3, lastAt: AT },
      { label: "Counterexample", likedCount: 0, shownCount: 1, lastAt: AT },
    ]);
    const title = await screen.findByRole("heading", { name: /^Lenses\b/ });
    const call = f.calls.find((c) => isLenses(c.url));
    expect(call).toMatchObject({ method: "GET" });
    expect(new URL(call!.url, "http://x").searchParams.get("conceptId")).toBe("c1");

    const block = title.closest("section") ?? title.parentElement!;
    const rows = within(block).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toMatch(/Physical analogy/);
    expect(rows[0]!.textContent).toMatch(/helped you 2 of 3 times/);
    expect(rows[1]!.textContent).toMatch(/Counterexample/);
    expect(rows[1]!.textContent).toMatch(/helped you 0 of 1 (time|times)/);
    // read-only: nothing to press or fill in within the block
    expect(within(block).queryAllByRole("button")).toHaveLength(0);
    expect(within(block).queryAllByRole("textbox")).toHaveLength(0);
  });

  it("with no votes the block is not rendered", async () => {
    const f = mount([]);
    await screen.findByRole("heading", { name: "Eigenvalues" });
    await waitFor(() => expect(f.calls.some((c) => isLenses(c.url))).toBe(true));
    // let the response be processed before checking the absence
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("heading", { name: /^Lenses\b/ })).toBeNull();
    expect(screen.queryByText(/helped you/)).toBeNull();
  });
});
