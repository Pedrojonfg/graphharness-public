import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_PROMPTS_DIR = fileURLToPath(new URL("../prompts/", import.meta.url));

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Reads `<dir>/<task>.v<N>.md` (the highest N if `version` is not given) → `{text, version: "<task>.v<N>"}`. */
export function loadPrompt(task: string, version?: number, dir: string = DEFAULT_PROMPTS_DIR): { text: string; version: string } {
  let n = version;
  if (n === undefined) {
    const re = new RegExp(`^${escapeRegExp(task)}\\.v(\\d+)\\.md$`);
    const versions = readdirSync(dir)
      .map((f) => re.exec(f)?.[1])
      .filter((v): v is string => v !== undefined)
      .map(Number);
    if (versions.length === 0) throw new Error(`There is no prompt for task "${task}" in ${dir}.`);
    n = Math.max(...versions);
  }
  const id = `${task}.v${n}`;
  let text: string;
  try {
    text = readFileSync(join(dir, `${id}.md`), "utf8");
  } catch (err) {
    throw new Error(`Prompt ${id} does not exist in ${dir}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { text, version: id };
}

/** Substitutes `{{var}}`; a missing variable throws an error. */
export function fillPrompt(text: string, vars: Record<string, string | number>): string {
  // Single pass: substituted text is not interpreted again.
  return text.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_m, name: string) => {
    if (!Object.hasOwn(vars, name)) throw new Error(`Missing variable "${name}" for the prompt.`);
    return String(vars[name]);
  });
}
