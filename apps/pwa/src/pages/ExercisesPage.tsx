// Deterministic exercises (GL-010): subject → concept → template (method) →
// instance → answer → grading → hint → steps → optional explanation (with dictation).
import type {
  AnswerValue,
  CodeComprehensionGiven,
  ConceptState,
  Exercise,
  ExerciseAttemptResponse,
  ExerciseExplanation,
  ExerciseHintResponse,
} from "@graphharness/contracts";
import { isCodeClientInstance, isRecipeClientInstance } from "@graphharness/contracts";
import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { api } from "../api.ts";
import { Dictation } from "../components/Dictation.tsx";
import { Paragraphs, TextWithMath, Value } from "../components/MathView.tsx";
import { ParsonsBoard } from "../components/ParsonsBoard.tsx";
import { missingText, AnswerInput } from "../components/AnswerInput.tsx";
import { Loading, WhenLoaded, ErrorBox, StateChip, PageHeader, useLoadable } from "../components/Ui.tsx";

const ORDER: Record<ConceptState, number> = { weak: 0, review: 1, unknown: 2, solid: 3 };

export function ExercisesPage() {
  const [params, setParams] = useSearchParams();
  const subject = params.get("subject");
  const concept = params.get("concept");
  const template = params.get("template");

  const ir = (p: Record<string, string | null>, replace = false) => {
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries({ subject, concept, template, ...p })) if (v) next.set(k, v);
    setParams(next, { replace });
  };

  return (
    <main className="page page-narrow">
      <PageHeader title="Exercises" sub="Exercises generated from your templates, graded by eval." />
      <nav className="crumbs" aria-label="Steps">
        <button type="button" className="crumb" onClick={() => ir({ subject: null, concept: null, template: null })}>
          Subjects
        </button>
        {subject && (
          <button type="button" className="crumb" onClick={() => ir({ concept: null, template: null })}>
            Concepts
          </button>
        )}
        {concept && (
          <button type="button" className="crumb" onClick={() => ir({ template: null })}>
            Methods
          </button>
        )}
      </nav>
      {!subject && !concept && <ChooseSubject onPick={(id) => ir({ subject: id })} />}
      {concept && !subject && <ResolveSubject conceptId={concept} onResolved={(id) => ir({ subject: id }, true)} />}
      {subject && !concept && <ChooseConcept subjectId={subject} onPick={(id) => ir({ concept: id })} />}
      {subject && concept && !template && <ChooseMethod conceptId={concept} onPick={(id, auto) => ir({ template: id }, auto)} />}
      {template && <ExerciseTemplate key={template} templateId={template} />}
    </main>
  );
}

function ChooseSubject({ onPick }: { onPick: (id: string) => void }) {
  const loadable = useLoadable(() => api.subjects(), []);
  return (
    <WhenLoaded loadable={loadable}>
      {(subjects) => {
        const active = subjects.filter((s) => !s.archivedAt);
        if (!active.length) return <p className="empty">No subjects yet. The agent creates them, or they appear when LearnHarness is synced.</p>;
        return (
          <ul className="list">
            {active.map((s) => (
              <li key={s.id}>
                <button type="button" className="row row-button" onClick={() => onPick(s.id)}>
                  <span className="row-title">{s.name}</span>
                  <span className="muted">
                    {s.kind === "computable_math"
                      ? "With computable exercises"
                      : s.kind === "programming"
                        ? "Programming"
                        : "General"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        );
      }}
    </WhenLoaded>
  );
}

function ResolveSubject({ conceptId, onResolved }: { conceptId: string; onResolved: (subjectId: string) => void }) {
  const loadable = useLoadable(() => api.concept(conceptId), [conceptId]);
  useEffect(() => {
    if (loadable.data?.subjectId) onResolved(loadable.data.subjectId);
  }, [loadable.data]);
  if (loadable.data && !loadable.data.subjectId) return <p className="empty">This concept has no subject. Assign one from the Inbox.</p>;
  return <WhenLoaded loadable={loadable}>{() => <Loading />}</WhenLoaded>;
}

function ChooseConcept({ subjectId, onPick }: { subjectId: string; onPick: (id: string) => void }) {
  const loadable = useLoadable(() => api.subjectMap(subjectId), [subjectId]);
  return (
    <WhenLoaded loadable={loadable}>
      {(map) => {
        const withTemplate = map.concepts.filter((c) => c.templateCount > 0).sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.name.localeCompare(b.name));
        if (!withTemplate.length)
          return <p className="empty">No concept of {map.subject.name} has an active template yet. Templates are generated for computable concepts.</p>;
        return (
          <>
            <h2 className="section">{map.subject.name}</h2>
            <ul className="list">
              {withTemplate.map((c) => (
                <li key={c.id}>
                  <button type="button" className="row row-button" onClick={() => onPick(c.id)}>
                    <span className="row-title">{c.name}</span>
                    <StateChip state={c.state} pending={c.manualConfirmation === "pending"} />
                  </button>
                </li>
              ))}
            </ul>
          </>
        );
      }}
    </WhenLoaded>
  );
}

function ChooseMethod({ conceptId, onPick }: { conceptId: string; onPick: (templateId: string, auto: boolean) => void }) {
  const loadable = useLoadable(() => api.concept(conceptId), [conceptId]);
  const active = loadable.data?.templates.filter((t) => t.status === "active") ?? [];
  useEffect(() => {
    if (active.length === 1) onPick(active[0]!.id, true);
  }, [loadable.data]);
  return (
    <WhenLoaded loadable={loadable}>
      {(c) =>
        active.length === 0 ? (
          <p className="empty">{c.name} has no active templates.</p>
        ) : active.length === 1 ? (
          <Loading />
        ) : (
          <>
            <h2 className="section">{c.name}: pick a method</h2>
            <ul className="list">
              {active.map((t) => (
                <li key={t.id}>
                  <button type="button" className="row row-button row-high" onClick={() => onPick(t.id, false)}>
                    <span className="row-title">
                      {t.name} <span className="muted">· level {t.level}</span>
                    </span>
                    {t.methodSummary && (
                      <span className="muted summary-method">
                        <TextWithMath text={t.methodSummary.split("\n")[0] ?? ""} />
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )
      }
    </WhenLoaded>
  );
}

/** One template: requests instances one after another, with the next one preloaded on the first miss (GL-075). */
function ExerciseTemplate({ templateId }: { templateId: string }) {
  const [exercise, setExercise] = useState<Exercise | null>(null);
  const [error, setError] = useState<unknown>(null);
  const preloaded = useRef<Promise<Exercise | null> | null>(null);

  async function loadNext() {
    setError(null);
    setExercise(null);
    const pre = preloaded.current;
    preloaded.current = null;
    try {
      setExercise((pre && (await pre)) || (await api.createExercise(templateId)));
    } catch (e) {
      setError(e);
    }
  }

  useEffect(() => {
    void loadNext();
  }, [templateId]);

  function preload() {
    if (preloaded.current) return;
    // If the preload fails, another one is requested on "Another exercise" (and the error is shown then).
    preloaded.current = api.createExercise(templateId).catch((e: unknown) => {
      console.warn("Could not preload the next exercise", e);
      return null;
    });
  }

  if (error) return <ErrorBox error={error} onRetry={() => void loadNext()} />;
  if (!exercise) return <Loading text="Generating exercise…" />;
  return <Attempt key={exercise.instanceId} exercise={exercise} onFirstFailure={preload} onAnother={() => void loadNext()} />;
}

function stepsFromSummary(summary: string | null): string[] {
  if (!summary) return [];
  return summary
    .split("\n")
    .map((l) => l.replace(/^\s*(\d+[.)]|[-*•])\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 20);
}

function Attempt({ exercise, onFirstFailure, onAnother }: { exercise: Exercise; onFirstFailure: () => void; onAnother: () => void }) {
  const [shownAt] = useState(() => Date.now());
  const [value, setValue] = useState<AnswerValue | null>(null);
  const [order, setOrder] = useState<string[]>([]);
  const [trash, setTrash] = useState<string[]>([]);
  const [failCount, setFailCount] = useState(0);
  const [lineKey, setLineKey] = useState<string | null>(null);
  const [output, setOutput] = useState("");
  const [attempts, setAttempts] = useState<ExerciseAttemptResponse[]>([]);
  const [hints, setHints] = useState<ExerciseHintResponse[]>([]);
  const [sending, setSending] = useState<null | "attempt" | "hint" | "explanation">(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const summary = stepsFromSummary(exercise.methodSummary);
  const [steps, setSteps] = useState<string[]>(() => (summary.length ? summary.map(() => "") : [""]));
  const [ownExplanation, setOwnExplanation] = useState("");
  const [explanation, setExplanation] = useState<ExerciseExplanation | null>(null);
  const [viewExplain, setViewExplain] = useState(false);
  const code = isCodeClientInstance(exercise.instance) ? exercise.instance : null;
  const recipe = isRecipeClientInstance(exercise.instance) ? exercise.instance : null;

  const last = attempts.at(-1);
  const finished = last?.finished ?? false;
  const unknown = attempts.some((i) => i.outcome === "unknown_error");

  async function send() {
    if (sending || finished) return;
    let userInput: { result: AnswerValue } | { given: CodeComprehensionGiven };
    if (code) {
      if (code.kind === "parsons" || code.kind === "faded_parsons") {
        if (order.length === 0) return setNotice("Order the lines of the solution.");
        userInput = { given: { order: order } };
      } else if (code.kind === "predict") {
        if (!output.trim()) return setNotice("Write the expected output.");
        userInput = { given: { output: output.trim() } };
      } else {
        if (!lineKey) return setNotice("Point to the line with the bug.");
        userInput = { given: { lineKey } };
      }
    } else if (recipe) {
      if (value === null) return setNotice(missingText(recipe.answerKind));
      userInput = { result: value };
    } else {
      return setNotice("Unrecognized instance.");
    }
    setNotice(null);
    setError(null);
    setSending("attempt");
    try {
      const r = await api.attempt(exercise.instanceId, { userInput, responseMs: Math.min(3_600_000, Date.now() - shownAt) });
      if (!r.correct && attempts.length === 0) onFirstFailure();
      if (!r.correct && code && (code.kind === "parsons" || code.kind === "faded_parsons")) setFailCount((n) => n + 1);
      if (r.outcome === "unknown_error") setViewExplain(true);
      setAttempts((prev) => [...prev, r]);
    } catch (e) {
      setError(e);
    } finally {
      setSending(null);
    }
  }

  async function askHint() {
    setError(null);
    setSending("hint");
    try {
      const h = await api.hint(exercise.instanceId);
      setHints((prev) => [...prev, h]);
    } catch (e) {
      setError(e);
    } finally {
      setSending(null);
    }
  }

  async function explain() {
    setError(null);
    setSending("explanation");
    try {
      const trimmedSteps = steps.map((p) => p.trim().slice(0, 500));
      const e = await api.explain(exercise.instanceId, {
        steps: trimmedSteps.some(Boolean) ? trimmedSteps : undefined,
        learnerExplanation: ownExplanation.trim() ? ownExplanation.trim().slice(0, 2000) : undefined,
      });
      setExplanation(e);
    } catch (e) {
      setError(e);
    } finally {
      setSending(null);
    }
  }

  return (
    <article className="exercise">
      <p className="muted">{exercise.templateName}</p>
      <div className="statement">
        <TextWithMath text={exercise.instance.statement} />
      </div>

      {recipe && <AnswerInput instance={recipe} disabled={finished || sending !== null} onChange={setValue} onSubmit={send} />}
      {code && (code.kind === "parsons" || code.kind === "faded_parsons") && (
        <ParsonsBoard
          key={`${exercise.instanceId}-${failCount}`}
          lines={code.lines.map((l) => ({
            id: l.key,
            text: l.text,
            indent: l.indent ?? 0,
            distractor: l.distractor,
          }))}
          failCount={failCount}
          order={order}
          onOrderChange={setOrder}
          trash={trash}
          onTrashChange={setTrash}
          disabled={finished || sending !== null}
        />
      )}
      {code?.kind === "predict" && (
        <input
          className="input"
          value={output}
          disabled={finished || sending !== null}
          onChange={(e) => setOutput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void send()}
          placeholder="Program output"
        />
      )}
      {code?.kind === "spot_bug" && (
        <ul className="code-lines">
          {code.lines.map((l) => (
            <li key={l.key}>
              <button
                type="button"
                className={`code-line${lineKey === l.key ? " chosen" : ""}`}
                disabled={finished || sending !== null}
                onClick={() => setLineKey(l.key)}
              >
                <code style={{ paddingLeft: `${(l.indent ?? 0) * 1.2}em` }}>{l.text}</code>
              </button>
            </li>
          ))}
        </ul>
      )}
      {notice && <p className="notice">{notice}</p>}

      {attempts.map((r) => (
        <div key={r.attemptId} className={`result ${r.correct ? "result-good" : "result-bad"}`} role="status">
          <p className="result-title">
            {r.correct
              ? "Correct"
              : r.outcome === "known_error"
                ? `Attempt ${r.attemptNumber}: not correct, and it looks like a typical mistake`
                : `Attempt ${r.attemptNumber}: not correct`}
          </p>
          {r.canRetry && <p className="muted">You can ask for a hint and try again.</p>}
          {r.finished && r.solution !== null && !r.correct && (
            <p>
              Solution: <Value value={r.solution} />
            </p>
          )}
        </div>
      ))}

      {hints.map((h, i) => (
        <div key={i} className="hint">
          <p className="hint-title">{h.kind === "known_error" ? "Hint about your mistake" : "Method hint"}</p>
          <Paragraphs text={h.hint} />
        </div>
      ))}

      <ErrorBox error={error} />

      <div className="actions">
        {!finished && (
          <button type="button" className="btn btn-primary" disabled={sending !== null} onClick={send}>
            {sending === "attempt" ? "Grading…" : attempts.length ? "Try again" : "Grade"}
          </button>
        )}
        {last?.canRetry && !finished && (
          <button type="button" className="btn btn-quiet" disabled={sending !== null} onClick={askHint}>
            {sending === "hint" ? "Requesting hint…" : "Ask for a hint"}
          </button>
        )}
        {attempts.length > 0 && !viewExplain && (
          <button type="button" className="btn btn-quiet" onClick={() => setViewExplain(true)}>
            Show explanation
          </button>
        )}
        {finished && (
          <button type="button" className="btn btn-primary" onClick={onAnother}>
            Another exercise
          </button>
        )}
      </div>

      {viewExplain && (
        <section className="explain" aria-labelledby={`exp-${exercise.instanceId}`}>
          <h2 className="section" id={`exp-${exercise.instanceId}`}>
            {unknown ? "How did you do it?" : "Explanation"}
          </h2>
          <p className="muted">
            {unknown
              ? "This miss does not match any known mistake. Write your intermediate steps to locate where it goes wrong; if you like, explain your reasoning."
              : "Optional: write your steps or your reasoning and the explanation will take them into account."}
          </p>
          {summary.length > 0 ? (
            <ol className="steps">
              {summary.map((step, i) => (
                <li key={i} className={explanation?.firstMismatchStep === i ? "step-bad" : undefined}>
                  <label className="field-label" htmlFor={`step-${exercise.instanceId}-${i}`}>
                    <TextWithMath text={step} />
                  </label>
                  <input
                    id={`step-${exercise.instanceId}-${i}`}
                    className="input"
                    autoComplete="off"
                    spellCheck={false}
                    value={steps[i] ?? ""}
                    onChange={(e) => setSteps((prev) => prev.map((p, j) => (j === i ? e.target.value : p)))}
                  />
                  {explanation?.firstMismatchStep === i && <p className="notice">It stops adding up here.</p>}
                </li>
              ))}
            </ol>
          ) : (
            <>
              <label className="field-label" htmlFor={`steps-${exercise.instanceId}`}>
                Your steps (one per line)
              </label>
              <textarea
                id={`steps-${exercise.instanceId}`}
                className="input"
                rows={4}
                value={steps.join("\n")}
                onChange={(e) => setSteps(e.target.value.split("\n").slice(0, 20))}
              />
              {explanation?.firstMismatchStep != null && <p className="notice">It stops adding up at step {explanation.firstMismatchStep + 1}.</p>}
            </>
          )}
          <label className="field-label" htmlFor={`reason-${exercise.instanceId}`}>
            Your reasoning (optional)
          </label>
          <textarea
            id={`reason-${exercise.instanceId}`}
            className="input"
            rows={4}
            maxLength={2000}
            value={ownExplanation}
            onChange={(e) => setOwnExplanation(e.target.value)}
          />
          <Dictation onText={(t) => setOwnExplanation((prev) => (prev ? `${prev} ${t}` : t).slice(0, 2000))} disabled={sending !== null} />
          <div className="actions">
            <button type="button" className="btn btn-primary" disabled={sending !== null} onClick={explain}>
              {sending === "explanation" ? "Preparing the explanation…" : "Explain it to me"}
            </button>
          </div>
          {explanation && (
            <div className="explanation">
              <Paragraphs text={explanation.summary} />
              <ol>
                {explanation.steps.map((s, i) => (
                  <li key={i}>
                    <TextWithMath text={s.text} />
                  </li>
                ))}
              </ol>
              {explanation.omittedFormulas > 0 && (
                <p className="notice">
                  {explanation.omittedFormulas === 1 ? "1 formula was omitted" : `${explanation.omittedFormulas} formulas were omitted`} because eval could not
                  verify {explanation.omittedFormulas === 1 ? "it" : "them"}.
                </p>
              )}
            </div>
          )}
        </section>
      )}

      <p className="pie">
        <Link to={`/concepts/${exercise.conceptId}`}>View the concept</Link>
      </p>
    </article>
  );
}
