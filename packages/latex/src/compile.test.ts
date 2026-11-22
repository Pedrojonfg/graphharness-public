import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compileTex, compileWithFallback } from "./compile.ts";
import type { LatexChildLike, LatexSpawn } from "./types.ts";

afterEach(() => vi.useRealTimers());

interface Call { command: string; args: string[]; cwd: string; killed: boolean; tex: string }

/** `behavior` decides how each process ends; returns undefined to hang (timeout). */
function fakeSpawn(behavior: (call: Call) => { code: number; stdout?: string } | undefined) {
  const calls: Call[] = [];
  const spawn: LatexSpawn = (command, args, opts) => {
    const out = new EventEmitter();
    const err = new EventEmitter();
    const ev = new EventEmitter();
    const call: Call = { command, args, cwd: opts.cwd, killed: false, tex: readFileSync(join(opts.cwd, "doc.tex"), "utf8") };
    calls.push(call);
    const child: LatexChildLike = {
      stdout: { on: (e, cb) => out.on(e, cb) },
      stderr: { on: (e, cb) => err.on(e, cb) },
      on: ((e: string, cb: (...a: any[]) => void) => ev.on(e, cb)) as LatexChildLike["on"],
      kill() {
        call.killed = true;
        queueMicrotask(() => ev.emit("close", null));
        return true;
      },
    };
    const r = behavior(call);
    if (r) queueMicrotask(() => {
      if (r.stdout) out.emit("data", Buffer.from(r.stdout));
      ev.emit("close", r.code);
    });
    return child;
  };
  return { spawn, calls };
}
const tmp = () => mkdtempSync(join(tmpdir(), "latex-test-"));

describe("compileTex", () => {
  it("writes doc.tex and runs pdflatex with the exact arguments in outDir", async () => {
    const outDir = tmp();
    const { spawn, calls } = fakeSpawn(() => ({ code: 0, stdout: "Output written" }));
    const r = await compileTex("\\documentclass{article}", { outDir, spawn });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("pdflatex");
    expect(calls[0]!.args).toEqual(["-interaction=nonstopmode", "-halt-on-error", "doc.tex"]);
    expect(calls[0]!.cwd).toBe(outDir);
    expect(calls[0]!.tex).toBe("\\documentclass{article}");
    expect(r.ok).toBe(true);
    expect(r.pdfPath).toBe(join(outDir, "doc.pdf"));
    expect(r.log).toContain("Output written");
  });

  it("exit code ≠ 0 → ok:false with the log, no pdfPath and NO retries", async () => {
    const { spawn, calls } = fakeSpawn(() => ({ code: 1, stdout: "! Undefined control sequence." }));
    const r = await compileTex("x", { outDir: tmp(), spawn });
    expect(r.ok).toBe(false);
    expect(r.pdfPath).toBeUndefined();
    expect(r.log).toContain("Undefined control sequence");
    expect(calls).toHaveLength(1);
  });

  it("timeout (25 s by default) kills the process, ok:false and retries 2 times → 3 attempts", async () => {
    vi.useFakeTimers();
    const { spawn, calls } = fakeSpawn(() => undefined);
    const p = compileTex("x", { outDir: tmp(), spawn });
    await vi.advanceTimersByTimeAsync(24_000);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(80_000);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.killed)).toBe(true);
  });

  it("respects timeoutSec and retries", async () => {
    vi.useFakeTimers();
    const { spawn, calls } = fakeSpawn(() => undefined);
    const p = compileTex("x", { outDir: tmp(), spawn, timeoutSec: 2, retries: 0 });
    await vi.advanceTimersByTimeAsync(2_100);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("a timeout followed by success returns ok", async () => {
    vi.useFakeTimers();
    let n = 0;
    const { spawn, calls } = fakeSpawn(() => (++n === 1 ? undefined : { code: 0 }));
    const p = compileTex("x", { outDir: tmp(), spawn, timeoutSec: 1 });
    await vi.advanceTimersByTimeAsync(1_100);
    const r = await p;
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });
});

describe("compileWithFallback", () => {
  const build = ({ includeTikz }: { includeTikz: boolean }) => ({
    tex: includeTikz ? "with \\begin{tikzpicture}" : "no drawing",
    omitted: includeTikz ? [] : ["The concept map could not be included."],
  });

  it("if it compiles on the first try, it neither retries nor omits anything", async () => {
    const { spawn, calls } = fakeSpawn(() => ({ code: 0 }));
    const r = await compileWithFallback(build, { outDir: tmp(), spawn });
    expect(r.ok).toBe(true);
    expect(r.omitted).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("if it fails with the TikZ, retries without it and marks it in omitted (GL-058)", async () => {
    const { spawn, calls } = fakeSpawn((c) => ({ code: c.tex.includes("tikzpicture") ? 1 : 0 }));
    const r = await compileWithFallback(build, { outDir: tmp(), spawn });
    expect(calls.map((c) => c.tex)).toEqual(["with \\begin{tikzpicture}", "no drawing"]);
    expect(r.ok).toBe(true);
    expect(r.omitted.length).toBeGreaterThanOrEqual(1);
    expect(r.omitted.join(" ")).toMatch(/TikZ|concept map|graph/i);
  });

  it("if it also fails without TikZ → ok:false, only 2 compilations", async () => {
    const { spawn, calls } = fakeSpawn(() => ({ code: 1, stdout: "boom" }));
    const r = await compileWithFallback(build, { outDir: tmp(), spawn });
    expect(r.ok).toBe(false);
    expect(r.log).toContain("boom");
    expect(calls).toHaveLength(2);
  });
});

// REAL integration with the system pdflatex. If it is not in PATH the suite is skipped with a warning.
const hasPdflatex = spawnSync("pdflatex", ["--version"]).status === 0;
if (!hasPdflatex) console.warn("[latex] pdflatex is not in PATH: skipping the real integration test");

describe.skipIf(!hasPdflatex)("integration with real pdflatex", () => {
  it("compiles renderSessionTex with minimal data and generates the PDF", async () => {
    const { renderSessionTex } = await import("./render.ts");
    const { graphTikz } = await import("./tikz.ts");
    const tikz = graphTikz({
      nodes: [{ id: "a", name: "Limits", state: "solid" }, { id: "b", name: "Derivatives", state: "weak" }],
      edges: [{ from: "a", to: "b" }],
    });
    const data = {
      title: "Minimal session", subject: "Calculus", date: "today", concepts: [{ name: "Limits", before: "unknown" as const, after: "solid" as const }],
      questions: [{ text: "Is $x^2$ at 50%?", correct: true }], practices: [], errors: [], declarations: [], cardsCreated: 0,
      recommendation: [], llm: { summary: "Summary with $x^2$ and a_b.", review: "", errors: "" },
      formulas: [{ label: "Power", expression: "x^n" }], tikz,
    };
    const outDir = tmp();
    const r = await compileWithFallback((o) => renderSessionTex(data, o), { outDir });
    expect(r.log).not.toContain("! ");
    expect(r.ok).toBe(true);
    expect(r.omitted).toEqual([]);
    expect(existsSync(r.pdfPath!)).toBe(true);
    expect(statSync(r.pdfPath!).size).toBeGreaterThan(1000);
  });
});
