// Exams (D12): list with P(prepared), create, edit, delete and "Prepare" (diagnostic).
import type { Exam, Subject } from "@graphharness/contracts";
import { useId, useState } from "react";
import { Link } from "react-router";
import { api } from "../api.ts";
import { WhenLoaded, daysText, ErrorBox, date, pct, PageHeader, useLoadable } from "../components/Ui.tsx";

export function ExamsPage() {
  const exams = useLoadable(() => api.exams(), []);
  const subjects = useLoadable(() => api.subjects(), []);
  const [editing, setEditing] = useState<Exam | "new" | null>(null);

  return (
    <main className="page page-narrow">
      <PageHeader
        title="Exams"
        accessory={
          editing === null && (
            <button type="button" className="btn btn-primary" onClick={() => setEditing("new")}>
              Add exam
            </button>
          )
        }
      />
      {editing !== null && (
        <WhenLoaded loadable={subjects}>
          {(ss) => (
            <ExamForm
              exam={editing === "new" ? null : editing}
              subjects={ss.filter((s) => !s.archivedAt)}
              onDone={() => {
                setEditing(null);
                exams.reload();
              }}
              onCancel={() => setEditing(null)}
            />
          )}
        </WhenLoaded>
      )}
      <WhenLoaded loadable={exams} text="Loading exams…">
        {(list) =>
          list.length === 0 ? (
            <p className="empty">No exams. Add them here or ask the agent; the date sets the first card review.</p>
          ) : (
            <ul className="list">
              {list.map((e) => (
                <li key={e.id} className={`exam${e.daysLeft < 0 ? " exam-past" : ""}`}>
                  <div className="exam-body">
                    <p className="row-title">{e.title}</p>
                    <p className="muted">
                      {e.subjectName} · {date(e.date)}, {daysText(e.daysLeft)}
                    </p>
                    <p className="muted">
                      {e.scopeConceptIds.length ? `${e.scopeConceptIds.length} concepts` : "Whole subject"}
                      {e.unknownCount > 0 && ` · ${e.unknownCount} no record`}
                    </p>
                  </div>
                  <div className="exam-prep">
                    <span className="prepared" title="Probability of being prepared">
                      {pct(e.preparedProbability)}
                    </span>
                    <span className="muted">prepared</span>
                  </div>
                  <div className="actions exam-actions">
                    {e.daysLeft >= 0 && (
                      <Link className="btn btn-primary" to={`/exams/${e.id}/prepare`}>
                        Prepare
                      </Link>
                    )}
                    <button type="button" className="btn btn-quiet" onClick={() => setEditing(e)}>
                      Edit
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )
        }
      </WhenLoaded>
    </main>
  );
}

function ExamForm({ exam, subjects, onDone, onCancel }: { exam: Exam | null; subjects: Subject[]; onDone: () => void; onCancel: () => void }) {
  const id = useId();
  const [subjectId, setSubjectId] = useState(exam?.subjectId ?? subjects[0]?.id ?? "");
  const [title, setTitle] = useState(exam?.title ?? "");
  const [date, setDate] = useState(exam?.date ?? "");
  const [notes, setNotes] = useState(exam?.notes ?? "");
  const [scope, setScope] = useState<Set<string>>(() => new Set(exam?.scopeConceptIds ?? []));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const map = useLoadable(() => (subjectId ? api.subjectMap(subjectId) : Promise.resolve(null)), [subjectId]);

  async function save() {
    setSending(true);
    setError(null);
    try {
      const scopeConceptIds = [...scope];
      if (exam) await api.patchExam(exam.id, { title, date, scopeConceptIds, notes: notes.trim() ? notes : null });
      else await api.createExam({ subjectId, title, date, scopeConceptIds, ...(notes.trim() ? { notes } : {}) });
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setSending(false);
    }
  }

  async function remove() {
    if (!exam || !window.confirm(`Delete "${exam.title}"?`)) return;
    setSending(true);
    try {
      await api.deleteExam(exam.id);
      onDone();
    } catch (e) {
      setError(e);
      setSending(false);
    }
  }

  if (!subjects.length) return <p className="empty">You need a subject first.</p>;

  return (
    <form
      className="form block"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h2>{exam ? "Edit exam" : "New exam"}</h2>
      <fieldset disabled={sending}>
        <label className="field-label" htmlFor={`${id}-s`}>
          Subject
        </label>
        <select
          id={`${id}-s`}
          className="input"
          value={subjectId}
          disabled={exam !== null}
          onChange={(e) => {
            setSubjectId(e.target.value);
            setScope(new Set());
          }}
        >
          {subjects.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <label className="field-label" htmlFor={`${id}-t`}>
          Title
        </label>
        <input id={`${id}-t`} className="input" required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Diagonalization midterm" />
        <label className="field-label" htmlFor={`${id}-d`}>
          Date
        </label>
        <input id={`${id}-d`} className="input" type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
        <details className="scope">
          <summary>Scope: {scope.size ? `${scope.size} concepts` : "whole subject"}</summary>
          <WhenLoaded loadable={map}>
            {(m) =>
              !m || m.concepts.length === 0 ? (
                <p className="muted">The subject has no concepts.</p>
              ) : (
                <ul className="checks">
                  {[...m.concepts]
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map((c) => (
                      <li key={c.id}>
                        <label className="check">
                          <input
                            type="checkbox"
                            checked={scope.has(c.id)}
                            onChange={(e) =>
                              setScope((prev) => {
                                const n = new Set(prev);
                                if (e.target.checked) n.add(c.id);
                                else n.delete(c.id);
                                return n;
                              })
                            }
                          />
                          {c.name}
                        </label>
                      </li>
                    ))}
                </ul>
              )
            }
          </WhenLoaded>
        </details>
        <label className="field-label" htmlFor={`${id}-n`}>
          Notes (optional)
        </label>
        <textarea id={`${id}-n`} className="input" rows={2} maxLength={5000} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </fieldset>
      <ErrorBox error={error} />
      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={sending}>
          {sending ? "Saving…" : exam ? "Save changes" : "Add exam"}
        </button>
        <button type="button" className="btn btn-quiet" onClick={onCancel}>
          Cancel
        </button>
        {exam && (
          <button type="button" className="btn btn-danger" disabled={sending} onClick={remove}>
            Delete
          </button>
        )}
      </div>
    </form>
  );
}
