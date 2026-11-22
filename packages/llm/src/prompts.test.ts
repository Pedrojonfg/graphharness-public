import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fillPrompt, loadPrompt } from "./prompts.ts";

function dirWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "prompts-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

describe("loadPrompt", () => {
  it("picks the highest version numerically (v10 > v2)", () => {
    const dir = dirWith({ "task.v1.md": "one", "task.v2.md": "two", "task.v10.md": "ten", "other.v99.md": "foreign" });
    expect(loadPrompt("task", undefined, dir)).toEqual({ text: "ten", version: "task.v10" });
  });
  it("honours the requested version", () => {
    const dir = dirWith({ "task.v1.md": "one", "task.v2.md": "two" });
    expect(loadPrompt("task", 1, dir)).toEqual({ text: "one", version: "task.v1" });
  });
  it("throws if the task or the version does not exist", () => {
    const dir = dirWith({ "task.v1.md": "one" });
    expect(() => loadPrompt("nothing", undefined, dir)).toThrow(/nothing/);
    expect(() => loadPrompt("task", 7, dir)).toThrow(/task\.v7/);
  });
});

describe("fillPrompt", () => {
  it("substitutes {{var}} (several times, with spaces) and numbers", () => {
    expect(fillPrompt("Hello {{ name }}, {{n}} things; bye {{name}}", { name: "Ana", n: 3 })).toBe("Hello Ana, 3 things; bye Ana");
  });
  it("does not reinterpret braces in the substituted value", () => {
    expect(fillPrompt("x={{a}}", { a: "{{b}}", b: "bad" })).toBe("x={{b}}");
  });
  it("throws if a variable is missing", () => {
    expect(() => fillPrompt("{{missing}}", {})).toThrow(/missing/);
  });
});
