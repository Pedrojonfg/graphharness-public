// Inspired by the GraphLearn web app (65b56d6; see docs/PROVENANCE.md): infinite queue and local grading.
// Here cards are reviewed one at a time (mobile), confirmation cards are marked and "actually I was right" expires after 60 s.
import { API_BASE, type AnswerValue, type Card, type CardQueue, type CardReviewResponse } from "@graphharness/contracts";
import { OVERRIDE_WINDOW_MS } from "@graphharness/core";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { api } from "../api.ts";
import { TextWithMath, Value } from "../components/MathView.tsx";
import { ParsonsBoard } from "../components/ParsonsBoard.tsx";
import { AnswerInput } from "../components/AnswerInput.tsx";
import { Loading, ErrorBox, PageHeader } from "../components/Ui.tsx";
import { allowsOverride, reviewBody, inputKindOf, codeLines, type Answered } from "../cards.ts";

const PAGE = 20;

export function CardsPage() {
  const [cards, setCards] = useState<Card[]>([]);
  const [idx, setIdx] = useState(0);
  const [meta, setMeta] = useState<Pick<CardQueue, "total" | "dueCount" | "confirmationPending" | "nextOffset"> | null>(null);
  const [error, setError] = useState<unknown>(null);
  const loading = useRef(false);

  const load = useCallback(async (offset: number, reset = false) => {
    if (loading.current) return;
    loading.current = true;
    setError(null);
    try {
      const q = await api.cardQueue(offset, PAGE);
      setCards((prev) => {
        const base = reset ? [] : prev;
        const ids = new Set(base.map((c) => c.id));
        return [...base, ...q.cards.filter((c) => !ids.has(c.id))];
      });
      if (reset) setIdx(0);
      setMeta({ total: q.total, dueCount: q.dueCount, confirmationPending: q.confirmationPending, nextOffset: q.nextOffset });
    } catch (e) {
      setError(e);
    } finally {
      loading.current = false;
    }
  }, []);

  useEffect(() => {
    void load(0, true);
  }, [load]);

  // Infinite queue: when few are left in memory, fetch the next page.
  useEffect(() => {
    if (meta?.nextOffset != null && cards.length - idx <= 3) void load(meta.nextOffset);
  }, [idx, cards.length, meta?.nextOffset, load]);

  const card = cards[idx];
  const sub =
    meta &&
    (meta.dueCount === 0 ? "None due right now; you can review ahead." : `${meta.dueCount} due`) +
      (meta.confirmationPending ? `, ${meta.confirmationPending} confirmation` : "");

  return (
    <main className="page page-narrow">
      <PageHeader
        title="Cards"
        sub={sub}
        accessory={<ImportJson onDone={() => void load(0, true)} />}
      />
      <ErrorBox error={error} onRetry={() => void load(meta?.nextOffset ?? 0, meta === null)} />
      {meta === null && !error && <Loading text="Loading the queue…" />}
      {meta && meta.total === 0 && (
        <div className="empty">
          <p>You have no cards yet. They are created when each LearnHarness session closes, from what you worked on.</p>
          <Link className="btn btn-quiet" to="/">
            Back to Today
          </Link>
        </div>
      )}
      {card && <ActiveCard key={card.id} card={card} onNext={() => setIdx((i) => i + 1)} />}
      {meta && meta.total > 0 && !card && meta.nextOffset === null && (
        <div className="empty">
          <p>You have gone through the whole queue.</p>
          <button type="button" className="btn btn-primary" onClick={() => void load(0, true)}>
            Start another round
          </button>
        </div>
      )}
      {meta && !card && meta.nextOffset !== null && !error && <Loading />}
    </main>
  );
}

type Result = { correct: boolean; res: CardReviewResponse; at: number; overridden: boolean };

export function ActiveCard({ card, onNext }: { card: Card; onNext: () => void }) {
  const [shownAt] = useState(() => Date.now());
  const [text, setText] = useState("");
  const [option, setOption] = useState<string | null>(null);
  const [value, setValue] = useState<AnswerValue | null>(null);
  const [orderParsons, setOrderParsons] = useState<string[]>([]);
  const [trashParsons, setTrashParsons] = useState<string[]>([]);
  const [lineBug, setLineBug] = useState<string | null>(null);
  const [failCount, setFailCount] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [, repaint] = useState(0);
  const next = useRef<HTMLButtonElement>(null);
  const cardId = useRef(card.id);
  const input = inputKindOf(card);
  const figureId = card.figureId ?? card.front.figureId ?? null;

  useEffect(() => {
    if (cardId.current === card.id) return;
    cardId.current = card.id;
    setText("");
    setOption(null);
    setValue(null);
    setOrderParsons([]);
    setTrashParsons([]);
    setLineBug(null);
    setFailCount(0);
    setResult(null);
    setNotice(null);
    setError(null);
  }, [card.id]);

  // After 60 s it re-renders to remove the "actually I was right" button.
  useEffect(() => {
    if (!result || result.correct) return;
    const t = setTimeout(() => repaint((n) => n + 1), Math.max(0, result.at + OVERRIDE_WINDOW_MS - Date.now()) + 50);
    return () => clearTimeout(t);
  }, [result]);
  const windowOpen = result !== null && Date.now() - result.at <= OVERRIDE_WINDOW_MS;

  useEffect(() => {
    if (result) next.current?.focus();
  }, [result]);

  function answered(): Answered | null {
    if (input === "mcq") return option ? { optionId: option } : null;
    if (input === "instance") return value !== null ? { value: value } : null;
    if (input === "parsons") {
      const need = codeLines(card).filter((l) => !l.distractor).map((l) => l.id);
      if (orderParsons.length !== need.length) return null;
      return { order: orderParsons };
    }
    if (input === "spot_bug") return lineBug ? { lineId: lineBug } : null;
    return text.trim() ? { text: text } : null;
  }

  async function checkAnswer() {
    if (sending || result) return;
    const r = answered();
    const noticeInput =
      input === "mcq"
        ? "Pick an option."
        : input === "parsons"
          ? "Complete the solution with all the right lines."
          : input === "spot_bug"
            ? "Point to the line with the bug."
            : "Write your answer.";

    if (!r) return setNotice(noticeInput);
    setNotice(null);
    setError(null);
    setSending(true);
    try {
      const res = await api.reviewCard(card.id, reviewBody(card, r, Date.now() - shownAt));
      if (!res.correct && card.kind === "parsons") setFailCount((n) => n + 1);
      setResult({ correct: res.correct, res, at: Date.now(), overridden: false });
    } catch (e) {
      setError(e);
    } finally {
      setSending(false);
    }
  }

  function retryParsons() {
    if (!result || result.correct) return;
    setResult(null);
    setOrderParsons([]);
    setTrashParsons([]);
    setNotice(null);
  }

  async function override() {
    if (!result) return;
    setSending(true);
    setError(null);
    try {
      const res = await api.reviewCard(card.id, { override: true });
      setResult({ ...result, res, overridden: true });
    } catch (e) {
      setError(e);
    } finally {
      setSending(false);
    }
  }

  function skip() {
    if (sending || result) return;
    onNext();
  }

  async function retire() {
    if (sending || result) return;
    setSending(true);
    setError(null);
    try {
      await api.retireCard(card.id);
      onNext();
    } catch (e) {
      setError(e);
    } finally {
      setSending(false);
    }
  }

  const good = result && (result.correct || result.overridden);
  const inst = card.front.instance;

  return (
    <article className={`card${card.purpose === "confirmation" ? " card-confirmation" : ""}`} aria-labelledby={`t-${card.id}`}>
      <div className="card-header">
        {card.purpose === "confirmation" && <span className="confirmation-badge">Confirmation</span>}
        <span className="muted">{card.conceptName ?? "No concept"}</span>
        {!card.schedule.due && card.purpose !== "confirmation" && <span className="muted">· not due yet</span>}
      </div>
      <div className="card-front" id={`t-${card.id}`}>
        {figureId && <FigureCard figureId={figureId} />}
        {card.front.text && (
          <p>
            {card.kind === "cloze" ? <Cloze text={card.front.text} /> : <TextWithMath text={card.front.text} />}
          </p>
        )}
        {inst && (
          <p>
            <TextWithMath text={inst.statement} />
          </p>
        )}
      </div>

      {input === "mcq" && (
        <fieldset className="options" disabled={result !== null || sending}>
          <legend className="sr-only">Options</legend>
          {(card.options ?? []).map((o) => {
            const isGood = result && card.answer && "optionId" in card.answer && card.answer.optionId === o.id;
            return (
              <button
                key={o.id}
                type="button"
                className={`option${option === o.id ? " chosen" : ""}${isGood ? " good" : ""}`}
                aria-pressed={option === o.id}
                onClick={() => setOption(o.id)}
              >
                <Value value={o.value} />
              </button>
            );
          })}
        </fieldset>
      )}
      {input === "instance" && inst && "recipeVersion" in inst && (
        <AnswerInput instance={inst} disabled={result !== null} onChange={setValue} onSubmit={checkAnswer} />
      )}
      {input === "parsons" && card.front.parsons && (
        <ParsonsBoard
          key={`${card.id}-${failCount}`}
          lines={card.front.parsons.lines}
          failCount={failCount}
          order={orderParsons}
          onOrderChange={setOrderParsons}
          trash={trashParsons}
          onTrashChange={setTrashParsons}
          disabled={result !== null || sending}
        />
      )}
      {input === "spot_bug" && (
        <fieldset className="code-lines" disabled={result !== null || sending}>
          <legend className="sr-only">Code lines</legend>
          {codeLines(card).map((l, i) => {
            const chosen = lineBug === l.id;
            const isGood =
              result &&
              card.answer &&
              "lineId" in card.answer &&
              !result.correct &&
              card.answer.lineId === l.id;
            return (
              <button
                key={l.id}
                type="button"
                className={`code-line${chosen ? " chosen" : ""}${isGood ? " good" : ""}`}
                aria-pressed={chosen}
                onClick={() => setLineBug(l.id)}
              >
                <span className="code-line-n">{i + 1}</span>
                <code style={{ paddingLeft: `${l.indent * 0.75}rem` }}>{l.text}</code>
              </button>
            );
          })}
        </fieldset>
      )}
      {input === "text" && (
        <div className="answer-text">
          <label className="field-label" htmlFor={`r-${card.id}`}>
            {card.kind === "cloze" ? "What goes in the blank" : card.kind === "predict" ? "Expected output or value" : "Your answer"}
          </label>
          <input
            id={`r-${card.id}`}
            className="input"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            disabled={result !== null}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && checkAnswer()}
          />
        </div>
      )}

      {notice && <p className="notice">{notice}</p>}
      <ErrorBox error={error} />

      {result && (
        <div className={`result ${good ? "result-good" : "result-bad"}`} role="status">
          <p className="result-title">{result.overridden ? "Marked as correct" : result.correct ? "Correct" : "Not quite"}</p>
          {!result.correct && <AnswerGood card={card} res={result.res} />}
          <p className="muted">
            {result.res.retired
              ? "Confirmation recorded; the card is retired."
              : result.res.early
                ? "Early review: it does not change the interval or count as evidence."
                : `Next review ${formatInterval(result.res.schedule.intervalDays)}.`}
          </p>
          {!result.correct && !result.overridden && allowsOverride(card) && windowOpen && (
            <button type="button" className="btn btn-quiet" disabled={sending} onClick={override}>
              Actually I was right
            </button>
          )}
          {!result.correct && card.kind === "parsons" && (
            <button type="button" className="btn btn-quiet" disabled={sending} onClick={retryParsons}>
              Try again
            </button>
          )}
        </div>
      )}

      <div className="actions">
        {result ? (
          <button ref={next} type="button" className="btn btn-primary" onClick={onNext}>
            Next
          </button>
        ) : (
          <>
            <button type="button" className="btn btn-primary" disabled={sending} onClick={checkAnswer}>
              {sending ? "Checking…" : "Check"}
            </button>
            <button type="button" className="btn btn-quiet" disabled={sending} onClick={skip}>
              Skip
            </button>
            <button type="button" className="btn btn-danger" disabled={sending} onClick={retire}>
              Retire card
            </button>
          </>
        )}
      </div>
    </article>
  );
}

function FigureCard({ figureId }: { figureId: string }) {
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;
  // GET /figures/:id/svg once it exists in the Hub; on 404 it stays out of the way.
  const src = `${API_BASE}/figures/${encodeURIComponent(figureId)}/svg`;
  return <img className="figure-card" src={src} alt="" onError={() => setHidden(true)} />;
}

function AnswerGood({ card, res }: { card: Card; res: CardReviewResponse }) {
  const a = card.answer;
  if (a && "order" in a)
    return (
      <p>
        Order:{" "}
        <code>{a.order.join(" → ")}</code>
      </p>
    );
  if (a && "lineId" in a) {
    const line = codeLines(card).find((l) => l.id === a.lineId);
    return (
      <p>
        Line: <code>{line ? line.text : a.lineId}</code>
      </p>
    );
  }
  if (a && "text" in a)
    return (
      <p>
        Answer: <TextWithMath text={a.text} />
      </p>
    );
  const value: unknown = a ? card.options?.find((o) => o.id === a.optionId)?.value : res.expectedAnswer;
  if (value === null || value === undefined) return null;
  return (
    <p>
      Answer: <Value value={value} />
    </p>
  );
}

/** Cloze blanks are `____` (four underscores): they are rendered as a visible blank. */
function Cloze({ text }: { text: string }) {
  const chunks = text.split("____");
  return (
    <>
      {chunks.map((t, i) => (
        <span key={i}>
          <TextWithMath text={t} />
          {i < chunks.length - 1 && (
            <span className="blank" role="img" aria-label="blank">
              {" "}
            </span>
          )}
        </span>
      ))}
    </>
  );
}

function ImportJson({ onDone }: { onDone: () => void }) {
  const id = useId();
  const [json, setJson] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<number | null>(null);

  async function send(e: FormEvent) {
    e.preventDefault();
    if (sending) return;
    setSending(true);
    setError(null);
    setDone(null);
    try {
      const body = JSON.parse(json) as { cards: { kind?: "text" | "cloze"; front: string; back: string }[] };
      const r = await api.importCards({
        cards: body.cards.map((c) => ({ kind: c.kind ?? "text", front: c.front, back: c.back })),
      });
      setDone(r.created);
      setJson("");
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setSending(false);
    }
  }

  return (
    <details className="import-cards">
      <summary className="btn btn-quiet">Import JSON</summary>
      <form className="form" onSubmit={(e) => void send(e)}>
        <label className="field-label" htmlFor={id}>
          JSON with "cards" (kind, front, back)
        </label>
        <textarea id={id} className="input" rows={4} value={json} disabled={sending} onChange={(e) => setJson(e.target.value)} />
        {done !== null && <p className="muted" role="status">{done} cards imported.</p>}
        <ErrorBox error={error} />
        <button type="submit" className="btn btn-quiet" disabled={sending || !json.trim()}>
          {sending ? "Importing…" : "Import"}
        </button>
      </form>
    </details>
  );
}

function formatInterval(d: number): string {
  if (d < 1) return "in less than a day";
  const r = Math.round(d * 10) / 10;
  return `in ${r} ${r === 1 ? "day" : "days"}`;
}
