import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileFragment } from "./fragment.ts";
import type { LatexChildLike, LatexSpawn } from "./types.ts";

interface Call { command: string; args: string[]; cwd: string; tex?: string }

function fakeSpawn(
  behavior: (call: Call) => { code: number; stdout?: string } | undefined,
  opts: { texPath?: string } = {},
) {
  const calls: Call[] = [];
  const texName = opts.texPath ?? "doc.tex";
  const spawn: LatexSpawn = (command, args, cwdOpts) => {
    const out = new EventEmitter();
    const err = new EventEmitter();
    const ev = new EventEmitter();
    const call: Call = { command, args, cwd: cwdOpts.cwd };
    if (command === "pdflatex") {
      call.tex = readFileSync(join(cwdOpts.cwd, texName), "utf8");
    }
    calls.push(call);
    const child: LatexChildLike = {
      stdout: { on: (e, cb) => out.on(e, cb) },
      stderr: { on: (e, cb) => err.on(e, cb) },
      on: ((e: string, cb: (...a: unknown[]) => void) => ev.on(e, cb)) as LatexChildLike["on"],
      kill() {
        queueMicrotask(() => ev.emit("close", null));
        return true;
      },
    };
    const r = behavior(call);
    if (r) {
      queueMicrotask(() => {
        if (r.stdout) out.emit("data", Buffer.from(r.stdout));
        ev.emit("close", r.code);
      });
    }
    return child;
  };
  return { spawn, calls };
}

const tmp = () => mkdtempSync(join(tmpdir(), "latex-frag-"));

describe("compileFragment", () => {
  it("rejects forbidden commands without launching pdflatex", async () => {
    const { spawn, calls } = fakeSpawn(() => ({ code: 0 }));
    const r = await compileFragment("\\input{/etc/passwd}", { outDir: tmp(), spawn });
    expect(r.ok).toBe(false);
    expect(r.log).toMatch(/not allowed/i);
    expect(calls).toHaveLength(0);
  });

  it("rejects libraries outside the allowlist without launching pdflatex", async () => {
    const { spawn, calls } = fakeSpawn(() => ({ code: 0 }));
    const r = await compileFragment("\\draw (0,0)--(1,1);", { outDir: tmp(), spawn, libraries: ["pgfplots"] });
    expect(r.ok).toBe(false);
    expect(r.log).toMatch(/pgfplots/i);
    expect(calls).toHaveLength(0);
  });

  it("wraps the body, compiles and calls pdftocairo", async () => {
    const { spawn, calls } = fakeSpawn((c) =>
      c.command === "pdflatex" ? { code: 0, stdout: "Output written on doc.pdf" } : { code: 0 },
    );
    const outDir = tmp();
    const r = await compileFragment("\\draw (0,0) circle (1cm);", {
      outDir,
      spawn,
      libraries: ["arrows.meta", "calc"],
    });
    expect(r.ok).toBe(true);
    expect(r.pdfPath).toBe(join(outDir, "doc.pdf"));
    expect(r.svgPath).toBe(join(outDir, "doc.svg"));
    expect(calls.map((c) => c.command)).toEqual(["pdflatex", "pdftocairo"]);
    expect(calls[0]!.tex).toContain("\\usetikzlibrary{arrows.meta,calc}");
    expect(calls[0]!.tex).toContain("\\begin{tikzpicture}");
    expect(calls[1]!.args).toEqual(["-svg", "doc.pdf", "doc.svg"]);
  });

  it("if pdftocairo fails, returns ok with the PDF and the SVG failure log", async () => {
    const { spawn } = fakeSpawn((c) =>
      c.command === "pdflatex" ? { code: 0 } : { code: 1, stdout: "error" },
    );
    const outDir = tmp();
    const r = await compileFragment("\\begin{tikzpicture}\\draw (0,0)--(1,0);\\end{tikzpicture}", { outDir, spawn });
    expect(r.ok).toBe(true);
    expect(r.pdfPath).toBeDefined();
    expect(r.svgPath).toBeUndefined();
    expect(r.log).toMatch(/pdftocairo failed/i);
  });
});

// `--version` can exit 0 with a broken TeX install (no pdflatex.fmt); kpsewhich detects it.
const hasPdflatex =
  spawnSync("pdflatex", ["--version"]).status === 0 &&
  spawnSync("kpsewhich", ["pdflatex.fmt"]).status === 0;
const hasPdftocairo = spawnSync("pdftocairo", ["-v"]).status === 0;
const hasToolchain = hasPdflatex && hasPdftocairo;
if (!hasToolchain) {
  console.warn("[latex] No pdflatex/pdftocairo in PATH: skipping the compileFragment integration");
}

describe.skipIf(!hasToolchain)("compileFragment integration", () => {
  it("compiles a minimal circle to PDF and SVG", async () => {
    const outDir = tmp();
    const r = await compileFragment("\\draw (0,0) circle (0.5cm);", { outDir, libraries: ["calc"] });
    expect(r.ok).toBe(true);
    expect(r.pdfPath).toBeDefined();
    expect(r.svgPath).toBeDefined();
    expect(r.log).not.toContain("! ");
  });
});
