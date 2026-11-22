// Ported from the GraphLearn web app (65b56d6; see docs/PROVENANCE.md): `AnswerInput`, `answerShape`, `toUserInput`.
// Adapted to RecipeClientPayload (SymPy math). Code comprehension instances use another UI (ParsonsBoard / ExercisesPage).
import type { AnswerValue, RecipeClientPayload } from "@graphharness/contracts";
import { useEffect, useId, useState } from "react";
import { MathView, sympyToTex, TextWithMath } from "./MathView.tsx";

export type AnswerGrid = { kind: RecipeClientPayload["answerKind"]; rows: number; cols: number };

/** Grid dimensions from `answerKind` and `shape` (eval: matrix `{rows, cols}`, vector `{size}`). */
export function answerGridFor(inst: Pick<RecipeClientPayload, "answerKind" | "shape">): AnswerGrid {
  const k = inst.answerKind;
  if (k === "matrix") return { kind: k, rows: inst.shape?.rows ?? 2, cols: inst.shape?.cols ?? 2 };
  if (k === "vector") return { kind: k, rows: 1, cols: inst.shape?.size ?? inst.shape?.cols ?? 2 };
  return { kind: k, rows: 1, cols: 1 };
}

/**
 * Cells (row by row) → `userInput.result` value as eval expects it: text for number/expression/choice,
 * `string[]` for vector, `string[][]` for matrix. null if any cell is missing.
 */
export function cellsToValue(r: AnswerGrid, cells: string[]): AnswerValue | null {
  const clean = cells.map((c) => c.trim());
  if (clean.length !== r.rows * r.cols || clean.some((c) => c === "")) return null;
  if (r.kind === "vector") return clean;
  if (r.kind === "matrix") {
    const rows: string[][] = [];
    for (let i = 0; i < r.rows; i++) rows.push(clean.slice(i * r.cols, (i + 1) * r.cols));
    return rows;
  }
  return clean[0]!;
}

export function missingText(kind: RecipeClientPayload["answerKind"]): string {
  if (kind === "matrix" || kind === "vector") return "Fill in all the cells (you can use fractions like 3/4).";
  if (kind === "choice") return "Pick an option.";
  return "Write your answer.";
}

/**
 * Answer cells of a SymPy instance. Calls `onChange` with the value ready to send, or with
 * null if something is missing. `onSubmit` fires on Enter in a text field.
 */
export function AnswerInput({
  instance,
  label = "Your answer",
  disabled = false,
  onChange,
  onSubmit,
}: {
  instance: RecipeClientPayload;
  label?: string;
  disabled?: boolean;
  onChange: (value: AnswerValue | null) => void;
  onSubmit?: () => void;
}) {
  const r = answerGridFor(instance);
  const id = useId();
  const [cells, setCells] = useState<string[]>(() => Array(r.rows * r.cols).fill(""));

  useEffect(() => {
    onChange(cellsToValue(r, cells));
    // onChange changes on every parent render; only cell changes matter here.
    // Callers set `key={instanceId}` so each instance starts with an empty grid.
  }, [cells]);

  const set = (i: number, v: string) => setCells((prev) => prev.map((c, j) => (j === i ? v : c)));

  if (r.kind === "choice")
    return (
      <fieldset className="options" disabled={disabled}>
        <legend>{label}</legend>
        {(instance.choices ?? []).map((c) => (
          <button
            key={c}
            type="button"
            className={`option${cells[0] === c ? " chosen" : ""}`}
            aria-pressed={cells[0] === c}
            onClick={() => set(0, c)}
          >
            <TextWithMath text={c} />
          </button>
        ))}
      </fieldset>
    );

  if (r.kind === "number" || r.kind === "expression") {
    const v = instance.variables[0] ?? "x";
    return (
      <div className="answer-text">
        <label className="field-label" htmlFor={id}>
          {label}
        </label>
        <input
          id={id}
          className="input input-math"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          disabled={disabled}
          value={cells[0] ?? ""}
          onChange={(e) => set(0, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && onSubmit) onSubmit();
          }}
          placeholder={r.kind === "expression" ? `expression in ${v}` : "number"}
        />
        {cells[0]?.trim() ? (
          <div className="view-prior" aria-live="polite">
            <MathView tex={sympyToTex(cells[0]!)} />
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="answer-grid" role="group" aria-label={label}>
      {Array.from({ length: r.rows }, (_, i) => (
        <div key={i} className="row-grid">
          {Array.from({ length: r.cols }, (_, j) => {
            const idx = i * r.cols + j;
            return (
              <input
                key={j}
                className="input input-math checkbox"
                inputMode="text"
                autoComplete="off"
                disabled={disabled}
                value={cells[idx] ?? ""}
                onChange={(e) => set(idx, e.target.value)}
                aria-label={`Row ${i + 1}, column ${j + 1}`}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}
