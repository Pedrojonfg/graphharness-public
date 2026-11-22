// Prior knowledge (ADR 105 §6): what you already know of what you are importing, in four groups. List and detail.
import type { PriorBucket, PriorReportSummary } from "@graphharness/contracts";
import { Link, useParams } from "react-router";
import { api } from "../api.ts";
import { WhenLoaded, date, dateTime, PageHeader, useLoadable } from "../components/Ui.tsx";

const BUCKETS: { bucket: PriorBucket; label: string; title: string }[] = [
  { bucket: "known", label: "known", title: "Known" },
  { bucket: "stale", label: "stale", title: "Stale" },
  { bucket: "weak", label: "weak", title: "Weak" },
  { bucket: "new", label: "new", title: "New" },
];

/** "70 % known · 20 % stale": only the groups that are not at 0 %. */
function percentageSummary(p: PriorReportSummary["percentages"]): string {
  return BUCKETS.filter((b) => p[b.bucket] > 0)
    .map((b) => `${p[b.bucket]} % ${b.label}`)
    .join(" · ");
}

export function PriorList({ subjectId }: { subjectId?: string }) {
  const loadable = useLoadable(() => api.priorReports(subjectId), [subjectId]);
  return (
    <WhenLoaded loadable={loadable} text="Loading prior knowledge…">
      {({ reports }) =>
        reports.length === 0 ? (
          <p className="empty">No prior-knowledge reports yet.</p>
        ) : (
          <ul className="list">
            {reports.map((r) => (
              <li key={r.id}>
                <Link className="row row-button" to={`/prior/${r.id}`}>
                  <span className="row-title">
                    {date(r.createdAt)} · {r.paths.length} {r.paths.length === 1 ? "path" : "paths"}
                  </span>
                  <span className="muted">{percentageSummary(r.percentages) || "No propositions"}</span>
                </Link>
              </li>
            ))}
          </ul>
        )
      }
    </WhenLoaded>
  );
}

export function PriorReportPage() {
  const { id = "" } = useParams();
  const loadable = useLoadable(() => api.priorReport(id), [id]);
  return (
    <main className="page page-narrow">
      <p>
        <Link to="/reports" className="link-action">
          All reports
        </Link>
      </p>
      <WhenLoaded loadable={loadable} text="Loading report…">
        {(r) => {
          const summary = percentageSummary(r.percentages);
          return (
            <>
              <PageHeader title="Prior knowledge" sub={`${dateTime(r.createdAt)} · ${r.total} ${r.total === 1 ? "proposition" : "propositions"}`} />
              {summary && (
                <>
                  <div className="bar-prior" role="img" aria-label={summary.replaceAll(" · ", ", ")}>
                    {BUCKETS.filter((b) => r.percentages[b.bucket] > 0).map((b) => (
                      <span key={b.bucket} className={`bar-${b.bucket}`} style={{ width: `${r.percentages[b.bucket]}%` }} />
                    ))}
                  </div>
                  <p className="muted">{summary}</p>
                </>
              )}
              {[...BUCKETS].reverse().map(({ bucket, title }) => {
                const items = r.items.filter((i) => i.bucket === bucket);
                if (items.length === 0) return null;
                return (
                  <section key={bucket} className="block" aria-labelledby={`g-${bucket}`}>
                    <h2 id={`g-${bucket}`}>
                      {title} · {items.length}
                    </h2>
                    <ul className="list-simple">
                      {items.map((i) => (
                        <li key={i.propositionId}>
                          {i.name}
                          {i.matchedConceptId && (
                            <>
                              {" "}
                              <span className="muted">· {i.relation === "related" ? "related to" : "your concept"}</span>{" "}
                              <Link to={`/concepts/${i.matchedConceptId}`}>{i.matchedConceptName}</Link>
                            </>
                          )}
                        </li>
                      ))}
                    </ul>
                  </section>
                );
              })}
            </>
          );
        }}
      </WhenLoaded>
    </main>
  );
}
