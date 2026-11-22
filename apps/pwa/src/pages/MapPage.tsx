// Map: concept graph of the subject colored by state; tapping a node opens its detail.
import type { ConceptState, SubjectMap } from "@graphharness/contracts";
import { useEffect, useMemo } from "react";
import { useParams, useSearchParams } from "react-router";
import { api } from "../api.ts";
import { WhenLoaded, StateChip, PageHeader, STATE_LABEL, date, useLoadable } from "../components/Ui.tsx";
import { ConceptDetail } from "../map/ConceptDetail.tsx";
import { GraphCanvas } from "../map/GraphCanvas.tsx";

const LAST = "pwa.map.subject";
const STATES: ConceptState[] = ["solid", "review", "weak", "unknown"];

function readLast(): string | null {
  try {
    return localStorage.getItem(LAST);
  } catch (e) {
    console.warn("localStorage not available", e);
    return null;
  }
}

function saveLast(id: string) {
  try {
    localStorage.setItem(LAST, id);
  } catch (e) {
    console.warn("localStorage not available", e);
  }
}

export function MapPage() {
  const [params, setParams] = useSearchParams();
  const subjects = useLoadable(() => api.subjects(), []);
  const active = useMemo(() => subjects.data?.filter((s) => !s.archivedAt) ?? [], [subjects.data]);
  const subject = params.get("subject");
  const concept = params.get("concept");

  // No subject in the URL: the last one viewed (if it still exists) or the first one.
  useEffect(() => {
    if (subject || !active.length) return;
    const last = readLast();
    const id = active.some((s) => s.id === last) ? last! : active[0]!.id;
    setParams({ subject: id }, { replace: true });
  }, [subject, active]);

  useEffect(() => {
    if (subject) saveLast(subject);
  }, [subject]);

  const set = (p: { subject?: string; concept?: string | null }) => {
    const next = new URLSearchParams(params);
    if (p.subject) {
      next.set("subject", p.subject);
      next.delete("concept");
    }
    if (p.concept === null) next.delete("concept");
    else if (p.concept) next.set("concept", p.concept);
    setParams(next);
  };

  return (
    <main className="page page-wide">
      <PageHeader
        title="Map"
        accessory={
          active.length > 1 && (
            <label className="selector">
              <span className="sr-only">Subject</span>
              <select className="input" value={subject ?? ""} onChange={(e) => set({ subject: e.target.value })}>
                {active.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          )
        }
      />
      <WhenLoaded loadable={subjects}>
        {() =>
          active.length === 0 ? (
            <p className="empty">No subjects yet.</p>
          ) : subject ? (
            <>
              <SubjectSummary subjectId={subject} />
              <MapSubject key={subject} subjectId={subject} concept={concept} onPick={(id) => set({ concept: id })} onClose={() => set({ concept: null })} />
            </>
          ) : null
        }
      </WhenLoaded>
    </main>
  );
}

function SubjectSummary({ subjectId }: { subjectId: string }) {
  const loadable = useLoadable(() => api.subjectOverview(subjectId), [subjectId]);
  return (
    <details className="block">
      <summary>Summary</summary>
      <WhenLoaded loadable={loadable} text="Loading summary…">
        {(o) => {
          const n = (s: typeof o.conceptsByState.solid) => s.length;
          return (
            <>
              <p className="muted">
                {n(o.conceptsByState.solid)} mastered · {n(o.conceptsByState.review)} to review · {n(o.conceptsByState.weak)} weak ·{" "}
                {n(o.conceptsByState.unknown)} no data
              </p>
              {o.exams.length > 0 && (
                <ul className="list-simple">
                  {o.exams.map((e) => (
                    <li key={e.id}>
                      {e.title} — {date(e.date)}
                      {e.daysLeft >= 0 ? ` (in ${e.daysLeft} d)` : " (past)"}
                    </li>
                  ))}
                </ul>
              )}
            </>
          );
        }}
      </WhenLoaded>
    </details>
  );
}

function MapSubject({ subjectId, concept, onPick, onClose }: { subjectId: string; concept: string | null; onPick: (id: string) => void; onClose: () => void }) {
  const loadable = useLoadable(() => api.subjectMap(subjectId), [subjectId]);
  return (
    <WhenLoaded loadable={loadable} text="Loading the map…">
      {(map) => <MapView map={map} concept={concept} onPick={onPick} onClose={onClose} onChanged={loadable.reload} />}
    </WhenLoaded>
  );
}

function MapView({
  map,
  concept,
  onPick,
  onClose,
  onChanged,
}: {
  map: SubjectMap;
  concept: string | null;
  onPick: (id: string) => void;
  onClose: () => void;
  onChanged: () => void;
}) {
  const names = useMemo(() => new Map(map.concepts.map((c) => [c.id, c.name])), [map]);
  const counts = useMemo(() => {
    const r: Record<ConceptState, number> = { solid: 0, review: 0, weak: 0, unknown: 0 };
    for (const c of map.concepts) r[c.state]++;
    return r;
  }, [map]);

  useEffect(() => {
    if (!concept) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [concept, onClose]);

  if (map.concepts.length === 0) return <p className="empty">{map.subject.name} has no concepts yet. They appear when LearnHarness sessions are synced.</p>;

  return (
    <div className={`map${concept ? " map-with-detail" : ""}`}>
      <ul className="legend" aria-label="Legend">
        {STATES.map((s) => (
          <li key={s}>
            <span className={`legend-dot node-${s}`} aria-hidden="true" />
            {STATE_LABEL[s]} <span className="muted">{counts[s]}</span>
          </li>
        ))}
        <li>
          <span className="legend-dot legend-pending" aria-hidden="true" />
          Unconfirmed
        </li>
      </ul>
      <div className="map-canvas">
        <GraphCanvas map={map} focusId={concept} onNodeClick={onPick} />
      </div>
      <details className="map-list">
        <summary>View as list ({map.concepts.length})</summary>
        <ul className="list">
          {[...map.concepts]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((c) => (
              <li key={c.id}>
                <button type="button" className="row row-button" onClick={() => onPick(c.id)}>
                  <span className="row-title">{c.name}</span>
                  <StateChip state={c.state} pending={c.manualConfirmation === "pending"} />
                </button>
              </li>
            ))}
        </ul>
      </details>
      {concept && (
        <aside className="sheet" aria-label="Concept detail">
          <button type="button" className="btn btn-quiet sheet-close" onClick={onClose}>
            Close
          </button>
          <ConceptDetail key={concept} conceptId={concept} names={names} onChanged={onChanged} />
        </aside>
      )}
    </div>
  );
}

/** /concepts/:id — the same detail full screen (links from Today, Exercises...). */
export function ConceptPage() {
  const { id = "" } = useParams();
  return (
    <main className="page page-narrow">
      <ConceptDetail conceptId={id} />
    </main>
  );
}
