import { ReportListSchema } from "@graphharness/contracts";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeFetch, priorReports } from "../fixtures.ts";
import { ReportsPage } from "./ReportsPage.tsx";

afterEach(() => vi.unstubAllGlobals());

const reportsSession = ReportListSchema.parse([
  { id: "r1", createdAt: "2026-11-08T18:00:00.000Z", hasPdf: true, omitted: [], kind: "session", chatId: "ch1", subjectId: "s1", title: "Eigenvalue session" },
]);

describe("Reports screen", () => {
  it("includes the 'Prior knowledge' section without removing the session report list", async () => {
    const f = fakeFetch((_m, url) => {
      if (url.startsWith("/api/v1/prior-reports")) return [200, priorReports()];
      if (url.startsWith("/api/v1/reports")) return [200, reportsSession];
      return [404, { error: "not_found" }];
    });
    vi.stubGlobal("fetch", f.fn);
    render(
      <MemoryRouter>
        <ReportsPage />
      </MemoryRouter>,
    );
    expect((await screen.findByRole("link", { name: /Eigenvalue session/ })).getAttribute("href")).toBe("/reports/r1");
    expect(await screen.findByRole("heading", { name: "Prior knowledge" })).toBeTruthy();
    expect(await screen.findByText(/70 % known · 20 % stale · 10 % new/)).toBeTruthy();
    expect(screen.getAllByRole("link").some((a) => a.getAttribute("href") === "/prior/p1")).toBe(true);
    expect(f.calls.some((c) => c.method === "GET" && c.url.startsWith("/api/v1/reports"))).toBe(true);
  });
});
