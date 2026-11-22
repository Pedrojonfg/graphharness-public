// L4 — reports: GET /reports*, on-demand render with REAL pdflatex, GET .../pdf, MCP get_session_report and render_pdf.
import { MasterReportSchema, RenderReportResponseSchema, ReportListSchema, ReportSchema, SessionReportSchema } from "@graphharness/contracts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sessionsTools } from "../../src/mcp/sessions.ts";
import { daysFromNow, insertReport, masterReportData, sessionReportData, subject, world, call } from "../knowledge/helpers.ts";

const pdflatexOk = (() => {
  try {
    execFileSync("pdflatex", ["--version"], { stdio: "ignore" });
    return true;
  } catch (e) {
    console.warn("pdflatex unavailable; the render tests are skipped:", (e as Error).message);
    return false;
  }
})();

function setup() {
  const reportsDir = mkdtempSync(join(tmpdir(), "gh-reports-"));
  const w = world({ config: { reportsDir } });
  const s = subject(w.ctx, "Linear Algebra");
  const session = insertReport(w.ctx.db, { kind: "session", chatId: "c_1", subjectId: s, data: sessionReportData("c_1", s), createdAt: daysFromNow(-1) });
  const master = insertReport(w.ctx.db, { kind: "master", subjectId: s, data: masterReportData(s), createdAt: daysFromNow(-0.5) });
  return { ...w, s, session, master, reportsDir };
}

describe("GET /reports and GET /reports/:id", () => {
  it("lists from newest to oldest with kind and subjectId filters", async () => {
    const { ctx, app, s, session, master } = setup();
    const other = subject(ctx, "Physics");
    const o = insertReport(ctx.db, { kind: "master", subjectId: other, data: masterReportData(other), createdAt: daysFromNow(-3) });
    const all = ReportListSchema.parse((await call(app, "get", "/reports")).json);
    expect(all.map((r) => r.id)).toEqual([master, session, o]);
    expect(all.find((r) => r.id === session)).toMatchObject({ kind: "session", chatId: "c_1", subjectId: s, hasPdf: false, omitted: [] });
    expect(all.find((r) => r.id === master)).toMatchObject({ kind: "master", chatId: null, subjectId: s, hasPdf: false });
    expect(ReportListSchema.parse((await call(app, "get", "/reports?kind=session")).json).map((r) => r.id)).toEqual([session]);
    expect(ReportListSchema.parse((await call(app, "get", `/reports?subjectId=${other}`)).json).map((r) => r.id)).toEqual([o]);
    expect((await call(app, "get", "/reports?kind=other")).status).toBe(400);
  });

  it("detail of a session report and a master report with their data; 404", async () => {
    const { app, s, session, master } = setup();
    const a = ReportSchema.parse((await call(app, "get", `/reports/${session}`)).json);
    expect(a.kind).toBe("session");
    expect(SessionReportSchema.parse(a).data.chatId).toBe("c_1");
    expect(MasterReportSchema.parse((await call(app, "get", `/reports/${master}`)).json).data.subjectId).toBe(s);
    const nf = await call(app, "get", "/reports/nope");
    expect(nf.status).toBe(404);
    expect(nf.json).toEqual({ error: "not_found" });
  });
});

describe.skipIf(!pdflatexOk)("PDF render (real pdflatex)", () => {
  it("GET pdf before rendering → 409 not_rendered; render → PDF on disk; GET pdf → application/pdf", async () => {
    const { ctx, app, session, reportsDir } = setup();
    const before = await call(app, "get", `/reports/${session}/pdf`);
    expect(before.status).toBe(409);
    expect(before.json).toMatchObject({ error: "not_rendered" });

    const r = await call(app, "post", `/reports/${session}/render`);
    expect(r.status).toBe(200);
    const out = RenderReportResponseSchema.parse(r.json);
    expect(out.reportId).toBe(session);
    expect(out.pdfUrl).toBe(`/api/v1/reports/${session}/pdf`);
    expect(out.omitted).toEqual([]);
    expect(out.path.startsWith(reportsDir)).toBe(true);
    expect(existsSync(out.path)).toBe(true);
    expect(readFileSync(out.path).subarray(0, 4).toString("latin1")).toBe("%PDF");
    expect(ctx.db.prepare("SELECT pdf_path FROM reports WHERE id = ?").pluck().get(session)).toBe(out.path);

    const pdf = await app.request(`/api/v1/reports/${session}/pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toContain("application/pdf");
    const bytes = Buffer.from(await pdf.arrayBuffer());
    expect(bytes.subarray(0, 4).toString("latin1")).toBe("%PDF");
    expect(bytes.equals(readFileSync(out.path))).toBe(true);

    const listed = ReportListSchema.parse((await call(app, "get", "/reports")).json);
    expect(listed.find((x) => x.id === session)!.hasPdf).toBe(true);
    expect(SessionReportSchema.parse((await call(app, "get", `/reports/${session}`)).json).hasPdf).toBe(true);
  }, 120_000);

  it("MCP render_pdf returns the PDF path and get_session_report the report by chatId", async () => {
    const { ctx, session } = setup();
    const { path } = (await sessionsTools.render_pdf!(ctx, { reportId: session })) as { path: string };
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path).subarray(0, 4).toString("latin1")).toBe("%PDF");
  }, 120_000);
});

describe("render: errors that do not need pdflatex", () => {
  it("404 on render, pdf and MCP with an unknown id", async () => {
    const { ctx, app } = setup();
    expect((await call(app, "post", "/reports/nope/render")).status).toBe(404);
    expect((await call(app, "get", "/reports/nope/pdf")).status).toBe(404);
    await expect(sessionsTools.render_pdf!(ctx, { reportId: "nope" })).rejects.toMatchObject({ status: 404 });
  });
});

describe("MCP get_session_report", () => {
  it("returns the session's report (without .tex) and 404 if there is none", async () => {
    const { ctx, session } = setup();
    const r = SessionReportSchema.parse(await sessionsTools.get_session_report!(ctx, { chatId: "c_1" }));
    expect(r.id).toBe(session);
    expect(r).not.toHaveProperty("tex");
    await expect(sessionsTools.get_session_report!(ctx, { chatId: "nope" })).rejects.toMatchObject({ status: 404 });
  });

  it("with several reports of the same session returns the most recent", async () => {
    const { ctx } = setup();
    const newer = insertReport(ctx.db, { kind: "session", chatId: "c_1", data: sessionReportData("c_1", null), createdAt: daysFromNow(2) });
    expect(SessionReportSchema.parse(await sessionsTools.get_session_report!(ctx, { chatId: "c_1" })).id).toBe(newer);
  });
});
