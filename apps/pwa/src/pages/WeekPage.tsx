// Week (ADR 105 §7): the plan for the next days between sessions, with the action for each concept.
import type { WeekPlanView } from "@graphharness/contracts";
import { Link } from "react-router";
import { api } from "../api.ts";
import { WhenLoaded, ErrorBox, longDate, PageHeader, useOpenSession, useLoadable } from "../components/Ui.tsx";

type Item = WeekPlanView["days"][number]["items"][number];

export function WeekPage() {
  const loadable = useLoadable(() => api.plan(), []);
  return (
    <main className="page page-narrow">
      <PageHeader title="Week" sub="What is due each day until your next session." />
      <WhenLoaded loadable={loadable} text="Preparing your week…">
        {(p) => (
          <>
            {p.days.map((d) => (
              <section key={d.date} className="block" aria-labelledby={`day-${d.date}`}>
                <h2 id={`day-${d.date}`}>{longDate.format(new Date(`${d.date}T12:00:00`))}</h2>
                {d.items.length === 0 ? (
                  <p className="muted">Nothing due</p>
                ) : (
                  <ul className="list-simple">
                    {d.items.map((it) => (
                      <ItemPlan key={`${it.kind}-${it.conceptId}`} it={it} />
                    ))}
                  </ul>
                )}
              </section>
            ))}
            {p.unscheduledCount > 0 && (
              <p className="notice">
                {p.unscheduledCount === 1 ? "1 concept does not fit this week." : `${p.unscheduledCount} concepts do not fit this week.`}
              </p>
            )}
          </>
        )}
      </WhenLoaded>
    </main>
  );
}

function ItemPlan({ it }: { it: Item }) {
  const { opening, error, setError, open } = useOpenSession();
  function openSession() {
    if (!it.subjectId) return setError(new Error("This concept has no subject; assign one from the Inbox."));
    return open({ subjectId: it.subjectId, goal: `Work on ${it.conceptName}. ${it.why}`.slice(0, 2000), kind: "teaching", focusConceptIds: [it.conceptId] });
  }
  return (
    <li>
      <p className="suggestion-what">{it.conceptName}</p>
      <p className="muted">{it.why}</p>
      {it.kind === "cards" && (
        <Link className="btn btn-quiet" to="/cards">
          Review cards
        </Link>
      )}
      {it.kind === "exercises" && (
        <Link className="btn btn-quiet" to={`/exercises?concept=${encodeURIComponent(it.conceptId)}`}>
          Do exercises
        </Link>
      )}
      {it.kind === "session" && (
        <button type="button" className="btn btn-quiet" disabled={opening} onClick={openSession}>
          {opening ? "Opening session…" : "Open session"}
        </button>
      )}
      <ErrorBox error={error} />
    </li>
  );
}
