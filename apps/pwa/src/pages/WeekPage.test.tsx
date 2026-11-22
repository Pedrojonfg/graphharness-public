import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeFetch, plan } from "../fixtures.ts";
import { WeekPage } from "./WeekPage.tsx";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mount(handler: Parameters<typeof fakeFetch>[0]) {
  const f = fakeFetch(handler);
  vi.stubGlobal("fetch", f.fn);
  render(
    <MemoryRouter>
      <WeekPage />
    </MemoryRouter>,
  );
  return f;
}

/** The list element containing the concept name (each plan item is an <li>). */
async function item(name: string): Promise<HTMLElement> {
  const li = (await screen.findByText(name)).closest("li");
  expect(li).not.toBeNull();
  return li!;
}

const hrefs = (el: HTMLElement) => within(el).queryAllByRole("link").map((a) => a.getAttribute("href"));

/** Fake window.open: openAfterRequest opens the tab before the request and sets its URL afterwards. */
function tabFalse() {
  const w = { location: { href: "about:blank" }, close: vi.fn() };
  const open = vi.spyOn(window, "open").mockReturnValue(w as unknown as Window);
  return { w, open };
}

const planOk = (method: string, url: string): [number, unknown] =>
  method === "GET" && url.startsWith("/api/v1/plan") ? [200, plan()] : [404, { error: "not_found" }];

describe("Week screen", () => {
  it("requests GET /plan and renders the days in order with their long date", async () => {
    const f = mount(planOk);
    await screen.findByText("Eigenvalues");
    expect(f.calls[0]).toMatchObject({ method: "GET" });
    expect(f.calls[0]!.url.startsWith("/api/v1/plan")).toBe(true);
    const text = document.body.textContent ?? "";
    const positions = [/monday,? 9 november/i, /tuesday,? 10 november/i, /wednesday,? 11 november/i].map((re) => text.search(re));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("each item shows concept and reason; cards link to /cards and exercises to /exercises?concept=<id>", async () => {
    mount(planOk);
    const cards = await item("Eigenvalues");
    expect(within(cards).getByText("3 cards due today")).toBeTruthy();
    expect(hrefs(cards)).toContain("/cards");

    const exercises = await item("Diagonalization");
    expect(within(exercises).getByText("Exam in 5 days and it is weak")).toBeTruthy();
    expect(hrefs(exercises)).toContain("/exercises?concept=k2");
    expect(hrefs(exercises)).not.toContain("/cards");

    const session = await item("Determinants");
    expect(within(session).getByRole("button", { name: /Open session/ })).toBeTruthy();
    expect(hrefs(cards).some((h) => h?.startsWith("/exercises"))).toBe(false);
  });

  it("a day without items says 'Nothing due' and warns about concepts that do not fit", async () => {
    mount(planOk);
    expect(await screen.findByText("Nothing due")).toBeTruthy();
    expect(screen.getAllByText("Nothing due")).toHaveLength(1);
    expect(screen.getByText(/3 concepts do not fit this week/)).toBeTruthy();
  });

  it("with no concepts outside the plan there is no warning", async () => {
    mount((_method, url) => (url.startsWith("/api/v1/plan") ? [200, plan({ unscheduledCount: 0 })] : [404, { error: "not_found" }]));
    await screen.findByText("Eigenvalues");
    expect(screen.queryByText(/do not fit this week/)).toBeNull();
  });

  it("'Open session' creates the concept's teaching session in its subject and opens LH", async () => {
    const { w } = tabFalse();
    const f = mount((method, url) => {
      if (method === "POST" && url === "/api/v1/sessions") return [201, { chatId: "ch1", url: "https://lh.example/chat/ch1" }];
      return planOk(method, url);
    });
    const session = await item("Determinants");
    fireEvent.click(within(session).getByRole("button", { name: /Open session/ }));
    await waitFor(() => expect(w.location.href).toBe("https://lh.example/chat/ch1"));
    const post = f.calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe("/api/v1/sessions");
    expect(post.body).toMatchObject({ subjectId: "s1", kind: "teaching", focusConceptIds: ["k3"] });
    expect((post.body as { goal: string }).goal).toContain("Determinants");
  });

  it("if the concept has no subject it does not call the Hub and explains why", async () => {
    tabFalse();
    const f = mount(planOk);
    const session = await item("Limits");
    fireEvent.click(within(session).getByRole("button", { name: /Open session/ }));
    expect((await within(session).findByRole("alert")).textContent).toMatch(/subject/i);
    expect(f.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("if LH has no model configured it says so as in Today and closes the tab", async () => {
    const { w } = tabFalse();
    mount((method, url) =>
      method === "POST" ? [503, { error: "Configure a model", code: "models_not_configured", missing: ["chat"] }] : planOk(method, url),
    );
    const session = await item("Determinants");
    fireEvent.click(within(session).getByRole("button", { name: /Open session/ }));
    expect((await within(session).findByRole("alert")).textContent).toMatch(/LearnHarness has no model configured.*chat/);
    expect(w.close).toHaveBeenCalled();
  });

  it("shows loading and, if the Hub fails, an error with retry that requests the plan again", async () => {
    let fails = true;
    const f = fakeFetch((method, url) => planOk(method, url));
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
      fails ? Promise.reject(new TypeError("Failed to fetch")) : f.fn(input, init),
    );
    render(
      <MemoryRouter>
        <WeekPage />
      </MemoryRouter>,
    );
    expect(screen.getByRole("status")).toBeTruthy();
    expect(await screen.findByRole("alert")).toBeTruthy();
    fails = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Eigenvalues")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
