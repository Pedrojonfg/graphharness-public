import type { ParsonsLine } from "@graphharness/contracts";
import { visibleDistractorCount } from "@graphharness/core";
import type { ReactNode } from "react";

export type ParsonsBoardProps = {
  lines: ParsonsLine[];
  /** Failures in this session (adaptive distractors). */
  failCount: number;
  order: string[];
  onOrderChange: (order: string[]) => void;
  trash: string[];
  onTrashChange: (trash: string[]) => void;
  disabled?: boolean;
};

function lineById(lines: ParsonsLine[]): Map<string, ParsonsLine> {
  return new Map(lines.map((l) => [l.id, l]));
}

function visibleDistractors(lines: ParsonsLine[], failCount: number): Set<string> {
  const ds = lines.filter((l) => l.distractor);
  const n = visibleDistractorCount(ds.length, failCount);
  return new Set(ds.slice(0, n).map((l) => l.id));
}

export function ParsonsBoard({ lines, failCount, order, onOrderChange, trash, onTrashChange, disabled }: ParsonsBoardProps) {
  const byId = lineById(lines);
  const shownDistractors = visibleDistractors(lines, failCount);
  const inPlay = new Set([...order, ...trash]);
  const pool = lines.filter(
    (l) => !inPlay.has(l.id) && (!l.distractor || shownDistractors.has(l.id)),
  );

  function moveUp(i: number) {
    if (disabled || i <= 0) return;
    const next = [...order];
    [next[i - 1], next[i]] = [next[i], next[i - 1]];
    onOrderChange(next);
  }

  function moveDown(i: number) {
    if (disabled || i >= order.length - 1) return;
    const next = [...order];
    [next[i], next[i + 1]] = [next[i + 1], next[i]];
    onOrderChange(next);
  }

  function addToSolution(id: string) {
    if (disabled || inPlay.has(id)) return;
    onOrderChange([...order, id]);
  }

  function removeFromSolution(id: string) {
    if (disabled) return;
    onOrderChange(order.filter((x) => x !== id));
  }

  function toTrash(id: string) {
    const line = byId.get(id);
    if (disabled || !line?.distractor) return;
    onOrderChange(order.filter((x) => x !== id));
    if (!trash.includes(id)) onTrashChange([...trash, id]);
  }

  function restoreFromTrash(id: string) {
    if (disabled) return;
    onTrashChange(trash.filter((x) => x !== id));
  }

  return (
    <div className="parsons">
      <section className="parsons-zone" aria-labelledby="parsons-pool">
        <h3 className="parsons-title" id="parsons-pool">
          Lines
        </h3>
        {pool.length === 0 ? (
          <p className="muted">All lines are in the solution or discarded.</p>
        ) : (
          <ul className="parsons-list">
            {pool.map((l) => (
              <LineRow key={l.id} line={l}>
                <button type="button" className="btn btn-quiet btn-compact" disabled={disabled} onClick={() => addToSolution(l.id)}>
                  Add
                </button>
                {l.distractor && (
                  <button type="button" className="btn btn-quiet btn-compact" disabled={disabled} onClick={() => toTrash(l.id)} title="Discard distractor">
                    Trash
                  </button>
                )}
              </LineRow>
            ))}
          </ul>
        )}
      </section>

      <section className="parsons-zone" aria-labelledby="parsons-solution">
        <h3 className="parsons-title" id="parsons-solution">
          Solution (order)
        </h3>
        {order.length === 0 ? (
          <p className="muted">Add lines in the correct order.</p>
        ) : (
          <ol className="parsons-list parsons-order">
            {order.map((id, i) => {
              const l = byId.get(id);
              if (!l) return null;
              return (
                <LineRow key={id} line={l}>
                  <span className="parsons-actions">
                    <button type="button" className="btn btn-quiet btn-compact" disabled={disabled || i === 0} onClick={() => moveUp(i)} aria-label="Move up">
                      ↑
                    </button>
                    <button
                      type="button"
                      className="btn btn-quiet btn-compact"
                      disabled={disabled || i === order.length - 1}
                      onClick={() => moveDown(i)}
                      aria-label="Move down"
                    >
                      ↓
                    </button>
                    <button type="button" className="btn btn-quiet btn-compact" disabled={disabled} onClick={() => removeFromSolution(id)}>
                      Remove
                    </button>
                  </span>
                </LineRow>
              );
            })}
          </ol>
        )}
      </section>

      {trash.length > 0 && (
        <section className="parsons-zone parsons-trash" aria-labelledby="parsons-trash">
          <h3 className="parsons-title" id="parsons-trash">
            Discarded
          </h3>
          <ul className="parsons-list">
            {trash.map((id) => {
              const l = byId.get(id);
              if (!l) return null;
              return (
                <LineRow key={id} line={l} muted>
                  <button type="button" className="btn btn-quiet btn-compact" disabled={disabled} onClick={() => restoreFromTrash(id)}>
                    Restore
                  </button>
                </LineRow>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}

function LineRow({ line, children, muted }: { line: ParsonsLine; children?: ReactNode; muted?: boolean }) {
  return (
    <li className={`parsons-line${muted ? " parsons-line-muted" : ""}`}>
      <code className="parsons-code" style={{ paddingLeft: `${line.indent * 0.75}rem` }}>
        {line.text}
      </code>
      {children && <div className="parsons-line-actions">{children}</div>}
    </li>
  );
}
