import { render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeFetch, priorReport, priorReports } from "../fixtures.ts";
import { PriorReportPage, PriorList } from "./PriorPage.tsx";

afterEach(() => vi.unstubAllGlobals());

function mountList(handler: Parameters<typeof fakeFetch>[0]) {
  const f = fakeFetch(handler);
  vi.stubGlobal("fetch", f.fn);
  render(
    <MemoryRouter>
      <PriorList />
    </MemoryRouter>,
  );
  return f;
}

function mountReport(id: string, handler: Parameters<typeof fakeFetch>[0]) {
  const f = fakeFetch(handler);
  vi.stubGlobal("fetch", f.fn);
  render(
    <MemoryRouter initialEntries={[`/prior/${id}`]}>
      <Routes>
        <Route path="/prior/:id" element={<PriorReportPage />} />
      </Routes>
    </MemoryRouter>,
  );
  return f;
}

const linkA = (href: string) => screen.getAllByRole("link").find((a) => a.getAttribute("href") === href);

describe("prior knowledge list", () => {
  it("requests GET /prior-reports and shows each report with date, paths and percentages without the 0 %, linking to its detail", async () => {
    const f = mountList(() => [200, priorReports()]);
    expect(await screen.findByText(/70 % known · 20 % stale · 10 % new/)).toBeTruthy();
    expect(f.calls[0]).toMatchObject({ method: "GET" });
    expect(f.calls[0]!.url.startsWith("/api/v1/prior-reports")).toBe(true);

    const p1 = linkA("/prior/p1");
    expect(p1).toBeTruthy();
    expect(p1!.textContent).toMatch(/12 nov/i);
    expect(p1!.textContent).toMatch(/2 paths/);
    expect(p1!.textContent).toMatch(/70 % known · 20 % stale · 10 % new/);
    expect(p1!.textContent).not.toMatch(/weak/);

    const p2 = linkA("/prior/p2");
    expect(p2).toBeTruthy();
    expect(p2!.textContent).toMatch(/5 nov/i);
    expect(p2!.textContent).toMatch(/3 paths/);
    expect(p2!.textContent).toMatch(/50 % weak · 50 % new/);
    expect(p2!.textContent).not.toMatch(/known|stale/);
  });

  it("with no reports it says so", async () => {
    mountList(() => [200, { reports: [] }]);
    expect(await screen.findByText("No prior-knowledge reports yet.")).toBeTruthy();
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });
});

describe("prior knowledge report detail", () => {
  const ok = (_m: string, url: string): [number, unknown] =>
    url === "/api/v1/prior-reports/p1" ? [200, priorReport()] : [404, { error: "not_found" }];

  it("header with the total and an accessible bar with the percentages", async () => {
    const f = mountReport("p1", ok);
    const bar = await screen.findByRole("img", { name: /60 % known/ });
    const label = bar.getAttribute("aria-label") ?? "";
    expect(label).toMatch(/20 % stale/);
    expect(label).toMatch(/20 % new/);
    expect(screen.getByText(/5 propositions/)).toBeTruthy();
    expect(f.calls[0]).toMatchObject({ method: "GET", url: "/api/v1/prior-reports/p1" });
  });

  it("groups the propositions in the order new, weak, stale, known with their count and omits empty groups", async () => {
    mountReport("p1", ok);
    await screen.findByText("Jordan canonical form");
    const groups = screen
      .getAllByRole("heading")
      .map((h) => h.textContent ?? "")
      .filter((t) => /new|weak|stale|known/i.test(t));
    expect(groups).toHaveLength(3);
    expect(groups[0]).toMatch(/new/i);
    expect(groups[0]).toMatch(/\b1\b/);
    expect(groups[1]).toMatch(/stale/i);
    expect(groups[1]).toMatch(/\b1\b/);
    expect(groups[2]).toMatch(/known/i);
    expect(groups[2]).toMatch(/\b3\b/);

    // The propositions appear in the order of their groups.
    const text = document.body.textContent ?? "";
    const order = ["Jordan canonical form", "Diagonalizable matrix", "Eigenvalue definition"].map((n) => text.indexOf(n));
    expect(order.every((p) => p >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("links the matched concept of each proposition and does not invent a link if there is none", async () => {
    mountReport("p1", ok);
    const link = await screen.findByRole("link", { name: "Diagonalization" });
    expect(link.getAttribute("href")).toBe("/concepts/k2");
    expect(screen.getByRole("link", { name: "Eigenvalues" }).getAttribute("href")).toBe("/concepts/k1");
    const jordan = screen.getByText("Jordan canonical form").closest("li");
    expect(jordan).not.toBeNull();
    expect(within(jordan!).queryAllByRole("link")).toHaveLength(0);
  });

  it("if the report does not exist it shows the Hub error", async () => {
    mountReport("missing", ok);
    expect((await screen.findByRole("alert")).textContent).toMatch(/Not found/);
  });
});
