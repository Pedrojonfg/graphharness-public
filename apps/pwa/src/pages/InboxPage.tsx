// Inbox (ADR 102 §12): concepts without a subject, curator suggestions, failed templates,
// unknown errors not yet promoted and concepts without propositions.
import type { ConceptSuggestion, Inbox, Subject } from "@graphharness/contracts";
import { useState } from "react";
import { Link } from "react-router";
import { api } from "../api.ts";
import { WhenLoaded, ErrorBox, date, PageHeader, useLoadable } from "../components/Ui.tsx";
import { TextWithMath } from "../components/MathView.tsx";

export function InboxPage() {
  const inbox = useLoadable(() => api.inbox(), []);
  const subjects = useLoadable(() => api.subjects(), []);
  return (
    <main className="page page-narrow">
      <PageHeader title="Inbox" sub="What the Hub could not decide on its own." />
      <WhenLoaded loadable={inbox} text="Loading the inbox…">
        {(b) => <Content b={b} subjects={subjects.data?.filter((s) => !s.archivedAt) ?? []} onChanged={inbox.reload} />}
      </WhenLoaded>
    </main>
  );
}

function Content({ b, subjects, onChanged }: { b: Inbox; subjects: Subject[]; onChanged: () => void }) {
  const empty = !b.unassignedConcepts.length && !b.suggestions.length && !b.failedTemplates.length && !b.unknownErrors.length && !b.orphanConcepts.length;
  if (empty) return <p className="empty">The inbox is empty.</p>;
  return (
    <>
      {b.unassignedConcepts.length > 0 && (
        <section className="block">
          <h2>Concepts without a subject ({b.unassignedConcepts.length})</h2>
          <ul className="list-simple">
            {b.unassignedConcepts.map((c) => (
              <WithoutSubject key={c.conceptId} c={c} subjects={subjects} onDone={onChanged} />
            ))}
          </ul>
        </section>
      )}

      {b.suggestions.length > 0 && (
        <section className="block">
          <h2>Curator suggestions ({b.suggestions.length})</h2>
          <ul className="list-simple">
            {b.suggestions.map((s) => (
              <Suggestion key={s.id} s={s} onDone={onChanged} />
            ))}
          </ul>
        </section>
      )}

      {b.failedTemplates.length > 0 && (
        <section className="block">
          <h2>Methods that could not be automated ({b.failedTemplates.length})</h2>
          <ul className="list-simple">
            {b.failedTemplates.map((t) => (
              <li key={t.templateId}>
                <Link to={`/concepts/${t.conceptId}`}>{t.conceptName}</Link> <span className="muted">· {date(t.createdAt)}</span>
                {t.problems.length > 0 && (
                  <ul className="problems">
                    {t.problems.map((p, i) => (
                      <li key={i}>{p}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {b.unknownErrors.length > 0 && (
        <section className="block">
          <h2>Errors without a pattern ({b.unknownErrors.length})</h2>
          <ul className="list-simple">
            {b.unknownErrors.map((e) => (
              <li key={e.id}>
                <strong>{e.conceptName}</strong> <span className="muted">· {e.templateName} · {date(e.createdAt)}</span>
                <br />
                {e.hypothesis ? (
                  <span>
                    Hypothesis: <TextWithMath text={e.hypothesis.description} />{" "}
                    <span className="muted">{e.status === "rejected" ? "(does not reproduce)" : "(pending verification)"}</span>
                  </span>
                ) : (
                  <span className="muted">{e.status === "rejected" ? "No hypothesis reproduces it." : "Pending analysis."}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {b.orphanConcepts.length > 0 && (
        <section className="block">
          <h2>Concepts without propositions ({b.orphanConcepts.length})</h2>
          <ul className="list-simple">
            {b.orphanConcepts.map((c) => (
              <li key={c.conceptId}>
                <Link to={`/concepts/${c.conceptId}`}>{c.name}</Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function WithoutSubject({ c, subjects, onDone }: { c: Inbox["unassignedConcepts"][number]; subjects: Subject[]; onDone: () => void }) {
  const [subjectId, setSubjectId] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function assign() {
    if (!subjectId) return;
    setSending(true);
    setError(null);
    try {
      await api.patchConcept(c.conceptId, { subjectId });
      onDone();
    } catch (e) {
      setError(e);
      setSending(false);
    }
  }
  return (
    <li>
      <Link to={`/concepts/${c.conceptId}`}>{c.name}</Link> <span className="muted">· {c.propositionCount} propositions</span>
      {c.description && (
        <p className="muted">
          <TextWithMath text={c.description} />
        </p>
      )}
      <div className="row-form">
        <label className="sr-only" htmlFor={`as-${c.conceptId}`}>
          Subject for {c.name}
        </label>
        <select id={`as-${c.conceptId}`} className="input" value={subjectId} disabled={sending} onChange={(e) => setSubjectId(e.target.value)}>
          <option value="">Pick a subject…</option>
          {subjects.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <button type="button" className="btn btn-primary" disabled={!subjectId || sending} onClick={assign}>
          Assign
        </button>
      </div>
      <ErrorBox error={error} />
    </li>
  );
}

function Suggestion({ s, onDone }: { s: ConceptSuggestion; onDone: () => void }) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const n = (id: string) => s.conceptNames[id] ?? id;
  async function act(action: "accept" | "dismiss") {
    setSending(true);
    setError(null);
    try {
      if (action === "accept") await api.acceptSuggestion(s.id);
      else await api.dismissSuggestion(s.id);
      onDone();
    } catch (e) {
      setError(e);
      setSending(false);
    }
  }
  return (
    <li>
      {s.kind === "merge" ? (
        <p>
          Merge <strong>{s.sourceIds.map(n).join(", ")}</strong> into <strong>{n(s.targetId)}</strong>
        </p>
      ) : (
        <>
          <p>
            Split <strong>{n(s.conceptId)}</strong> into:
          </p>
          <ul className="problems">
            {s.parts.map((p, i) => (
              <li key={i}>
                {p.name} <span className="muted">({p.propositionIds.length} propositions)</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {s.rationale && <p className="muted">{s.rationale}</p>}
      <div className="actions">
        <button type="button" className="btn btn-primary" disabled={sending} onClick={() => void act("accept")}>
          Accept
        </button>
        <button type="button" className="btn btn-quiet" disabled={sending} onClick={() => void act("dismiss")}>
          Dismiss
        </button>
      </div>
      <ErrorBox error={error} />
    </li>
  );
}
