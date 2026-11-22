import { CardRetireResponseSchema, CardReviewResponseSchema } from "@graphharness/contracts";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cardInstanceConfirmation,
  cardMcq,
  cardParsons,
  cardSpotBug,
  cardText,
  queue,
  fakeFetch,
} from "../fixtures.ts";
import { CardsPage } from "./CardsPage.tsx";

afterEach(() => vi.unstubAllGlobals());

const reviewOk = (cardId: string, correct: boolean, expectedAnswer: unknown = null) =>
  CardReviewResponseSchema.parse({
    cardId,
    correct,
    early: false,
    evidenceRecorded: true,
    retired: false,
    schedule: { priority: 0, due: false, intervalDays: correct ? 7 : 1, repetitions: correct ? 3 : 0 },
    expectedAnswer,
    conceptState: null,
  });

function mount(handler: Parameters<typeof fakeFetch>[0]) {
  const f = fakeFetch(handler);
  vi.stubGlobal("fetch", f.fn);
  render(
    <MemoryRouter>
      <CardsPage />
    </MemoryRouter>,
  );
  return f;
}

describe("Cards screen", () => {
  it("renders the queue, grades locally and sends {correct, given}; after a miss it offers 'actually I was right'", async () => {
    const f = mount((method, url) => {
      if (method === "GET") return [200, queue([cardText()])];
      if (url.endsWith("/cards/c_text/review")) return [200, reviewOk("c_text", false)];
      return [404, { error: "not_found" }];
    });
    expect(await screen.findByLabelText("Your answer")).toBeTruthy();
    expect(screen.getByText("1 due")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Your answer"), { target: { value: "eigenvector" } });
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    expect(await screen.findByText("Not quite")).toBeTruthy();
    const post = f.calls.find((c) => c.method === "POST")!;
    expect(post.body).toMatchObject({ correct: false, given: "eigenvector" });
    expect(screen.getByText("eigenvalue")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Actually I was right" }));
    expect(await screen.findByText("Marked as correct")).toBeTruthy();
    expect(f.calls.filter((c) => c.method === "POST").at(-1)!.body).toEqual({ override: true });
  });

  it("the confirmation is marked and, without a local answer, only `given` (matrix) is sent and the Hub's is shown", async () => {
    const f = mount((method) =>
      method === "GET"
        ? [200, queue([cardInstanceConfirmation(), cardText()])]
        : [
            200,
            reviewOk("c_conf", false, [
              ["1", "2"],
              ["3", "4"],
            ]),
          ],
    );
    expect(await screen.findByText("Confirmation")).toBeTruthy();
    ["1", "2", "3", "5"].forEach((v, i) =>
      fireEvent.change(screen.getByLabelText(`Row ${Math.floor(i / 2) + 1}, column ${(i % 2) + 1}`), { target: { value: v } }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    expect(await screen.findByText("Not quite")).toBeTruthy();
    const post = f.calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe("/api/v1/cards/c_conf/review");
    expect(post.body).toEqual({
      given: [
        ["1", "2"],
        ["3", "5"],
      ],
      responseMs: expect.any(Number),
    });
    expect(screen.queryByRole("button", { name: "Actually I was right" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByLabelText("Your answer")).toBeTruthy();
  });

  it("Skip advances to the next card without any POST", async () => {
    const f = mount((method) => (method === "GET" ? [200, queue([cardText(), cardMcq()])] : [404, { error: "not_found" }]));
    expect(await screen.findByLabelText("Your answer")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(await screen.findByText("Trace of")).toBeTruthy();
    expect(f.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("Retire card calls POST /retire and moves to the next one", async () => {
    const f = mount((method, url) => {
      if (method === "GET") return [200, queue([cardText(), cardMcq()])];
      if (url.endsWith("/cards/c_text/retire"))
        return [200, CardRetireResponseSchema.parse({ cardId: "c_text", retired: true })];
      return [404, { error: "not_found" }];
    });
    expect(await screen.findByLabelText("Your answer")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retire card" }));
    expect(await screen.findByText("Trace of")).toBeTruthy();
    const post = f.calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe("/api/v1/cards/c_text/retire");
    expect(post.body).toBeUndefined();
  });

  it("parsons: sends the order in `given` with local `correct`", async () => {
    const f = mount((method, url) => {
      if (method === "GET") return [200, queue([cardParsons()])];
      if (url.endsWith("/cards/c_parsons/review")) return [200, reviewOk("c_parsons", true)];
      return [404, { error: "not_found" }];
    });
    expect(await screen.findByText("Order the program.")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Add" })[0]!);
    fireEvent.click(screen.getAllByRole("button", { name: "Add" })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    expect(await screen.findByText("Correct")).toBeTruthy();
    const post = f.calls.find((c) => c.method === "POST")!;
    expect(post.body).toMatchObject({ correct: true, given: ["l0", "l1"] });
  });

  it("spot_bug: sends lineId in `given`", async () => {
    const f = mount((method, url) => {
      if (method === "GET") return [200, queue([cardSpotBug()])];
      if (url.endsWith("/cards/c_spot/review")) return [200, reviewOk("c_spot", false)];
      return [404, { error: "not_found" }];
    });
    expect(await screen.findByText("Which line fails?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /b\.append\(3\)/ }));
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    expect(await screen.findByText("Not quite")).toBeTruthy();
    expect(f.calls.find((c) => c.method === "POST")!.body).toMatchObject({ correct: false, given: "l2" });
  });

  it("if the Hub does not respond, shows the error with a retry option", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("Failed to fetch")));
    render(
      <MemoryRouter>
        <CardsPage />
      </MemoryRouter>,
    );
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});
