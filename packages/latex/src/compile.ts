// Ported from graphlearn/apps/worker/src/pdf/compile.ts (65b56d6): pdflatex with timeout,
// retries only after a timeout (GL-058) and the with/without-graph pattern of master.ts (runMasterPdfJob).
// Changes: system pdflatex via spawn (no Docker) in an `outDir` that is kept.
import { spawn as nodeSpawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TIKZ_REMOVED_NOTICE } from "./render.ts";
import type { CompileOptions, CompileResult, FallbackResult, LatexChildLike, LatexSpawn, RenderOptions, RenderResult } from "./types.ts";

const DEFAULT_TIMEOUT_SEC = 25;
const DEFAULT_RETRIES = 2;
/** only the tail of the log is kept; pdflatex errors appear at the end. */
const LOG_MAX_CHARS = 20_000;

/**
 * System pdflatex. Besides the fixed arguments, it is hardened via the environment (kpathsea reads
 * these variables): no shell-escape and no reading or writing outside the working directory.
 */
const defaultSpawn: LatexSpawn = (command, args, opts): LatexChildLike =>
  nodeSpawn(command, args, {
    cwd: opts.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, shell_escape: "f", openin_any: "p", openout_any: "p" },
  });

/**
 * Writes `outDir/doc.tex` and runs, with cwd=outDir:
 * `pdflatex -interaction=nonstopmode -halt-on-error doc.tex` (system pdflatex, no Docker).
 * Timeout → kills the process, `{ok:false, timedOut:true}` and retries up to `retries` times;
 * a LaTeX error (code ≠ 0) is not retried.
 */
export async function compileTex(tex: string, opts: CompileOptions): Promise<CompileResult> {
  // Synchronous write: the file has to exist before launching pdflatex, and it is small.
  mkdirSync(opts.outDir, { recursive: true });
  writeFileSync(join(opts.outDir, "doc.tex"), tex, "utf8");
  const spawn = opts.spawn ?? defaultSpawn;
  const timeoutMs = (opts.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000;
  const retries = opts.retries ?? DEFAULT_RETRIES;

  let last: CompileResult = { ok: false, log: "" };
  for (let attempt = 0; attempt <= retries; attempt++) {
    // A half-written .aux from a killed attempt can break the next one.
    rmSync(join(opts.outDir, "doc.aux"), { force: true });
    last = await runOnce(spawn, opts.outDir, timeoutMs);
    if (!last.timedOut) return last;
  }
  return last;
}

function runOnce(spawn: LatexSpawn, outDir: string, timeoutMs: number): Promise<CompileResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const log = () => Buffer.concat(chunks).toString("utf8").slice(-LOG_MAX_CHARS);
    let settled = false;
    const settle = (r: CompileResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const child = spawn("pdflatex", ["-interaction=nonstopmode", "-halt-on-error", "doc.tex"], { cwd: outDir });
    const timer = setTimeout(() => {
      settle({ ok: false, timedOut: true, log: `${log()}\n[pdflatex did not finish in ${timeoutMs / 1000} s; it was stopped]` });
      child.kill("SIGKILL");
    }, timeoutMs);
    const collect = (c: Buffer | string) => chunks.push(typeof c === "string" ? Buffer.from(c, "utf8") : c);
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (err) => settle({ ok: false, log: `Could not run pdflatex: ${err.message}` }));
    child.on("close", (code) =>
      settle(code === 0 ? { ok: true, pdfPath: join(outDir, "doc.pdf"), log: log() } : { ok: false, log: log() }),
    );
  });
}

/**
 * GL-058: compiles `build({includeTikz:true})`; if it fails, rebuilds with `includeTikz:false`,
 * compiles it and adds a notice about the TikZ to `omitted`. If both fail, `ok:false`.
 */
export async function compileWithFallback(
  build: (opts: Required<RenderOptions>) => RenderResult,
  opts: CompileOptions,
): Promise<FallbackResult> {
  const withTikz = build({ includeTikz: true });
  const first = await compileTex(withTikz.tex, opts);
  if (first.ok) return { ...first, omitted: withTikz.omitted };

  const withoutTikz = build({ includeTikz: false });
  // Without TikZ to remove there is nothing different to try (and the notice would be false).
  if (withoutTikz.tex === withTikz.tex) return { ...first, omitted: withTikz.omitted };
  const second = await compileTex(withoutTikz.tex, opts);
  const omitted = withoutTikz.omitted.includes(TIKZ_REMOVED_NOTICE) ? withoutTikz.omitted : [...withoutTikz.omitted, TIKZ_REMOVED_NOTICE];
  return { ...second, omitted };
}
