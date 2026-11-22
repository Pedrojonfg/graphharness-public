// Subject materials and import into LearnHarness.
import type { ImportFileResult } from "@graphharness/contracts";
import { useId, useState } from "react";
import { api } from "../api.ts";
import { WhenLoaded, ErrorBox, PageHeader, useLoadable } from "../components/Ui.tsx";

export function MaterialsPage() {
  const subjects = useLoadable(() => api.subjects(), []);
  const [subjectId, setSubjectId] = useState("");
  const id = useId();
  return (
    <main className="page page-narrow">
      <PageHeader title="Materials" sub="Files on the VPS and import into LearnHarness." />
      <WhenLoaded loadable={subjects} text="Loading subjects…">
        {(list) => {
          const active = list.filter((s) => !s.archivedAt);
          if (active.length === 0) return <p className="empty">No active subjects.</p>;
          return (
            <>
              <label className="field-label" htmlFor={`${id}-s`}>
                Subject
              </label>
              <select id={`${id}-s`} className="input" value={subjectId} onChange={(e) => setSubjectId(e.target.value)}>
                <option value="">Pick a subject</option>
                {active.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              {subjectId && <MaterialList key={subjectId} subjectId={subjectId} />}
            </>
          );
        }}
      </WhenLoaded>
    </main>
  );
}

function MaterialList({ subjectId }: { subjectId: string }) {
  const loadable = useLoadable(() => api.materials(subjectId), [subjectId]);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [results, setResults] = useState<ImportFileResult[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [title, setTitle] = useState("");
  const [markdown, setMarkdown] = useState("");
  const [notesResult, setNotesResult] = useState<ImportFileResult | null>(null);
  const id = useId();

  function toggle(path: string) {
    setSelection((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  async function runImport() {
    if (selection.size === 0) return;
    setImporting(true);
    setError(null);
    setResults(null);
    try {
      const { results } = await api.importMaterial({ subjectId, paths: [...selection] });
      setResults(results);
      loadable.reload();
    } catch (e) {
      setError(e);
    } finally {
      setImporting(false);
    }
  }

  async function importNotes() {
    setImporting(true);
    setError(null);
    setNotesResult(null);
    try {
      const res = await api.importClassNotes({ subjectId, title: title.trim(), markdown: markdown.trim() });
      setNotesResult(res.result);
      setTitle("");
      setMarkdown("");
      loadable.reload();
    } catch (e) {
      setError(e);
    } finally {
      setImporting(false);
    }
  }

  return (
  <>
      <WhenLoaded loadable={loadable} text="Loading materials…">
        {(m) =>
          m.files.length === 0 ? (
            <p className="empty">No files in this subject's folder.</p>
          ) : (
            <section className="block">
              <h2>Files ({m.files.length})</h2>
              <ul className="list-simple">
                {m.files.map((f) => (
                  <li key={f.relative}>
                    <label>
                      <input type="checkbox" checked={selection.has(f.relative)} onChange={() => toggle(f.relative)} />
                      <span>
                        {f.name}
                        <span className="muted"> · {f.relative}</span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
              <div className="actions">
                <button type="button" className="btn btn-primary" disabled={importing || selection.size === 0} onClick={runImport}>
                  {importing ? "Importing…" : `Import to LH (${selection.size})`}
                </button>
              </div>
            </section>
          )
        }
      </WhenLoaded>

      <section className="block">
        <h2 id={`${id}-h`}>Class notes</h2>
        <label className="field-label" htmlFor={`${id}-t`}>
          Title
        </label>
        <input id={`${id}-t`} className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
        <label className="field-label" htmlFor={`${id}-m`}>
          Markdown
        </label>
        <textarea id={`${id}-m`} className="input" rows={8} value={markdown} onChange={(e) => setMarkdown(e.target.value)} maxLength={200000} />
        <div className="actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={importing || title.trim() === "" || markdown.trim() === ""}
            onClick={importNotes}
          >
            {importing ? "Saving…" : "Import notes"}
          </button>
        </div>
      </section>

      <ErrorBox error={error} />
      {results && <ResultsImport title="File import" results={results} />}
      {notesResult && <ResultsImport title="Class notes" results={[notesResult]} />}
    </>
  );
}

function ResultsImport({ title, results }: { title: string; results: ImportFileResult[] }) {
  return (
    <section className="block" role="status">
      <h2>{title}</h2>
      <ul className="list-simple">
        {results.map((r) => (
          <li key={r.path}>
            <span className={r.ok ? "state-ok" : "state-bad"}>{r.ok ? "OK" : "Error"}</span> {r.path}
            <span className="muted"> · {r.outcome}</span>
            {r.error && <span className="error-line"> {r.error}</span>}
            {r.notice && <span className="muted"> · {r.notice}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}
