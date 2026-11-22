// Search the Hub knowledge (parity with MCP search_knowledge / resolve_concepts).
import type { SearchKnowledgeResponse } from "@graphharness/contracts";
import { useId, useState } from "react";
import { Link } from "react-router";
import { api } from "../api.ts";
import { ErrorBox, StateChip, PageHeader } from "../components/Ui.tsx";

export function SearchPage() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchKnowledgeResponse | null>(null);
  const [solved, setSolved] = useState<Awaited<ReturnType<typeof api.resolveConcepts>> | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const id = useId();

  async function search() {
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    setError(null);
    setSolved(null);
    try {
      setResults(await api.searchKnowledge({ query: q, limit: 20 }));
    } catch (e) {
      setError(e);
      setResults(null);
    } finally {
      setSearching(false);
    }
  }

  async function resolver() {
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    setError(null);
    try {
      setSolved(await api.resolveConcepts({ text: q, limit: 8 }));
    } catch (e) {
      setError(e);
      setSolved(null);
    } finally {
      setSearching(false);
    }
  }

  return (
    <main className="page page-narrow">
      <PageHeader title="Search" sub="Concepts and propositions by free text." />
      <label className="field-label" htmlFor={`${id}-q`}>
        Text
      </label>
      <input
        id={`${id}-q`}
        className="input"
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && search()}
        maxLength={500}
        autoComplete="off"
      />
      <div className="actions">
        <button type="button" className="btn btn-primary" disabled={searching || query.trim() === ""} onClick={search}>
          {searching ? "Searching…" : "Search"}
        </button>
        <button type="button" className="btn btn-quiet" disabled={searching || query.trim() === ""} onClick={resolver}>
          Resolve concepts
        </button>
      </div>
      <ErrorBox error={error} />
      {results && (
        <>
          <section className="block">
            <h2>Concepts ({results.concepts.length})</h2>
            {results.concepts.length === 0 ? (
              <p className="muted">No concept matches.</p>
            ) : (
              <ul className="list">
                {results.concepts.map((c) => (
                  <li key={c.conceptId}>
                    <Link className="row row-button" to={`/concepts/${c.conceptId}`}>
                      <span className="row-title">{c.name}</span>
                      <span className="muted">
                        {c.subject ?? "No subject"} · <StateChip state={c.state} />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="block">
            <h2>Propositions ({results.propositions.length})</h2>
            {results.propositions.length === 0 ? (
              <p className="muted">No proposition matches.</p>
            ) : (
              <ul className="list-simple">
                {results.propositions.map((p) => (
                  <li key={p.propositionId}>
                    <strong>{p.name}</strong>
                    {p.conceptId ? (
                      <>
                        {" "}
                        · <Link to={`/concepts/${p.conceptId}`}>{p.conceptName}</Link>
                      </>
                    ) : (
                      p.conceptName && <span className="muted"> · {p.conceptName}</span>
                    )}
                    <p className="muted">{p.statement}</p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
      {solved && (
        <section className="block">
          <h2>Candidates ({solved.candidates.length})</h2>
          {solved.candidates.length === 0 ? (
            <p className="muted">No clear candidates.</p>
          ) : (
            <ul className="list">
              {solved.candidates.map((c) => (
                <li key={c.conceptId}>
                  <Link className="row row-button" to={`/concepts/${c.conceptId}`}>
                    <span className="row-title">{c.name}</span>
                    <span className="muted">
                      {c.subject ?? "No subject"} · {Math.round(c.score * 100)} % · <StateChip state={c.state} />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </main>
  );
}
