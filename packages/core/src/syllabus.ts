// ADR 105 §6 (22): optional syllabus per subject. Text parser and coverage of a topic by concepts.

export interface SyllabusItem {
  position: number;
  level: number;
  title: string;
}

const MAX_ITEMS = 300;
const MAX_TITLE = 200;
const MAX_LEVEL = 3;
/** Optional list marker: "- ", "* ", "1. ", "1) " (the number is followed by a dot or parenthesis and a space). */
const MARKER = /^(?:[-*]|\d+[.)])(?:\s+|$)/;

/** One line = one topic. Indentation: 2 spaces or one tab = one level (max 3); the marker goes after the indentation. */
export function parseSyllabus(text: string): { items: SyllabusItem[]; errors: string[] } {
  const items: SyllabusItem[] = [];
  const errors: string[] = [];
  let full = false;
  text.split("\n").forEach((raw, idx) => {
    const line = raw.trimEnd(); // also strips the \r of CRLF
    const indent = /^[ \t]*/.exec(line)![0];
    const width = [...indent].reduce((w, ch) => w + (ch === "\t" ? 2 : 1), 0);
    const title = line.slice(indent.length).replace(MARKER, "").trim();
    if (title === "") return;
    if (title.length > MAX_TITLE) {
      errors.push(`Line ${idx + 1}: the title exceeds ${MAX_TITLE} characters; skipped.`);
      return;
    }
    if (items.length >= MAX_ITEMS) {
      if (!full) errors.push(`Maximum ${MAX_ITEMS} topics: the rest is discarded starting at line ${idx + 1}.`);
      full = true;
      return;
    }
    items.push({ position: items.length, level: Math.min(MAX_LEVEL, Math.floor(width / 2)), title });
  });
  return { items, errors };
}

// minimal English stopwords (only the ≥4-letter ones that actually appear in titles); the rest falls under the 4-letter rule.
const STOPWORDS = new Set([
  "this", "that", "these", "those", "with", "from", "into", "onto", "over", "under", "about", "above", "below", "between",
  "through", "during", "after", "before", "within", "without", "each", "some", "such", "also", "than", "then", "there", "their",
  "which", "where", "when", "what", "while", "because", "other", "more", "most", "very", "your", "have", "been", "will", "would",
]);

/** Normalized tokens: lowercase, without accents, letters only, ≥4 letters and no stopwords. No duplicates. */
export function normalizedTokens(text: string): Set<string> {
  const norm = text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  return new Set(norm.split(/[^a-z]+/).filter((t) => t.length >= 4 && !STOPWORDS.has(t)));
}

const SEEN_RATIO = 0.6;

/**
 * A topic is seen if ONE concept contains (as a whole token) at least 60% of the title's tokens in name + description + statements.
 * The concept with the most tokens wins; on a tie, the lowest conceptId. `conceptId` is null if the topic is not seen
 * (even though `matched` counts the best attempt).
 */
export function syllabusCoverage(
  title: string,
  concepts: { conceptId: string; name: string; description: string; statements: string }[],
): { conceptId: string | null; matched: number; total: number; seen: boolean } {
  const wanted = [...normalizedTokens(title)];
  const total = wanted.length;
  let best: { conceptId: string; matched: number } | null = null;
  for (const c of concepts) {
    const have = normalizedTokens(`${c.name} ${c.description} ${c.statements}`);
    const matched = wanted.filter((t) => have.has(t)).length;
    if (best === null || matched > best.matched || (matched === best.matched && c.conceptId < best.conceptId)) best = { conceptId: c.conceptId, matched };
  }
  const matched = best?.matched ?? 0;
  const seen = total > 0 && matched >= SEEN_RATIO * total;
  return { conceptId: seen ? best!.conceptId : null, matched, total, seen };
}
