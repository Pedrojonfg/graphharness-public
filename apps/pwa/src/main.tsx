import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import { Layout, MorePage, NotFoundPage } from "./Layout.tsx";
import { SettingsPage } from "./pages/SettingsPage.tsx";
import { InboxPage } from "./pages/InboxPage.tsx";
import { DiagnosticPage } from "./pages/DiagnosticPage.tsx";
import { ExercisesPage } from "./pages/ExercisesPage.tsx";
import { ExamsPage } from "./pages/ExamsPage.tsx";
import { TodayPage } from "./pages/TodayPage.tsx";
import { ReportPage, ReportsPage } from "./pages/ReportsPage.tsx";
import { PriorReportPage } from "./pages/PriorPage.tsx";
import { WeekPage } from "./pages/WeekPage.tsx";
import { CardsPage } from "./pages/CardsPage.tsx";
import { SearchPage } from "./pages/SearchPage.tsx";
import { MaterialsPage } from "./pages/MaterialsPage.tsx";
import { SessionsPage } from "./pages/SessionsPage.tsx";
import { SyllabusPage } from "./pages/SyllabusPage.tsx";

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: "/", element: <TodayPage /> },
      { path: "/cards", element: <CardsPage /> },
      { path: "/exercises", element: <ExercisesPage /> },
      // The map (React Flow + dagre) is loaded separately: it is the heaviest part and is not needed for review.
      { path: "/map", lazy: async () => ({ Component: (await import("./pages/MapPage.tsx")).MapPage }) },
      { path: "/concepts/:id", lazy: async () => ({ Component: (await import("./pages/MapPage.tsx")).ConceptPage }) },
      { path: "/exams", element: <ExamsPage /> },
      { path: "/exams/:id/prepare", element: <DiagnosticPage /> },
      { path: "/reports", element: <ReportsPage /> },
      { path: "/reports/:id", element: <ReportPage /> },
      { path: "/prior/:id", element: <PriorReportPage /> },
      { path: "/week", element: <WeekPage /> },
      { path: "/syllabus", element: <SyllabusPage /> },
      { path: "/search", element: <SearchPage /> },
      { path: "/sessions", element: <SessionsPage /> },
      { path: "/materials", element: <MaterialsPage /> },
      { path: "/inbox", element: <InboxPage /> },
      { path: "/settings", element: <SettingsPage /> },
      { path: "/more", element: <MorePage /> },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
