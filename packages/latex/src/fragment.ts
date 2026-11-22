// ADR 108: compiles an isolated TikZ fragment (PDF + SVG via pdftocairo).
import { spawn as nodeSpawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compileTex } from "./compile.ts";
import { FORBIDDEN_TEX } from "./escape.ts";
import { TEMPLATES_DIR } from "./render.ts";
import type { FragmentCompileOptions, FragmentCompileResult, LatexSpawn } from "./types.ts";
import { TIKZ_FRAGMENT_MAX_CHARS } from "./types.ts";

/** TikZ libraries allowed in fragments (ADR 108). */
const ALLOWED_TIKZ_LIBRARIES = new Set([
  "arrows.meta",
  "calc",
  "positioning",
  "shapes.geometric",
  "decorations.pathreplacing",
  "patterns",
  "fit",
  "backgrounds",
]);

const defaultPdftocairoSpawn: LatexSpawn = (command, args, opts) =>
  nodeSpawn(command, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });

function fillFragmentTemplate(values: Record<string, string>): string {
  const tpl = readFileSync(join(TEMPLATES_DIR, "fragment.tex"), "utf8")
    .split("\n")
    .filter((l) => !l.startsWith("%"))
    .join("\n");
  return tpl.replace(/<<([A-Z_]+)>>/g, (m, key: string) => {
    const v = values[key];
    if (v === undefined) throw new Error(`fragment.tex has a placeholder without a value: ${m}`);
    return v;
  });
}

function validateTikz(tikz: string): string | null {
  if (tikz.length > TIKZ_FRAGMENT_MAX_CHARS) {
    return `The TikZ fragment exceeds ${TIKZ_FRAGMENT_MAX_CHARS} characters.`;
  }
  if (FORBIDDEN_TEX.test(tikz)) return "The TikZ fragment uses commands that are not allowed.";
  if (/\\(?:begin|end)\s*\{document\}/.test(tikz)) return "The TikZ fragment cannot include \\begin{document}.";
  return null;
}

function validateLibraries(libraries: string[] | undefined): string | null {
  if (!libraries?.length) return null;
  for (const lib of libraries) {
    if (!ALLOWED_TIKZ_LIBRARIES.has(lib)) return `The TikZ library "${lib}" is not allowed.`;
  }
  return null;
}

function wrapTikzBody(tikz: string): string {
  const t = tikz.trim();
  if (/\\begin\s*\{tikzpicture\}/.test(t)) return t;
  return `\\begin{tikzpicture}\n${t}\n\\end{tikzpicture}`;
}

function libsBlock(libraries: string[] | undefined): string {
  if (!libraries?.length) return "";
  return `\\usetikzlibrary{${libraries.join(",")}}`;
}

function runPdftocairo(
  outDir: string,
  spawn: LatexSpawn,
  timeoutMs: number,
): Promise<{ ok: boolean; log: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const log = () => Buffer.concat(chunks).toString("utf8").slice(-20_000);
    let settled = false;
    const settle = (r: { ok: boolean; log: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const child = spawn("pdftocairo", ["-svg", "doc.pdf", "doc.svg"], { cwd: outDir });
    const timer = setTimeout(() => {
      settle({ ok: false, log: `${log()}\n[pdftocairo did not finish in ${timeoutMs / 1000} s]` });
      child.kill("SIGKILL");
    }, timeoutMs);
    const collect = (c: Buffer | string) => chunks.push(typeof c === "string" ? Buffer.from(c, "utf8") : c);
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (err) => settle({ ok: false, log: `Could not run pdftocairo: ${err.message}` }));
    child.on("close", (code) => settle(code === 0 ? { ok: true, log: log() } : { ok: false, log: log() }));
  });
}

/**
 * Validates the TikZ, fills `templates/fragment.tex`, compiles with `compileTex` and, if there is a PDF,
 * tries `pdftocairo -svg doc.pdf doc.svg` in the same `outDir`.
 */
export async function compileFragment(tikz: string, opts: FragmentCompileOptions): Promise<FragmentCompileResult> {
  const tikzErr = validateTikz(tikz);
  if (tikzErr) return { ok: false, log: tikzErr };

  const libErr = validateLibraries(opts.libraries);
  if (libErr) return { ok: false, log: libErr };

  const tex = fillFragmentTemplate({
    LIBS: libsBlock(opts.libraries),
    BODY: wrapTikzBody(tikz),
  });

  const compiled = await compileTex(tex, {
    outDir: opts.outDir,
    timeoutSec: opts.timeoutSec,
    retries: opts.retries,
    spawn: opts.spawn,
  });
  if (!compiled.ok) {
    return { ok: false, log: compiled.log, timedOut: compiled.timedOut };
  }

  const timeoutMs = (opts.timeoutSec ?? 25) * 1000;
  const cairo = await runPdftocairo(opts.outDir, opts.pdftocairo ?? opts.spawn ?? defaultPdftocairoSpawn, timeoutMs);
  const svgPath = join(opts.outDir, "doc.svg");
  if (!cairo.ok) {
    return {
      ok: true,
      pdfPath: compiled.pdfPath,
      log: `${compiled.log}\n[pdftocairo failed; the PDF was generated]\n${cairo.log}`.trim(),
    };
  }
  return { ok: true, pdfPath: compiled.pdfPath, svgPath, log: `${compiled.log}\n${cairo.log}`.trim() };
}
