// Shared pieces: header, loading/error, concept states and formats.
import type { ConceptState, StartSessionBody } from "@graphharness/contracts";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api, errorMessage, HubError } from "../api.ts";

export function PageHeader({ title, sub, accessory }: { title: string; sub?: ReactNode; accessory?: ReactNode }) {
  return (
    <header className="page-header">
      <div className="page-header-row">
        <h1>{title}</h1>
        {accessory}
      </div>
      {sub && <p className="page-sub">{sub}</p>}
    </header>
  );
}

export function Loading({ text = "Loading…" }: { text?: string }) {
  return (
    <p className="loading" role="status">
      <span className="spinner" aria-hidden="true" />
      {text}
    </p>
  );
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (error === null || error === undefined) return null;
  return (
    <div className="error-box" role="alert">
      <p>{errorMessage(error)}</p>
      {onRetry && (
        <button type="button" className="btn btn-quiet" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export type Loadable<T> = { data: T | null; error: unknown; loading: boolean; reload: () => void; setData: (d: T) => void };

/** Loads a resource on mount (and when `deps` change), with loading, error and reload state. */
export function useLoadable<T>(fn: () => Promise<T>, deps: readonly unknown[]): Loadable<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    fnRef.current().then(
      (d) => {
        if (!live) return;
        setData(d);
        setLoading(false);
      },
      (e: unknown) => {
        if (!live) return;
        setError(e);
        setLoading(false);
      },
    );
    return () => {
      live = false;
    };
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload, setData };
}

/** Renders the loading/error of a `useLoadable` and, once there is data, `children(data)`. */
export function WhenLoaded<T>({ loadable, children, text }: { loadable: Loadable<T>; children: (data: T) => ReactNode; text?: string }) {
  if (loadable.error) return <ErrorBox error={loadable.error} onRetry={loadable.reload} />;
  if (loadable.data === null) return <Loading text={text} />;
  return <>{children(loadable.data)}</>;
}

export const STATE_LABEL: Record<ConceptState, string> = {
  solid: "Solid",
  review: "To review",
  weak: "Weak",
  unknown: "No record",
};

export function StateChip({ state, pending = false }: { state: ConceptState; pending?: boolean }) {
  return (
    <span className={`chip chip-${state}${pending ? " chip-pending" : ""}`}>
      {STATE_LABEL[state]}
      {pending && " · unconfirmed"}
    </span>
  );
}

export function pct(p: number | null | undefined): string {
  return p === null || p === undefined ? "—" : `${Math.round(p * 100)} %`;
}

export const longDate = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long" });
const dateFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });
const dateHourFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export function date(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T12:00:00`) : new Date(iso);
  return dateFmt.format(d);
}

export function dateTime(iso: string | null | undefined): string {
  return iso ? dateHourFmt.format(new Date(iso)) : "—";
}

export function daysText(d: number): string {
  if (d === 0) return "today";
  if (d === 1) return "tomorrow";
  if (d < 0) return `${-d} ${d === -1 ? "day" : "days"} ago`;
  return `in ${d} days`;
}

/**
 * Opens in another tab a URL that is only known after a request. The tab is opened right away (inside
 * the user gesture) so the browser does not block it, and it is closed if the request fails.
 */
export async function openAfterRequest(request: () => Promise<string>): Promise<string> {
  const w = window.open("about:blank", "_blank");
  try {
    const url = await request();
    if (w) w.location.href = url;
    else window.location.assign(url);
    return url;
  } catch (e) {
    w?.close();
    throw e;
  }
}

/** Opens a LearnHarness session (POST /sessions) in another tab, with the "no model configured" notice. */
export function useOpenSession() {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function open(body: StartSessionBody) {
    setOpening(true);
    setError(null);
    try {
      await openAfterRequest(async () => (await api.startSession(body)).url);
    } catch (e) {
      if (e instanceof HubError && e.code === "models_not_configured") {
        const missing = (e.body as { missing?: string[] } | null)?.missing ?? [];
        setError(new Error(`LearnHarness has no model configured${missing.length ? ` (missing: ${missing.join(", ")})` : ""}. Configure it in LearnHarness.`));
      } else setError(e);
    } finally {
      setOpening(false);
    }
  }
  return { opening, error, setError, open };
}
