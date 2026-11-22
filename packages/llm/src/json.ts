// Ported from graphlearn/packages/llm/src/json.ts (65b56d6).

/**
 * Extracts the JSON object from a model response: accepts ```json blocks and text before or
 * after. Returns `undefined` if there is no readable JSON.
 */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidates = [fenced?.[1], text, outermostObject(text)].filter((c): c is string => Boolean(c?.trim()));
  for (const c of candidates) {
    try {
      return JSON.parse(c.trim());
    } catch {
      // next candidate
    }
  }
  return undefined;
}

/** From the first `{` to its closing `}`, respecting strings and escapes. */
function outermostObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}
