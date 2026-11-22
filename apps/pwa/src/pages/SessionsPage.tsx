// LearnHarness sessions mirrored in the Hub (GET /sessions, close open ones).
import type { HubSessionState, LhSession } from "@graphharness/contracts";
import { useState } from "react";
import { Link } from "react-router";
import { api } from "../api.ts";
import { WhenLoaded, ErrorBox, dateTime, PageHeader, useLoadable } from "../components/Ui.tsx";

const HUB_STATE: Record<HubSessionState, string> = {
  open: "Open",
  closing: "Closing",
  closed: "Closed",
  failed: "Failed",
};

const TYPE: Record<LhSession["kind"], string> = {
  teaching: "Teaching",
  practice: "Practice",
};

export function SessionsPage() {
  const loadable = useLoadable(() => api.sessions(50), []);
  return (
    <main className="page page-narrow">
      <PageHeader
        title="Sessions"
        sub="LearnHarness chats and their state in the Hub."
        accessory={
          <button type="button" className="btn btn-quiet" onClick={() => loadable.reload()}>
            Refresh
          </button>
        }
      />
      <WhenLoaded loadable={loadable} text="Loading sessions…">
        {(list) =>
          list.length === 0 ? (
            <p className="empty">No sessions recorded yet.</p>
          ) : (
            <ul className="list">
              {list.map((s) => (
                <SessionRow key={s.chatId} s={s} onChanged={loadable.reload} />
              ))}
            </ul>
          )
        }
      </WhenLoaded>
    </main>
  );
}

function SessionRow({ s, onChanged }: { s: LhSession; onChanged: () => void }) {
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function close() {
    setClosing(true);
    setError(null);
    try {
      await api.closeSession(s.chatId);
      onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setClosing(false);
    }
  }

  return (
    <li className="block">
      <p className="row-title">{s.title}</p>
      <p className="muted">
        {TYPE[s.kind]} · {HUB_STATE[s.hubState]}
        {s.closedAt ? ` · closed ${dateTime(s.closedAt)}` : s.lastTurnSettledAt ? ` · last turn ${dateTime(s.lastTurnSettledAt)}` : ""}
      </p>
      <div className="actions">
        <a className="btn btn-quiet" href={s.url} target="_blank" rel="noreferrer">
          Open in LH
        </a>
        {s.reportId && (
          <Link className="btn btn-quiet" to={`/reports/${s.reportId}`}>
            Report
          </Link>
        )}
        {s.hubState === "open" && (
          <button type="button" className="btn btn-primary" disabled={closing} onClick={close}>
            {closing ? "Closing…" : "Close"}
          </button>
        )}
      </div>
      <ErrorBox error={error} />
    </li>
  );
}
