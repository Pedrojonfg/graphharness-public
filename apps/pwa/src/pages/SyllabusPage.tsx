// Syllabus (ADR 105 §6): the outline of each subject, with which topics you have seen and how they are doing.
import type { Syllabus } from "@graphharness/contracts";
import { useId, useState } from "react";
import { api } from "../api.ts";
import { WhenLoaded, ErrorBox, StateChip, PageHeader, useLoadable } from "../components/Ui.tsx";

export function SyllabusPage() {
  const subjects = useLoadable(() => api.subjects(), []);
  const [subjectId, setSubjectId] = useState("");
  const id = useId();
  return (
    <main className="page page-narrow">
      <PageHeader title="Syllabus" sub="The subject outline: one topic per line, and indentation sets the level." />
      <WhenLoaded loadable={subjects} text="Loading subjects…">
        {(list) =>
          list.length === 0 ? (
            <p className="empty">No subjects yet.</p>
          ) : (
            <>
              <label className="field-label" htmlFor={`${id}-s`}>
                Subject
              </label>
              <select id={`${id}-s`} className="input" value={subjectId} onChange={(e) => setSubjectId(e.target.value)}>
                <option value="">Pick a subject</option>
                {list.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              {/* key: changing subject discards the text being edited */}
              {subjectId && <SyllabusOf key={subjectId} subjectId={subjectId} />}
            </>
          )
        }
      </WhenLoaded>
    </main>
  );
}

/** The saved syllabus as editable text: two spaces of indentation per level. */
const asText = (t: Syllabus) => t.items.map((i) => `${"  ".repeat(i.level)}${i.title}`).join("\n");

function SyllabusOf({ subjectId }: { subjectId: string }) {
  const loadable = useLoadable(() => api.syllabus(subjectId), [subjectId]);
  // null = untouched: the saved syllabus is shown. After saving, what was typed is kept so lines with errors can be fixed.
  const [text, setText] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<{ count: number; errors: string[] } | null>(null);
  const id = useId();
  const value = text ?? (loadable.data ? asText(loadable.data) : "");

  async function save() {
    setSaving(true);
    setError(null);
    try {
      setResult(await api.putSyllabus(subjectId, value));
      loadable.reload();
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <WhenLoaded loadable={loadable} text="Loading the syllabus…">
        {(t) => (
          <section className="block" aria-labelledby={`${id}-h`}>
            <h2 id={`${id}-h`}>
              {t.items.filter((i) => i.seen).length} of {t.items.length} topics seen
            </h2>
            <ul className="list-simple">
              {t.items.map((i) => (
                <li key={i.id} style={{ paddingLeft: `${i.level}rem` }}>
                  {i.title}{" "}
                  {i.seen ? (
                    <>
                      <span className="muted">seen</span> {i.state && <StateChip state={i.state} />}
                      {i.stale && <span className="muted"> · no recent evidence</span>}
                    </>
                  ) : (
                    <span className="muted">unseen</span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
      </WhenLoaded>
      <BlanksSyllabus subjectId={subjectId} />
      {loadable.data && (
        <>
          <label className="field-label" htmlFor={`${id}-t`}>
            Syllabus (one topic per line)
          </label>
          <textarea id={`${id}-t`} className="input" rows={10} maxLength={200000} value={value} onChange={(e) => setText(e.target.value)} />
          <div className="actions">
            <button type="button" className="btn btn-primary" disabled={saving || value.trim() === ""} onClick={save}>
              {saving ? "Saving…" : "Save syllabus"}
            </button>
          </div>
          <ErrorBox error={error} />
          {result && result.errors.length > 0 && (
            <div className="notice-block">
              <p>
                Saved {result.count} topics, but some lines could not be read:
              </p>
              <ul className="problems">
                {result.errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </div>
          )}
          {result && result.errors.length === 0 && <p role="status">Syllabus saved ({result.count} topics).</p>}
        </>
      )}
    </>
  );
}

function BlanksSyllabus({ subjectId }: { subjectId: string }) {
  const loadable = useLoadable(() => api.syllabusGaps(subjectId), [subjectId]);
  return (
    <WhenLoaded loadable={loadable} text="Loading syllabus gaps…">
      {(g) =>
        g.unseen.length === 0 ? (
          <p className="muted">No syllabus topics left unseen.</p>
        ) : (
          <section className="block">
            <h2>
              Unseen topics ({g.unseen.length} of {g.total})
            </h2>
            <ul className="list-simple">
              {g.unseen.map((t, i) => (
                <li key={i} style={{ paddingLeft: `${t.level}rem` }}>
                  {t.title}
                </li>
              ))}
            </ul>
          </section>
        )
      }
    </WhenLoaded>
  );
}
