// App shell: bottom bar on mobile (four daily-use screens + "More") and a sidebar on desktop.
import type { ReactNode } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router";

const s = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" } as const;
const I = (d: ReactNode) => (
  <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" {...s}>
    {d}
  </svg>
);

const ICON = {
  today: I(
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>,
  ),
  cards: I(
    <>
      <rect x="3" y="6" width="14" height="14" rx="2" />
      <path d="M7 3h11a3 3 0 0 1 3 3v11" />
    </>,
  ),
  exercises: I(<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4zM13.5 6.5l4 4" />),
  map: I(
    <>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="8" r="2.5" />
      <circle cx="11" cy="18" r="2.5" />
      <path d="M8.2 7.2l7.5.6M7.2 8.2l2.8 7.6M16.6 10.1l-4.2 5.8" />
    </>,
  ),
  more: I(
    <>
      <circle cx="5" cy="12" r="1.2" />
      <circle cx="12" cy="12" r="1.2" />
      <circle cx="19" cy="12" r="1.2" />
    </>,
  ),
  exams: I(
    <>
      <rect x="4" y="5" width="16" height="16" rx="2" />
      <path d="M8 3v4M16 3v4M4 10h16" />
    </>,
  ),
  week: I(
    <>
      <rect x="4" y="5" width="16" height="16" rx="2" />
      <path d="M8 3v4M16 3v4M4 10h16M8 14h3M8 17h3M13 14h3" />
    </>,
  ),
  syllabus: I(<path d="M5 4h14M5 9h14M9 14h10M9 19h10M5 14h.01M5 19h.01" />),
  reports: I(<path d="M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6" />),
  inbox: I(<path d="M3 13l3-8h12l3 8v6H3zM3 13h5l1 3h6l1-3h5" />),
  settings: I(
    <>
      <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="8" cy="17" r="2" />
    </>,
  ),
  search: I(
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3-3" />
    </>,
  ),
  sessions: I(
    <>
      <path d="M4 6h16v12H4z" />
      <path d="M8 10h8M8 14h5" />
    </>,
  ),
  materials: I(
    <>
      <path d="M4 4h10v16H4z" />
      <path d="M14 8h6v12h-6z" />
    </>,
  ),
};

const PRIMARY_NAV = [
  { to: "/", label: "Today", icon: ICON.today, end: true },
  { to: "/cards", label: "Cards", icon: ICON.cards },
  { to: "/exercises", label: "Exercises", icon: ICON.exercises },
  { to: "/map", label: "Map", icon: ICON.map },
];

export const SECONDARY_NAV = [
  { to: "/week", label: "Week", icon: ICON.week },
  { to: "/syllabus", label: "Syllabus", icon: ICON.syllabus },
  { to: "/search", label: "Search", icon: ICON.search },
  { to: "/sessions", label: "Sessions", icon: ICON.sessions },
  { to: "/materials", label: "Materials", icon: ICON.materials },
  { to: "/exams", label: "Exams", icon: ICON.exams },
  { to: "/reports", label: "Reports", icon: ICON.reports },
  { to: "/inbox", label: "Inbox", icon: ICON.inbox },
  { to: "/settings", label: "Settings", icon: ICON.settings },
];

export function Layout() {
  const { pathname } = useLocation();
  const inMore = SECONDARY_NAV.some((x) => pathname.startsWith(x.to)) || pathname === "/more";
  return (
    <div className="app">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <nav className="side" aria-label="Sections">
        <p className="brand">Study hub</p>
        <ul>
          {[...PRIMARY_NAV, ...SECONDARY_NAV].map((x) => (
            <li key={x.to}>
              <NavLink to={x.to} end={"end" in x}>
                {x.icon}
                {x.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <div id="main-content" className="main-content" tabIndex={-1}>
        <Outlet />
      </div>
      <nav className="bottom" aria-label="Sections">
        {PRIMARY_NAV.map((x) => (
          <NavLink key={x.to} to={x.to} end={"end" in x}>
            {x.icon}
            <span>{x.label}</span>
          </NavLink>
        ))}
        <Link to="/more" className={inMore ? "active" : undefined} aria-current={inMore ? "page" : undefined}>
          {ICON.more}
          <span>More</span>
        </Link>
      </nav>
    </div>
  );
}

export function MorePage() {
  return (
    <main className="page page-narrow">
      <header className="page-header">
        <h1>More</h1>
      </header>
      <ul className="list">
        {SECONDARY_NAV.map((x) => (
          <li key={x.to}>
            <Link className="row row-button row-icon" to={x.to}>
              {x.icon}
              <span className="row-title">{x.label}</span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}

export function NotFoundPage() {
  return (
    <main className="page page-narrow">
      <header className="page-header">
        <h1>This page does not exist</h1>
      </header>
      <p>
        <Link className="btn btn-primary" to="/">
          Go to Today
        </Link>
      </p>
    </main>
  );
}
