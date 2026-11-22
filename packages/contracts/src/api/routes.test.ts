import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MCP_TOOLS } from "../mcp.ts";
import { API_ROUTES } from "./routes.ts";

// Route list, row by row, + ADR 102 §12.
const API_ROUTE_LIST = [
  "GET /subjects",
  "POST /subjects",
  "PATCH /subjects/:id",
  "GET /subjects/:id/map",
  "GET /subjects/:id/overview",
  "POST /knowledge/search",
  "POST /knowledge/resolve",
  "GET /concepts/:id",
  "POST /concepts/:id/notes",
  "PATCH /concepts/:id/state",
  "POST /concepts/:id/merge",
  "POST /concepts/:id/split",
  "PATCH /concepts/:id",
  "PATCH /concept-edges",
  "GET /concept-suggestions",
  "POST /concept-suggestions/:id/accept",
  "GET /cards/queue",
  "POST /cards/:id/review",
  "POST /cards/:id/retire",
  "POST /cards/import",
  "POST /exercises",
  "POST /exercises/:instanceId/attempt",
  "POST /exercises/:instanceId/hint",
  "POST /exercises/:instanceId/explain",
  "POST /diagnostics",
  "POST /diagnostics/:id/answer",
  "GET /exams",
  "POST /exams",
  "PATCH /exams/:id",
  "DELETE /exams/:id",
  "GET /sessions",
  "POST /sessions/:chatId/close",
  "GET /reports",
  "GET /reports/:id",
  "POST /reports/:id/render",
  "GET /reports/:id/pdf",
  "GET /brief",
  "GET /health",
  // ADR 104.
  "GET /mastery",
  // ADR 105 §5.
  "GET /errors",
  "GET /profile",
  "POST /capture",
  // ADR 109 §7.
  "GET /lens-feedback",
  "POST /lens-feedback",
  // ADR 102 §12 (gaps in the route list).
  "POST /sessions",
  "GET /inbox",
  "POST /concept-suggestions/:id/dismiss",
  "GET /llm-usage",
  // ADR 105 §7.
  "GET /plan",
  // ADR 105 §6.
  "GET /prior-reports",
  "GET /prior-reports/:id",
  "PUT /syllabus/:subjectId",
  "GET /syllabus/:subjectId",
  "GET /syllabus/:subjectId/gaps",
  "GET /materials/:subjectId",
  "POST /materials/notes",
  "POST /materials/import",
];

// Tool list, row by row, + ADR 102 §12.
const MCP_TOOL_LIST = [
  "resolve_concepts",
  "get_concept",
  "search_knowledge",
  "get_subject_overview",
  "get_daily_brief",
  "declare_learning",
  "answer_confirmation",
  "add_concept_note",
  "import_class_notes",
  "import_material",
  "start_session",
  "close_session",
  "upsert_exam",
  "list_exams",
  "get_session_report",
  "render_pdf",
  "create_subject",
  "list_concept_suggestions",
  "accept_concept_suggestion",
  // ADR 102 §12.
  "dismiss_concept_suggestion",
  // ADR 105 §7.
  "get_week_plan",
  // ADR 105 §6.
  "get_prior_knowledge",
  "import_syllabus",
  "get_syllabus_gaps",
  // ADR 108: TikZ figures.
  "compile_tikz_fragment",
  "save_figure",
  "list_figure_templates",
  // ADR 109 §7.
  "list_lens_feedback",
];

describe("API_ROUTES", () => {
  it("covers exactly the routes of the route list", () => {
    const got = API_ROUTES.map((r) => `${r.method.toUpperCase()} ${r.path}`);
    expect(new Set(got).size).toBe(got.length);
    expect([...got].sort()).toEqual([...API_ROUTE_LIST].sort());
  });

  it("each route parameter has a params schema, and nothing else", () => {
    for (const r of API_ROUTES) {
      const inPath = [...r.path.matchAll(/:(\w+)/g)].map((m) => m[1]).sort();
      expect(Object.keys(r.params?.shape ?? {}).sort(), `${r.method} ${r.path}`).toEqual(inPath);
    }
  });
});

describe("MCP_TOOLS", () => {
  it("covers exactly the tools of the tool list", () => {
    const got = MCP_TOOLS.map((t) => t.name);
    expect(new Set(got).size).toBe(got.length);
    expect([...got].sort()).toEqual([...MCP_TOOL_LIST].sort());
  });

  it("only marks read-only tools as readOnly (the agent's guard does not ask for confirmation for them)", () => {
    const ro = MCP_TOOLS.filter((t) => "readOnly" in t && t.readOnly).map((t) => t.name);
    expect(ro.sort()).toEqual(
      [
        "get_concept",
        "get_daily_brief",
        "get_prior_knowledge",
        "get_session_report",
        "get_subject_overview",
        "get_syllabus_gaps",
        "get_week_plan",
        "list_concept_suggestions",
        "list_exams",
        "list_figure_templates",
        "list_lens_feedback",
        "resolve_concepts",
        "search_knowledge",
      ].sort(),
    );
  });

  it("input and output are objects (the SDK and structuredContent require it) and the example in the description is a valid input", () => {
    for (const t of MCP_TOOLS) {
      expect(t.input, t.name).toBeInstanceOf(z.ZodObject);
      expect(t.output, t.name).toBeInstanceOf(z.ZodObject);
      const example = /Example: (\{.*\})$/s.exec(t.description)?.[1];
      expect(example, `${t.name}: missing "Example: {…}" at the end`).toBeDefined();
      const parsed = (t.input as z.ZodTypeAny).safeParse(JSON.parse(example!));
      expect(parsed.success, `${t.name}: ${parsed.error?.message}`).toBe(true);
    }
  });
});
