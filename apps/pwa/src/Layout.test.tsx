import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { MorePage } from "./Layout.tsx";

describe("secondary navigation ('More')", () => {
  it.each([
    ["Week", "/week"],
    ["Syllabus", "/syllabus"],
  ])("has the '%s' entry that links to %s", (name, route) => {
    render(
      <MemoryRouter>
        <MorePage />
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: name }).getAttribute("href")).toBe(route);
  });
});
