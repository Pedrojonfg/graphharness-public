// "Prepare exam" (GL-006/028/052/053):
// MCQ with "I don't know" and open questions, up to 20; the Hub decides the order and the inference.
import type { AnswerValue, DiagnosticAnswerResponse, DiagnosticItem, DiagnosticState } from "@graphharness/contracts";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { api } from "../api.ts";
import { TextWithMath, Value } from "../components/MathView.tsx";
import { missingText, AnswerInput } from "../components/AnswerInput.tsx";
import { WhenLoaded, ErrorBox, PageHeader, useLoadable } from "../components/Ui.tsx";

const FINISH_TEXT: Record<NonNullable<DiagnosticState["finished"]>["reason"], string> = {
  complete: "There is nothing left to ask.",
  max_items: "You have reached the cap of 20 questions.",
  nothing_to_ask: "No concept of the exam needs an exercise-based diagnostic right now.",
};

const RESULT: Record<DiagnosticAnswerResponse["outcome"], string> = {
  correct: "Correct",
  incorrect: "Not quite",
  dont_know: "Recorded as \"I don't know\"",
};

export function DiagnosticPage() {
  const { id = "" } = useParams();
  const loadable = useLoadable(() => api.createDiagnostic(id), [id]);
  return (
    <main className="page page-narrow">
      <PageHeader title="Prepare exam" sub="A quick sweep to find out what you know and what you do not. If you do not know, say so: that counts too." />
      <WhenLoaded loadable={loadable} text="Preparing the diagnostic…">
        {(s) => <DiagnosticPass initial={s} />}
      </WhenLoaded>
    </main>
  );
}

function DiagnosticPass({ initial }: { initial: DiagnosticState }) {
  const [state, setState] = useState(initial);
  const [last, setLast] = useState<{ concept: string; outcome: DiagnosticAnswerResponse["outcome"] } | null>(null);

  if (state.finished || !state.item)
    return (
      <div className="block">
        <h2>Diagnostic finished</h2>
        {last && <p className="muted">Last: {RESULT[last.outcome]}.</p>}
        <p>{state.finished ? FINISH_TEXT[state.finished.reason] : FINISH_TEXT.complete}</p>
        <p className="muted">Answered: {state.answered}.</p>
        {state.finished && state.finished.unaskableConceptIds.length > 0 && (
          <p>
            {state.finished.unaskableConceptIds.length} concepts of the exam have no template: they are confirmed with cards or a LearnHarness session.
          </p>
        )}
        <div className="actions">
          <Link className="btn btn-primary" to="/exams">
            Back to exams
          </Link>
          <Link className="btn btn-quiet" to="/cards">
            Go to cards
          </Link>
        </div>
      </div>
    );

  return (
    <>
      <p className="progress" aria-live="polite">
        Question {state.answered + 1} of at most {state.maxItems}
        {last && (
          <span className="muted">
            {" "}
            · previous ({last.concept}): {RESULT[last.outcome]}
          </span>
        )}
      </p>
      <Question
        key={state.item.itemId}
        diagnosticId={state.id}
        item={state.item}
        onAnswered={(r, item) => {
          setLast({ concept: item.conceptName, outcome: r.outcome });
          setState(r.state);
        }}
      />
    </>
  );
}

function Question({ diagnosticId, item, onAnswered }: { diagnosticId: string; item: DiagnosticItem; onAnswered: (r: DiagnosticAnswerResponse, item: DiagnosticItem) => void }) {
  const [shownAt] = useState(() => Date.now());
  const [option, setOption] = useState<string | null>(null);
  const [value, setValue] = useState<AnswerValue | null>(null);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  async function answer(dontKnow: boolean) {
    let answer: Parameters<typeof api.answerDiagnostic>[1]["answer"];
    if (dontKnow) answer = { kind: "dont_know" };
    else if (item.format === "mcq") {
      if (!option) return setNotice("Pick an option or press \"I don't know\".");
      answer = { kind: "mcq", optionId: option };
    } else {
      if (!("recipeVersion" in item.instance)) return setNotice("This item cannot be answered here.");
      if (value === null) return setNotice(missingText(item.instance.answerKind));
      answer = { kind: "open", userInput: { result: value } };
    }
    setNotice(null);
    setError(null);
    setSending(true);
    try {
      onAnswered(await api.answerDiagnostic(diagnosticId, { itemId: item.itemId, answer, responseMs: Math.min(3_600_000, Date.now() - shownAt) }), item);
    } catch (e) {
      setError(e);
      setSending(false);
    }
  }

  return (
    <article className="exercise">
      <p className="muted">{item.conceptName}</p>
      <div className="statement">
        <TextWithMath text={item.instance.statement} />
      </div>
      {item.format === "mcq" ? (
        <fieldset className="options" disabled={sending}>
          <legend className="sr-only">Options</legend>
          {(item.options ?? []).map((o) => (
            <button key={o.id} type="button" className={`option${option === o.id ? " chosen" : ""}`} aria-pressed={option === o.id} onClick={() => setOption(o.id)}>
              <Value value={o.value} />
            </button>
          ))}
        </fieldset>
      ) : "recipeVersion" in item.instance ? (
        <AnswerInput instance={item.instance} disabled={sending} onChange={setValue} onSubmit={() => void answer(false)} />
      ) : (
        <p className="notice">Code item: use the Exercises screen or LH.</p>
      )}
      {notice && <p className="notice">{notice}</p>}
      <ErrorBox error={error} />
      <div className="actions">
        <button type="button" className="btn btn-primary" disabled={sending} onClick={() => void answer(false)}>
          Answer
        </button>
        <button type="button" className="btn btn-quiet" disabled={sending} onClick={() => void answer(true)}>
          I don't know
        </button>
      </div>
    </article>
  );
}
