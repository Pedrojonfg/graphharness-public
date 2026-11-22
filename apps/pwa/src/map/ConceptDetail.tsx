// Concept detail (Map): state, propositions, templates, evidence history, errors and a manual
// state change with justification (PATCH /concepts/:id/state, weak-prerequisite warning GL-041).
import type { ConceptDetail, DeclarationRecorded, EvidenceSource, ManualTargetState, WeakPrerequisite } from "@graphharness/contracts";
import { useId, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { api, HubError } from "../api.ts";
import { TextWithMath } from "../components/MathView.tsx";
import { WhenLoaded, ErrorBox, StateChip, date, dateTime, pct, STATE_LABEL, useLoadable } from "../components/Ui.tsx";

const SOURCE: Record<EvidenceSource, string> = {
  lh_quiz: "Question in LearnHarness",
  lh_probe: "Probe in LearnHarness",
  lh_recall: "Free recall in LearnHarness",
  lh_practice: "Practice in LearnHarness",
  hub_exercise: "Exercise",
  hub_diagnostic: "Diagnostic",
  flashcard: "Card",
  declaration: "Declaration",
  confirmation: "Confirmation",
};

export function ConceptDetail({ conceptId, names, onChanged }: { conceptId: string; names?: Map<string, string>; onChanged?: () => void }) {
  const loadable = useLoadable(() => api.concept(conceptId), [conceptId]);
  return (
    <WhenLoaded loadable={loadable} text="Loading concept…">
      {(c) => (
        <Detail
          c={c}
          names={names}
          onChanged={() => {
            loadable.reload();
            onChanged?.();
          }}
        />
      )}
    </WhenLoaded>
  );
}

function Detail({ c, names, onChanged }: { c: ConceptDetail; names?: Map<string, string>; onChanged: () => void }) {
  const active = c.templates.filter((t) => t.status === "active");
  return (
    <div className="detail">
      <header className="detail-header">
        <h2>{c.name}</h2>
        <p className="detail-state">
          <StateChip state={c.state.state} pending={c.state.manualConfirmation === "pending"} />
          <span className="muted">
            P = {pct(c.state.probability)}
            {c.state.stale && " · no recent evidence"}
            {c.state.lastEvidenceAt && ` · last evidence ${date(c.state.lastEvidenceAt)}`}
          </span>
        </p>
        {c.subjectName && <p className="muted">{c.subjectName}</p>}
      </header>
      <DomainSnippet name={c.name} />
      {c.description && (
        <p>
          <TextWithMath text={c.description} />
        </p>
      )}

      {active.length > 0 && c.subjectId && (
        <p>
          <Link className="btn btn-primary" to={`/exercises?subject=${c.subjectId}&concept=${c.id}`}>
            Do exercises
          </Link>
        </p>
      )}

      <ManualChange c={c} names={names} onChanged={onChanged} />

      <section>
        <h3 className="section">Propositions ({c.propositions.length})</h3>
        {c.propositions.length === 0 ? (
          <p className="muted">No live propositions.</p>
        ) : (
          <ul className="list-simple">
            {c.propositions.map((p) => (
              <li key={p.id}>
                <TextWithMath text={p.statement || p.name} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3 className="section">Templates</h3>
        {c.templates.length === 0 ? (
          <p className="muted">No templates.</p>
        ) : (
          <ul className="list-simple">
            {c.templates.map((t) => (
              <li key={t.id}>
                <strong>{t.name}</strong> <span className="muted">· level {t.level}</span>
                {t.status !== "active" && <span className="muted"> · {t.status === "failed" ? "could not be automated" : "retired"}</span>}
                {t.methodSummary && (
                  <details>
                    <summary>Method sheet</summary>
                    <div className="summary">
                      {t.methodSummary.split("\n").map((l, i) => (
                        <p key={i}>
                          <TextWithMath text={l} />
                        </p>
                      ))}
                      {t.methodLimits && (
                        <p className="muted">
                          Limits: <TextWithMath text={t.methodLimits} />
                        </p>
                      )}
                    </div>
                  </details>
                )}
                {t.status === "active" && c.subjectId && (
                  <Link className="link-action" to={`/exercises?subject=${c.subjectId}&concept=${c.id}&template=${t.id}`}>
                    Practice this method
                  </Link>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3 className="section">Evidence history</h3>
        {c.recentEvidence.length === 0 ? (
          <p className="muted">No evidence yet.</p>
        ) : (
          <ul className="history">
            {c.recentEvidence.map((e) => (
              <li key={e.id}>
                <span className={`result-dot ${e.correct === null ? "" : e.correct ? "good" : "bad"}`} aria-hidden="true" />
                <span>
                  {SOURCE[e.source]}
                  {e.correct !== null && (e.correct ? ": correct" : ": incorrect")}
                  {e.targetState && `: ${STATE_LABEL[e.targetState]}`}
                  {e.inferred && <span className="muted"> (judged by LLM)</span>}
                  {e.justification && <span className="muted"> — "{e.justification}"</span>}
                </span>
                <span className="muted history-date">{dateTime(e.at)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {c.errors.length > 0 && (
        <section>
          <h3 className="section">Errors</h3>
          <ul className="list-simple">
            {c.errors.map((e) => (
              <li key={e.id}>
                <TextWithMath text={e.description} />{" "}
                <span className="muted">
                  · {e.origin === "personal" ? "personal" : "typical"} · seen {e.timesSeen} {e.timesSeen === 1 ? "time" : "times"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <Lenses conceptId={c.id} />

      <Notes c={c} onChanged={onChanged} />

      <details className="block-advanced">
        <summary>Capture card</summary>
        <CaptureCard conceptId={c.id} />
      </details>
      <details className="block-advanced">
        <summary>Merge into this concept</summary>
        <Merge conceptId={c.id} onChanged={onChanged} />
      </details>
      <details className="block-advanced">
        <summary>Split concept</summary>
        <Split c={c} onChanged={onChanged} />
      </details>
      <details className="block-advanced">
        <summary>"Requires" edges</summary>
        <Edges conceptId={c.id} onChanged={onChanged} />
      </details>
    </div>
  );
}

function DomainSnippet({ name }: { name: string }) {
  const loadable = useLoadable(() => api.mastery(name), [name]);
  return (
    <WhenLoaded loadable={loadable} text="Mastery…">
      {(m) => {
        const x = m.concepts[0];
        if (!x) return null;
        return (
          <p className="muted">
            Mastery (lookup): <StateChip state={x.state} />
            {x.stale && " · no recent evidence"}
          </p>
        );
      }}
    </WhenLoaded>
  );
}

/** ADR 109: lenses that worked for the learner (LH votes, read-only); with no votes nothing is rendered. */
function Lenses({ conceptId }: { conceptId: string }) {
  const loadable = useLoadable(() => api.lensFeedback(conceptId), [conceptId]);
  return (
    <WhenLoaded loadable={loadable} text="Lenses…">
      {(r) =>
        r.lenses.length === 0 ? null : (
          <section>
            <h3 className="section">Lenses</h3>
            <ul className="list-simple">
              {r.lenses.map((l) => (
                <li key={l.label}>
                  {l.label} <span className="muted">· helped you {l.likedCount} of {l.shownCount} {l.shownCount === 1 ? "time" : "times"}</span>
                </li>
              ))}
            </ul>
          </section>
        )
      }
    </WhenLoaded>
  );
}

function Notes({ c, onChanged }: { c: ConceptDetail; onChanged: () => void }) {
  const id = useId();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    const t = text.trim();
    if (!t || sending) return;
    setSending(true);
    setError(null);
    try {
      await api.addConceptNote(c.id, t);
      setText("");
      onChanged();
    } catch (err) {
      setError(err);
    } finally {
      setSending(false);
    }
  }

  return (
    <section>
      <h3 className="section">Notes</h3>
      {c.notes.length === 0 ? <p className="muted">No notes.</p> : (
        <ul className="list-simple">
          {c.notes.map((n) => (
            <li key={n.id}>
              <TextWithMath text={n.text} /> <span className="muted">· {date(n.createdAt)}</span>
            </li>
          ))}
        </ul>
      )}
      <form className="form" onSubmit={(e) => void save(e)}>
        <label className="field-label" htmlFor={`${id}-note`}>
          Add note
        </label>
        <textarea id={`${id}-note`} className="input" rows={2} value={text} disabled={sending} onChange={(e) => setText(e.target.value)} />
        <ErrorBox error={error} />
        <button type="submit" className="btn btn-quiet" disabled={sending || !text.trim()}>
          {sending ? "Saving…" : "Save note"}
        </button>
      </form>
    </section>
  );
}

function CaptureCard({ conceptId }: { conceptId: string }) {
  const id = useId();
  const [type, setType] = useState<"text" | "cloze">("text");
  const [front, setFront] = useState("");
  const [answer, setAnswer] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<string | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (sending) return;
    setSending(true);
    setError(null);
    setDone(null);
    try {
      const r = await api.capture({ kind: "card", conceptId, type: type, front: front.trim(), answer: answer.trim() });
      setDone(r.conceptName);
      setFront("");
      setAnswer("");
    } catch (err) {
      setError(err);
    } finally {
      setSending(false);
    }
  }

  return (
    <form className="form" onSubmit={(e) => void save(e)}>
      <label className="field-label" htmlFor={`${id}-type`}>
        Type
      </label>
      <select id={`${id}-type`} className="input" value={type} disabled={sending} onChange={(e) => setType(e.target.value as "text" | "cloze")}>
        <option value="text">Text</option>
        <option value="cloze">Cloze</option>
      </select>
      <label className="field-label" htmlFor={`${id}-front`}>
        Front
      </label>
      <textarea id={`${id}-front`} className="input" rows={2} required value={front} disabled={sending} onChange={(e) => setFront(e.target.value)} />
      <label className="field-label" htmlFor={`${id}-resp`}>
        Answer
      </label>
      <input id={`${id}-resp`} className="input" required value={answer} disabled={sending} onChange={(e) => setAnswer(e.target.value)} />
      {done && <p className="muted" role="status">Card created in "{done}".</p>}
      <ErrorBox error={error} />
      <button type="submit" className="btn btn-quiet" disabled={sending}>
        {sending ? "Creating…" : "Create card"}
      </button>
    </form>
  );
}

function Merge({ conceptId, onChanged }: { conceptId: string; onChanged: () => void }) {
  const id = useId();
  const [ids, setIds] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    const sourceIds = [...new Set(ids.split(",").map((x) => x.trim()).filter(Boolean))];
    if (!sourceIds.length || sending) return;
    setSending(true);
    setError(null);
    try {
      await api.mergeConcepts(conceptId, { sourceIds });
      setIds("");
      onChanged();
    } catch (err) {
      setError(err);
    } finally {
      setSending(false);
    }
  }

  return (
    <form className="form" onSubmit={(e) => void save(e)}>
      <label className="field-label" htmlFor={`${id}-merge`}>
        IDs of concepts to merge here (comma-separated)
      </label>
      <textarea id={`${id}-merge`} className="input" rows={2} value={ids} disabled={sending} onChange={(e) => setIds(e.target.value)} />
      <ErrorBox error={error} />
      <button type="submit" className="btn btn-quiet" disabled={sending || !ids.trim()}>
        {sending ? "Merging…" : "Merge"}
      </button>
    </form>
  );
}

type PartSplit = { name: string; description: string; props: string };

function Split({ c, onChanged }: { c: ConceptDetail; onChanged: () => void }) {
  const empty = (): PartSplit => ({ name: "", description: "", props: "" });
  const [parts, setParts] = useState<PartSplit[]>([empty(), empty()]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const idsProp = c.propositions.map((p) => p.id).join(", ");

  function setPart(i: number, patch: Partial<PartSplit>) {
    setParts((prev) => prev.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (sending) return;
    setSending(true);
    setError(null);
    try {
      await api.splitConcept(c.id, {
        parts: parts.map((p) => ({
          name: p.name.trim(),
          description: p.description.trim(),
          propositionIds: [...new Set(p.props.split(",").map((x) => x.trim()).filter(Boolean))],
        })),
      });
      onChanged();
    } catch (err) {
      setError(err);
    } finally {
      setSending(false);
    }
  }

  return (
    <form className="form" onSubmit={(e) => void save(e)}>
      <p className="muted">Proposition IDs: {idsProp || "none"}</p>
      {parts.map((p, i) => (
        <fieldset key={i} disabled={sending}>
          <legend>Part {i + 1}</legend>
          <input className="input" placeholder="Name" required value={p.name} onChange={(e) => setPart(i, { name: e.target.value })} />
          <textarea className="input" rows={2} placeholder="Description" required value={p.description} onChange={(e) => setPart(i, { description: e.target.value })} />
          <input className="input" placeholder="Proposition IDs (commas)" required value={p.props} onChange={(e) => setPart(i, { props: e.target.value })} />
        </fieldset>
      ))}
      {parts.length < 10 && (
        <button type="button" className="btn btn-quiet" disabled={sending} onClick={() => setParts((prev) => [...prev, empty()])}>
          Another part
        </button>
      )}
      <ErrorBox error={error} />
      <button type="submit" className="btn btn-quiet" disabled={sending}>
        {sending ? "Splitting…" : "Split"}
      </button>
    </form>
  );
}

function Edges({ conceptId, onChanged }: { conceptId: string; onChanged: () => void }) {
  const id = useId();
  const [mode, setMode] = useState<"add" | "remove">("add");
  const [from, setFrom] = useState(conceptId);
  const [to, setTo] = useState("");
  const [reason, setReason] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    const edge = { from: from.trim(), to: to.trim(), justification: reason.trim() };
    if (!edge.from || !edge.to || !edge.justification || sending) return;
    setSending(true);
    setError(null);
    try {
      await api.patchConceptEdges(mode === "add" ? { add: [{ ...edge, relation: "requires" }], remove: [] } : { add: [], remove: [edge] });
      setReason("");
      setTo("");
      onChanged();
    } catch (err) {
      setError(err);
    } finally {
      setSending(false);
    }
  }

  return (
    <form className="form" onSubmit={(e) => void save(e)}>
      <span className="segmented" role="radiogroup" aria-label="Action">
        <label className={`segment${mode === "add" ? " chosen" : ""}`}>
          <input type="radio" name={`${id}-mode`} checked={mode === "add"} onChange={() => setMode("add")} />
          Add
        </label>
        <label className={`segment${mode === "remove" ? " chosen" : ""}`}>
          <input type="radio" name={`${id}-mode`} checked={mode === "remove"} onChange={() => setMode("remove")} />
          Remove
        </label>
      </span>
      <label className="field-label" htmlFor={`${id}-from`}>
        From
      </label>
      <input id={`${id}-from`} className="input" value={from} disabled={sending} onChange={(e) => setFrom(e.target.value)} />
      <label className="field-label" htmlFor={`${id}-to`}>
        To
      </label>
      <input id={`${id}-to`} className="input" required value={to} disabled={sending} onChange={(e) => setTo(e.target.value)} />
      <label className="field-label" htmlFor={`${id}-reason-edge`}>
        Reason
      </label>
      <textarea id={`${id}-reason-edge`} className="input" rows={2} required value={reason} disabled={sending} onChange={(e) => setReason(e.target.value)} />
      <ErrorBox error={error} />
      <button type="submit" className="btn btn-quiet" disabled={sending}>
        {sending ? "Saving…" : "Apply"}
      </button>
    </form>
  );
}

const GOALS: { value: ManualTargetState; label: string }[] = [
  { value: "solid", label: "I have mastered it" },
  { value: "review", label: "I need to review it" },
  { value: "weak", label: "I don't know it" },
];

function ManualChange({ c, names, onChanged }: { c: ConceptDetail; names?: Map<string, string>; onChanged: () => void }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<ManualTargetState>("solid");
  const [reason, setReason] = useState("");
  const [weak, setWeak] = useState<WeakPrerequisite[] | null>(null);
  const [done, setDone] = useState<DeclarationRecorded | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function save(ack: boolean) {
    if (!reason.trim()) return setError(new Error("Write why you are changing the state."));
    setSending(true);
    setError(null);
    try {
      const r = await api.setConceptState(c.id, { targetState: target, justification: reason.trim(), ...(ack ? { ackWeakPrerequisites: true } : {}) });
      setWeak(null);
      setDone(r);
      setReason("");
      onChanged();
    } catch (e) {
      if (e instanceof HubError && e.weakPrerequisites) setWeak(e.weakPrerequisites);
      else setError(e);
    } finally {
      setSending(false);
    }
  }

  const name = (cid: string) => names?.get(cid) ?? (cid === c.id ? c.name : cid);

  if (done)
    return (
      <div className="result result-good" role="status">
        <p className="result-title">Change recorded, pending confirmation</p>
        {done.confirmationItems.length > 0 ? (
          <>
            <p>
              {done.confirmationItems.length === 1 ? "One confirmation question" : `${done.confirmationItems.length} confirmation questions`} will arrive in
              Cards, marked and at the front of the queue:
            </p>
            <ul className="list-simple">
              {done.confirmationItems.map((it) => (
                <li key={it.itemId}>
                  <TextWithMath text={it.front.text ?? it.front.instance?.statement ?? ""} />
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p>There are no confirmation questions for this concept.</p>
        )}
        <button type="button" className="btn btn-quiet" onClick={() => setDone(null)}>
          Done
        </button>
      </div>
    );

  if (!open)
    return (
      <p>
        <button type="button" className="btn btn-quiet" onClick={() => setOpen(true)}>
          Change the state manually
        </button>
      </p>
    );

  return (
    <form
      className="form change-manual"
      onSubmit={(e) => {
        e.preventDefault();
        void save(false);
      }}
    >
      <fieldset disabled={sending}>
        <legend>Change the state manually</legend>
        <div className="segmented" role="radiogroup" aria-label="New state">
          {GOALS.map((o) => (
            <label key={o.value} className={`segment${target === o.value ? " chosen" : ""}`}>
              <input type="radio" name={`${id}-target`} value={o.value} checked={target === o.value} onChange={() => setTarget(o.value)} />
              {o.label}
            </label>
          ))}
        </div>
        <label className="field-label" htmlFor={`${id}-reason`}>
          Why (required)
        </label>
        <textarea
          id={`${id}-reason`}
          className="input"
          rows={3}
          maxLength={500}
          required
          value={reason}
          placeholder="e.g. We covered it in class and I found the eigenvalues unaided"
          onChange={(e) => setReason(e.target.value)}
        />
      </fieldset>

      {weak && (
        <div className="notice-block" role="alert">
          <p className="result-title">There are weak prerequisites</p>
          <ul className="list-simple">
            {weak.map((w) => (
              <li key={w.conceptId}>
                <strong>{w.name}</strong> <StateChip state={w.state} />
                <br />
                <span className="muted">{w.path.map(name).join(" → ")}</span>
              </li>
            ))}
          </ul>
          <p>Record it anyway?</p>
          <div className="actions">
            <button type="button" className="btn btn-primary" disabled={sending} onClick={() => void save(true)}>
              Record anyway
            </button>
            <button type="button" className="btn btn-quiet" onClick={() => setWeak(null)}>
              Review first
            </button>
          </div>
        </div>
      )}
      <ErrorBox error={error} />
      {!weak && (
        <div className="actions">
          <button type="submit" className="btn btn-primary" disabled={sending}>
            {sending ? "Saving…" : "Save"}
          </button>
          <button type="button" className="btn btn-quiet" onClick={() => setOpen(false)}>
            Cancel
          </button>
        </div>
      )}
    </form>
  );
}
