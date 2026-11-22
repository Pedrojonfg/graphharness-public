// Today: the daily brief as cards, plus the suggested items with their action button.
import type { DailyBrief } from "@graphharness/contracts";
import { Link } from "react-router";
import { api } from "../api.ts";
import { WhenLoaded, daysText, ErrorBox, StateChip, date, longDate, pct, PageHeader, useOpenSession, useLoadable } from "../components/Ui.tsx";

export function TodayPage() {
  const loadable = useLoadable(() => api.brief(), []);
  return (
    <main className="page">
      <PageHeader title="Today" sub={loadable.data ? longDate.format(new Date(`${loadable.data.date}T12:00:00`)) : undefined} />
      <WhenLoaded loadable={loadable} text="Preparing your day…">
        {(b) => <Brief b={b} />}
      </WhenLoaded>
    </main>
  );
}

function Brief({ b }: { b: DailyBrief }) {
  return (
    <div className="brief">
      {b.suggestedToday.length > 0 && (
        <section className="block block-highlighted" aria-labelledby="h-suggested">
          <h2 id="h-suggested">Suggested today</h2>
          <ul className="suggestions">
            {b.suggestedToday.map((s, i) => (
              <Suggestion key={i} s={s} />
            ))}
          </ul>
        </section>
      )}

      <section className="block" aria-labelledby="h-cards">
        <h2 id="h-cards">Cards</h2>
        <p className="digit">
          {b.dueCards.count} <span>{b.dueCards.count === 1 ? "due" : "due"}</span>
        </p>
        {b.dueCards.confirmationPending > 0 && (
          <p className="muted">
            {b.dueCards.confirmationPending} confirming what you declared
          </p>
        )}
        <Link className="btn btn-primary" to="/cards">
          Review cards
        </Link>
      </section>

      <section className="block" aria-labelledby="h-exams">
        <h2 id="h-exams">Exams coming up</h2>
        {b.examsSoon.length === 0 ? (
          <p className="muted">No upcoming exams.</p>
        ) : (
          <ul className="list-simple">
            {b.examsSoon.map((e, i) => (
              <li key={i} className="exam-line">
                <span>
                  <strong>{e.title}</strong> <span className="muted">· {e.subject}</span>
                  <br />
                  <span className="muted">
                    {date(e.date)}, {daysText(e.daysLeft)}
                    {e.unknownCount > 0 && ` · ${e.unknownCount} no record`}
                  </span>
                </span>
                <span className="prepared" title="Probability of being prepared">
                  {pct(e.preparedProbability)}
                </span>
              </li>
            ))}
          </ul>
        )}
        <Link className="link-action" to="/exams">
          View exams
        </Link>
      </section>

      <section className="block" aria-labelledby="h-weak">
        <h2 id="h-weak">Weakest</h2>
        {b.weakest.length === 0 ? (
          <p className="muted">Nothing weak for now.</p>
        ) : (
          <ul className="list-simple">
            {b.weakest.map((w) => (
              <li key={w.conceptId} className="concept-line">
                <Link to={`/concepts/${w.conceptId}`}>{w.name}</Link>
                <span className="concept-line-meta">
                  <StateChip state={w.state} />
                  <span className="muted">{pct(w.probability)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {b.yesterday.length > 0 && (
        <section className="block" aria-labelledby="h-yesterday">
          <h2 id="h-yesterday">Yesterday</h2>
          <ul className="list-simple">
            {b.yesterday.map((y) => (
              <li key={y.chatId}>
                <strong>{y.title}</strong>
                {y.highlights && <p>{y.highlights}</p>}
                {y.conceptsTouched.length > 0 && <p className="muted">{y.conceptsTouched.map((c) => c.name).join(", ")}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {b.recurringErrors.length > 0 && (
        <section className="block" aria-labelledby="h-errors">
          <h2 id="h-errors">Errors you repeat</h2>
          <ul className="list-simple">
            {b.recurringErrors.map((e, i) => (
              <li key={i}>
                {e.error} <span className="muted">· {e.template} · {e.timesSeen} times</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

const ACTION = { cards: "Review cards", exercises: "Do exercises", session: "Open session in LearnHarness" } as const;

function Suggestion({ s }: { s: DailyBrief["suggestedToday"][number] }) {
  // Names and subject of the concepts: the brief only carries ids.
  const concepts = useLoadable(() => Promise.all(s.conceptIds.slice(0, 5).map((id) => api.concept(id))), [s.conceptIds.join(",")]);
  const { opening, error, setError, open } = useOpenSession();
  const names = concepts.data?.map((c) => c.name).join(", ");

  function openSession() {
    const cs = concepts.data;
    const subjectId = cs?.find((c) => c.subjectId)?.subjectId;
    if (!cs || !subjectId) return setError(new Error("These concepts have no subject; assign one from the Inbox."));
    return open({
      subjectId,
      goal: `Work on ${cs.map((c) => c.name).join(", ")}. ${s.why}`.slice(0, 2000),
      kind: "teaching",
      focusConceptIds: s.conceptIds.slice(0, 50),
    });
  }

  const first = s.conceptIds[0]!;
  return (
    <li className="suggestion">
      <p className="suggestion-what">{names ?? (concepts.error ? `${s.conceptIds.length} concepts` : "…")}</p>
      <p className="muted">{s.why}</p>
      {s.kind === "cards" && (
        <Link className="btn btn-primary" to="/cards">
          {ACTION.cards}
        </Link>
      )}
      {s.kind === "exercises" && (
        <Link className="btn btn-primary" to={`/exercises?concept=${encodeURIComponent(first)}`}>
          {ACTION.exercises}
        </Link>
      )}
      {s.kind === "session" && (
        <button type="button" className="btn btn-primary" disabled={opening || concepts.loading} onClick={openSession}>
          {opening ? "Opening session…" : ACTION.session}
        </button>
      )}
      <ErrorBox error={error} />
    </li>
  );
}
