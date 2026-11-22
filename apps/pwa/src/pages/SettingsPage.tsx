// Settings: service status (/health), last backup and LLM in use (/llm-usage).
import type { Health, LlmUsage, Profile, Subject, SubjectKind } from "@graphharness/contracts";
import { useId, useState } from "react";
import { api } from "../api.ts";
import { WhenLoaded, ErrorBox, dateTime, PageHeader, useLoadable } from "../components/Ui.tsx";

const TYPE_SUBJECT: Record<SubjectKind, string> = {
  general: "General",
  computable_math: "Computable math",
  programming: "Programming",
};

export function SettingsPage() {
  const health = useLoadable(() => api.health(), []);
  const profile = useLoadable(() => api.profile(), []);
  const subjects = useLoadable(() => api.subjects(), []);
  const [days, setDays] = useState(7);
  const usage = useLoadable(() => api.llmUsage(days), [days]);
  return (
    <main className="page page-narrow">
      <PageHeader
        title="Settings"
        accessory={
          <button
            type="button"
            className="btn btn-quiet"
            onClick={() => {
              health.reload();
              profile.reload();
              subjects.reload();
              usage.reload();
            }}
          >
            Refresh
          </button>
        }
      />
      <WhenLoaded loadable={subjects} text="Loading subjects…">
        {(list) => <Subjects list={list} onChanged={subjects.reload} />}
      </WhenLoaded>
      <WhenLoaded loadable={health} text="Checking services…">
        {(h) => <Health h={h} />}
      </WhenLoaded>
      <section className="block">
        <div className="block-header">
          <h2>LLM usage</h2>
          <label className="selector">
            <span className="sr-only">Period</span>
            <select className="input" value={days} onChange={(e) => setDays(Number(e.target.value))}>
              <option value={1}>Last day</option>
              <option value={7}>Last 7 days</option>
              <option value={30}>Last 30 days</option>
            </select>
          </label>
        </div>
        <WhenLoaded loadable={usage}>{(u) => <UsageTable u={u} />}</WhenLoaded>
      </section>
      <section className="block">
        <h2>Profile</h2>
        <WhenLoaded loadable={profile} text="Loading profile…">
          {(p) => <Profile p={p} />}
        </WhenLoaded>
      </section>
    </main>
  );
}

function Subjects({ list, onChanged }: { list: Subject[]; onChanged: () => void }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<SubjectKind>("general");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const id = useId();
  const active = list.filter((s) => !s.archivedAt);
  const archived = list.filter((s) => s.archivedAt);

  async function create() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setCreating(true);
    setError(null);
    try {
      await api.createSubject({ name: trimmed, kind });
      setName("");
      setKind("general");
      onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setCreating(false);
    }
  }

  async function archive(s: Subject, archived: boolean) {
    setError(null);
    try {
      await api.patchSubject(s.id, { archived });
      onChanged();
    } catch (e) {
      setError(e);
    }
  }

  return (
    <section className="block">
      <h2>Subjects</h2>
      {active.length === 0 && archived.length === 0 ? (
        <p className="empty">No subjects yet.</p>
      ) : (
        <ul className="list-simple">
          {active.map((s) => (
            <li key={s.id}>
              {s.name} <span className="muted">· {TYPE_SUBJECT[s.kind]}</span>
              <button type="button" className="btn btn-quiet" onClick={() => archive(s, true)}>
                Archive
              </button>
            </li>
          ))}
          {archived.map((s) => (
            <li key={s.id} className="muted">
              {s.name} <span className="muted">· archived {dateTime(s.archivedAt)}</span>
              <button type="button" className="btn btn-quiet" onClick={() => archive(s, false)}>
                Restore
              </button>
            </li>
          ))}
        </ul>
      )}
      <h3 className="section">New subject</h3>
      <label className="field-label" htmlFor={`${id}-n`}>
        Name
      </label>
      <input id={`${id}-n`} className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
      <label className="field-label" htmlFor={`${id}-k`}>
        Type
      </label>
      <select id={`${id}-k`} className="input" value={kind} onChange={(e) => setKind(e.target.value as SubjectKind)}>
        <option value="general">General</option>
        <option value="computable_math">Computable math</option>
        <option value="programming">Programming</option>
      </select>
      <div className="actions">
        <button type="button" className="btn btn-primary" disabled={creating || name.trim() === ""} onClick={create}>
          {creating ? "Creating…" : "Create subject"}
        </button>
      </div>
      <ErrorBox error={error} />
    </section>
  );
}

function Dot({ ok }: { ok: boolean }) {
  return <span className={`result-dot ${ok ? "good" : "bad"}`} aria-hidden="true" />;
}

function Health({ h }: { h: Health }) {
  const mb = h.backup.repoSizeBytes === null ? null : (h.backup.repoSizeBytes / 1_048_576).toFixed(1);
  return (
    <>
      <section className="block">
        <h2>Services</h2>
        <p className={h.ok ? "state-ok" : "state-bad"}>{h.ok ? "Everything works." : "Some services have problems."}</p>
        <ul className="services">
          <li>
            <Dot ok={h.lh.reachable} />
            <span>
              LearnHarness {h.lh.reachable ? "reachable" : "not responding"}
              <br />
              <span className="muted">Last sync: {dateTime(h.lh.lastSyncAt)}</span>
              {h.lh.error && <span className="error-line">{h.lh.error}</span>}
            </span>
          </li>
          <li>
            <Dot ok={h.eval.reachable} />
            <span>
              Grading (eval) {h.eval.reachable ? "reachable" : "not responding"}
              {h.eval.error && <span className="error-line">{h.eval.error}</span>}
            </span>
          </li>
          <li>
            <Dot ok={h.worker.alive} />
            <span>
              Worker {h.worker.alive ? "alive" : "stopped"}
              <br />
              <span className="muted">Last heartbeat: {dateTime(h.worker.lastHeartbeatAt)}</span>
            </span>
          </li>
          <li>
            <Dot ok={h.jobs.failed === 0} />
            <span>
              Jobs: {h.jobs.queued} queued, {h.jobs.running} running, {h.jobs.failed} failed
              {h.jobs.oldestQueuedAt && (
                <>
                  <br />
                  <span className="muted">Oldest queued: {dateTime(h.jobs.oldestQueuedAt)}</span>
                </>
              )}
            </span>
          </li>
        </ul>
      </section>
      <section className="block">
        <h2>Backup</h2>
        <p>
          <Dot ok={h.backup.lastOk === true} /> Last: {dateTime(h.backup.lastAt)}
          {h.backup.lastOk === false && " (failed)"}
        </p>
        {mb && <p className="muted">Repository size: {mb} MB</p>}
        {h.backup.sizeWarning && <p className="notice">The backup repository exceeds 1 GB.</p>}
      </section>
      <section className="block">
        <h2>LLM in use</h2>
        <dl className="pairs">
          <dt>Provider</dt>
          <dd>{h.llm.provider === "claude-cli" ? "Claude (CLI)" : "OpenAI-compatible"}</dd>
          <dt>Cheap model</dt>
          <dd>{h.llm.cheapModel}</dd>
          <dt>Strong model</dt>
          <dd>{h.llm.strongModel}</dd>
          <dt>Calls in 24 h</dt>
          <dd>
            {h.llm.calls24h}
            {h.llm.failed24h > 0 && `, ${h.llm.failed24h} failed`}
          </dd>
          {h.metrics.questionsWithConceptPct !== null && (
            <>
              <dt>LH questions with a concept</dt>
              <dd>{Math.round(h.metrics.questionsWithConceptPct)} %</dd>
            </>
          )}
        </dl>
      </section>
    </>
  );
}

const MISS: Record<keyof Profile["missClassCounts"], string> = {
  cue: "cue",
  discrimination: "discrimination",
  execution: "execution",
  careless: "careless",
  structural: "structural",
};

function Profile({ p }: { p: Profile }) {
  const failures = Object.entries(p.missClassCounts)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${MISS[k as keyof Profile["missClassCounts"]]} ${n}`)
    .join(", ");
  return (
    <>
      <p>
        Recurring errors: <strong>{p.recurringErrors.length}</strong>
      </p>
      <p className="muted">{failures ? `LH misses (90 d): ${failures}.` : "No classified misses in 90 days."}</p>
      <p className="muted">Calibration per subject: {p.calibration.length}</p>
    </>
  );
}

function UsageTable({ u }: { u: LlmUsage }) {
  if (!u.rows.length) return <p className="muted">No calls in this period.</p>;
  const n = new Intl.NumberFormat("en-GB");
  return (
    <div className="table-scroll">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Task</th>
            <th scope="col">Model</th>
            <th scope="col" className="num">
              Calls
            </th>
            <th scope="col" className="num">
              Tokens (input / output)
            </th>
          </tr>
        </thead>
        <tbody>
          {u.rows.map((r, i) => (
            <tr key={i}>
              <th scope="row">{r.task}</th>
              <td>
                {r.model} <span className="muted">· {r.provider}</span>
              </td>
              <td className="num">
                {n.format(r.calls)}
                {r.ok < r.calls && <span className="muted"> ({r.calls - r.ok} failed)</span>}
              </td>
              <td className="num">
                {n.format(r.inputTokens)} / {n.format(r.outputTokens)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
