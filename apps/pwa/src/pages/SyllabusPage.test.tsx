import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { subjects, fakeFetch, syllabus } from "../fixtures.ts";
import { SyllabusPage } from "./SyllabusPage.tsx";

afterEach(() => vi.unstubAllGlobals());

type FakeResponse = [number, unknown];

/** Fake Hub: subjects, the syllabus of s1 and whatever `put` returns on save. */
function mount(put: FakeResponse = [200, { count: 3, errors: [] }], subjectsBody: unknown = subjects()) {
  const f = fakeFetch((method, url) => {
    if (method === "GET" && url === "/api/v1/subjects") return [200, subjectsBody];
    if (method === "GET" && url === "/api/v1/syllabus/s1") return [200, syllabus()];
    if (method === "PUT" && url === "/api/v1/syllabus/s1") return put;
    return [404, { error: "not_found" }];
  });
  vi.stubGlobal("fetch", f.fn);
  render(
    <MemoryRouter>
      <SyllabusPage />
    </MemoryRouter>,
  );
  return f;
}

async function chooseAlgebra() {
  const selector = await screen.findByRole("combobox");
  expect(within(selector).getByRole("option", { name: "Linear algebra" })).toBeTruthy();
  fireEvent.change(selector, { target: { value: "s1" } });
  await screen.findByText("Vector spaces");
}

const topic = (title: string) => {
  const li = screen.getByText(title).closest("li");
  expect(li).not.toBeNull();
  return li!;
};

const getsSyllabus = (f: ReturnType<typeof mount>) => f.calls.filter((c) => c.method === "GET" && c.url === "/api/v1/syllabus/s1");

describe("Syllabus screen", () => {
  it("picking a subject requests its syllabus and summarizes how many topics are seen", async () => {
    const f = mount();
    await chooseAlgebra();
    expect(getsSyllabus(f)).toHaveLength(1);
    expect(screen.getByText(/2 of 3 topics seen/)).toBeTruthy();
  });

  it("marks each topic as seen (with its concept state) or unseen", async () => {
    mount();
    await chooseAlgebra();
    const spaces = topic("Vector spaces");
    expect(within(spaces).getByText(/\bseen\b/i)).toBeTruthy();
    expect(within(spaces).getByText("Solid")).toBeTruthy();

    const bases = topic("Bases and dimension");
    expect(within(bases).getByText(/\bseen\b/i)).toBeTruthy();
    expect(within(bases).getByText("To review")).toBeTruthy();

    const jordan = topic("Jordan form");
    expect(within(jordan).getByText(/unseen/i)).toBeTruthy();
    expect(within(jordan).queryByText(/\bseen\b/i)).toBeNull();
    expect(within(jordan).queryByText(/Solid|To review|Weak|No record/)).toBeNull();
  });

  it("'Save syllabus' sends PUT with the text and reloads the syllabus", async () => {
    const f = mount();
    await chooseAlgebra();
    const text = "Vector spaces\n  Bases and dimension\nJordan form";
    fireEvent.change(screen.getByLabelText("Syllabus (one topic per line)"), { target: { value: text } });
    fireEvent.click(screen.getByRole("button", { name: "Save syllabus" }));
    await waitFor(() => expect(getsSyllabus(f)).toHaveLength(2));
    const put = f.calls.find((c) => c.method === "PUT")!;
    expect(put).toEqual({ method: "PUT", url: "/api/v1/syllabus/s1", body: { text: text } });
    expect(f.calls.indexOf(put)).toBeLessThan(f.calls.lastIndexOf(getsSyllabus(f)[1]!));
  });

  it("lists the errors the Hub returns on save", async () => {
    mount([200, { count: 2, errors: ["Line 4: the topic exceeds 200 characters", "Line 7: empty topic"] }]);
    await chooseAlgebra();
    fireEvent.change(screen.getByLabelText("Syllabus (one topic per line)"), { target: { value: "Topic A\nTopic B" } });
    fireEvent.click(screen.getByRole("button", { name: "Save syllabus" }));
    const error = await screen.findByText("Line 4: the topic exceeds 200 characters");
    const list = error.closest("ul, ol");
    expect(list).not.toBeNull();
    expect(within(list as HTMLElement).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Line 4: the topic exceeds 200 characters",
      "Line 7: empty topic",
    ]);
  });

  it("does not allow saving with empty text", async () => {
    const f = mount();
    await chooseAlgebra();
    fireEvent.change(screen.getByLabelText("Syllabus (one topic per line)"), { target: { value: "" } });
    const button = screen.getByRole("button", { name: "Save syllabus" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(f.calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("with no subjects it says so and offers no selector", async () => {
    const f = mount(undefined, []);
    expect(await screen.findByText(/no subjects/i)).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(f.calls.some((c) => c.url.startsWith("/api/v1/syllabus"))).toBe(false);
  });
});
