// Reports (D11): session reports and the master document per subject. HTML view of the data
// (text with KaTeX) and a "PDF" button that compiles on demand (POST render) and opens GET /reports/:id/pdf.
import type { MasterReport, ReportKind, SessionReport } from "@graphharness/contracts";
import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { api } from "../api.ts";
import { MathView, Paragraphs, TextWithMath } from "../components/MathView.tsx";
import { openAfterRequest, WhenLoaded, daysText, ErrorBox, StateChip, date, dateTime, pct, PageHeader, STATE_LABEL, useLoadable } from "../components/Ui.tsx";
import { PriorList } from "./PriorPage.tsx";

const FILTERS: { kind: ReportKind | null; label: string }[] = [
  { kind: null, label: "All" },
  { kind: "session", label: "Session" },
  { kind: "master", label: "Master" },
];

export function ReportsPage() {
  const [params, setParams] = useSearchParams();
  const kind = (params.get("type") as ReportKind | null) ?? null;
  const loadable = useLoadable(() => api.reports(kind ?? undefined), [kind]);
  return (
    <main className="page page-narrow">
      <PageHeader title="Reports" />
      <div className="segmented" role="group" aria-label="Report type">
        {FILTERS.map((f) => (
          <button
            key={f.label}
            type="button"
            className={`segment${kind === f.kind ? " chosen" : ""}`}
            aria-pressed={kind === f.kind}
            onClick={() => setParams(f.kind ? { type: f.kind } : {})}
          >
            {f.label}
          </button>
        ))}
      </div>
      <WhenLoaded loadable={loadable} text="Loading reports…">
        {(list) =>
          list.length === 0 ? (
            <p className="empty">No reports yet. They are generated when each LearnHarness session closes.</p>
          ) : (
            <ul className="list">
              {list.map((r) => (
                <li key={r.id}>
                  <Link className="row row-button" to={`/reports/${r.id}`}>
                    <span className="row-title">{r.title}</span>
                    <span className="muted">
                      {r.kind === "master" ? "Master document" : "Session"} · {dateTime(r.createdAt)}
                      {r.hasPdf && " · PDF"}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )
        }
      </WhenLoaded>
      <h2 className="section">Prior knowledge</h2>
      <PriorList />
    </main>
  );
}

export function ReportPage() {
  const { id = "" } = useParams();
  const loadable = useLoadable(() => api.report(id), [id]);
  return (
    <main className="page page-narrow report">
      <p>
        <Link to="/reports" className="link-action">
          All reports
        </Link>
      </p>
      <WhenLoaded loadable={loadable} text="Loading report…">
        {(r) => (
          <>
            <PageHeader title={r.title} sub={`${r.kind === "master" ? "Master document" : "Session report"} · ${dateTime(r.createdAt)}`} accessory={<ButtonPdf id={r.id} />} />
            {r.omitted.length > 0 && <Skipped omitted={r.omitted} />}
            {r.kind === "session" ? <SessionReportView r={r} /> : <MasterReportView r={r} />}
          </>
        )}
      </WhenLoaded>
    </main>
  );
}

function ButtonPdf({ id }: { id: string }) {
  const [state, setState] = useState<"ready" | "compiling">("ready");
  const [error, setError] = useState<unknown>(null);
  const [skipped, setSkipped] = useState<{ sectionKey: string; reason: string }[]>([]);
  async function pdf() {
    setState("compiling");
    setError(null);
    try {
      await openAfterRequest(async () => {
        const r = await api.renderReport(id);
        setSkipped(r.omitted);
        return api.reportPdfUrl(id);
      });
    } catch (e) {
      setError(e);
    } finally {
      setState("ready");
    }
  }
  return (
    <div className="pdf">
      <button type="button" className="btn btn-primary" disabled={state === "compiling"} onClick={pdf}>
        {state === "compiling" ? "Compiling PDF…" : "PDF"}
      </button>
      <ErrorBox error={error} />
      {skipped.length > 0 && <Skipped omitted={skipped} />}
    </div>
  );
}

function Skipped({ omitted }: { omitted: { sectionKey: string; reason: string }[] }) {
  return (
    <div className="notice-block">
      <p>Sections omitted from the PDF:</p>
      <ul className="list-simple">
        {omitted.map((o, i) => (
          <li key={i}>
            {o.sectionKey}: <span className="muted">{o.reason}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SessionReportView({ r }: { r: SessionReport }) {
  const d = r.data;
  const hits = d.questions.filter((q) => q.correct === true).length;
  const failures = d.questions.filter((q) => q.correct === false).length;
  return (
    <>
      {d.subjectName && <p className="muted">{d.subjectName} · closed {dateTime(d.closedAt)}</p>}
      {d.text ? (
        <section>
          <h2 className="section">Summary</h2>
          <Paragraphs text={d.text.summary} />
        </section>
      ) : (
        <p className="notice">The written text is not available; the report has only the data.</p>
      )}

      {d.conceptsTouched.length > 0 && (
        <section>
          <h2 className="section">Concepts touched</h2>
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Concept</th>
                  <th scope="col">Before</th>
                  <th scope="col">After</th>
                </tr>
              </thead>
              <tbody>
                {d.conceptsTouched.map((c) => (
                  <tr key={c.conceptId}>
                    <th scope="row">
                      <Link to={`/concepts/${c.conceptId}`}>{c.name}</Link>
                    </th>
                    <td>
                      {STATE_LABEL[c.before]} <span className="muted">{pct(c.probabilityBefore)}</span>
                    </td>
                    <td>
                      <StateChip state={c.after} /> <span className="muted">{pct(c.probabilityAfter)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section>
        <h2 className="section">Activity</h2>
        <ul className="list-simple">
          <li>
            {d.questions.length} questions: {hits} right, {failures} wrong
          </li>
          {d.practices.length > 0 && <li>{d.practices.length} practices</li>}
          <li>{d.cardsCreated} new cards</li>
        </ul>
        {d.practices.length > 0 && (
          <ul className="list-simple">
            {d.practices.map((p, i) => (
              <li key={i}>
                {p.outcome}
                {p.verdict && <span className="muted"> · {p.verdict}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>

      {d.text && d.text.reviewMaterial.length > 0 && (
        <section>
          <h2 className="section">Review material</h2>
          {d.text.reviewMaterial.map((m, i) => (
            <article key={i} className="review">
              <h3>
                <TextWithMath text={m.title} />
              </h3>
              <Paragraphs text={m.body} />
            </article>
          ))}
        </section>
      )}

      {d.text && d.text.mistakes.length > 0 && (
        <section>
          <h2 className="section">Mistakes and their correction</h2>
          <ul className="list-simple">
            {d.text.mistakes.map((m, i) => (
              <li key={i}>
                <TextWithMath text={m.mistake} />
                <br />
                <span className="muted">Correction: </span>
                <TextWithMath text={m.correction} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {d.errors.length > 0 && (
        <section>
          <h2 className="section">Exercise errors</h2>
          <ul className="list-simple">
            {d.errors.map((e, i) => (
              <li key={i}>
                <TextWithMath text={e.description} /> <span className="muted">· {e.times} {e.times === 1 ? "time" : "times"}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {d.declarations.length > 0 && (
        <section>
          <h2 className="section">Declarations</h2>
          <ul className="list-simple">
            {d.declarations.map((x) => (
              <li key={x.declarationId}>
                {x.name}: {STATE_LABEL[x.targetState]} <span className="muted">· {DECL[x.status]}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {d.verifiedFormulas.length > 0 && (
        <section>
          <h2 className="section">Formulas</h2>
          <dl className="formulas">
            {d.verifiedFormulas.map((f, i) => (
              <div key={i}>
                <dt>{f.label}</dt>
                <dd>
                  <MathView tex={f.latex} display />
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {d.nextRecommendation.length > 0 && (
        <section>
          <h2 className="section">Next up</h2>
          <ul className="list-simple">
            {d.nextRecommendation.map((c) => (
              <li key={c.conceptId} className="concept-line">
                <Link to={`/concepts/${c.conceptId}`}>{c.name}</Link>
                <span className="concept-line-meta">
                  <StateChip state={c.state} />
                  <span className="muted">{c.dependents} dependents</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

const DECL = { pending: "unconfirmed", confirmed: "confirmed", refuted: "refuted", expired: "expired" } as const;

function MasterReportView({ r }: { r: MasterReport }) {
  const d = r.data;
  return (
    <>
      <p className="muted">
        {d.subjectName} · generated {dateTime(d.generatedAt)}
      </p>
      {d.upcomingExams.length > 0 && (
        <section>
          <h2 className="section">Upcoming exams</h2>
          <ul className="list-simple">
            {d.upcomingExams.map((e) => (
              <li key={e.examId} className="exam-line">
                <span>
                  <strong>{e.title}</strong>
                  <br />
                  <span className="muted">
                    {date(e.date)}, {daysText(e.daysLeft)}
                    {e.unknownCount > 0 && ` · ${e.unknownCount} no record`}
                  </span>
                </span>
                <span className="prepared">{pct(e.preparedProbability)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <ConceptList title="Review frontier" empty="Nothing on the frontier." items={d.reviewFrontier} />
      <section>
        <h2 className="section">Weak and to review</h2>
        {d.weakAndReview.length === 0 ? (
          <p className="muted">None.</p>
        ) : (
          <ul className="list-simple">
            {d.weakAndReview.map((c) => (
              <li key={c.conceptId} className="concept-line">
                <Link to={`/concepts/${c.conceptId}`}>{c.name}</Link>
                <span className="concept-line-meta">
                  <StateChip state={c.state} />
                  <span className="muted">
                    {pct(c.probability)}
                    {c.stale && " · no recent evidence"}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h2 className="section">Errors you repeat most</h2>
        {d.recurringErrors.length === 0 ? (
          <p className="muted">None.</p>
        ) : (
          <ul className="list-simple">
            {d.recurringErrors.map((e, i) => (
              <li key={i}>
                <TextWithMath text={e.description} />{" "}
                <span className="muted">
                  · {e.templateName} · {e.timesSeen} times
                </span>
              </li>
            ))}
          </ul>
        )}
        {d.unpatternedFailures > 0 && <p className="muted">And {d.unpatternedFailures} failures without a pattern.</p>}
      </section>
      <section>
        <h2 className="section">Consolidated</h2>
        {d.consolidated.length === 0 ? <p className="muted">None yet.</p> : <p>{d.consolidated.map((c) => c.name).join(", ")}</p>}
      </section>
    </>
  );
}

function ConceptList({ title, empty, items }: { title: string; empty: string; items: MasterReport["data"]["reviewFrontier"] }) {
  return (
    <section>
      <h2 className="section">{title}</h2>
      {items.length === 0 ? (
        <p className="muted">{empty}</p>
      ) : (
        <ul className="list-simple">
          {items.map((c) => (
            <li key={c.conceptId} className="concept-line">
              <Link to={`/concepts/${c.conceptId}`}>{c.name}</Link>
              <StateChip state={c.state} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
