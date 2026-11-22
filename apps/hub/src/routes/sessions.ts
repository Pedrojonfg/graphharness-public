// REST of the SESSIONS lane: /exams, /sessions, /reports. Thin routes: the logic is in services/.
import { readFileSync } from "node:fs";
import {
  ChatIdParamsSchema,
  CreateExamBodySchema,
  ExamListQuerySchema,
  IdParamsSchema,
  PatchExamBodySchema,
  ReportListQuerySchema,
  SessionListQuerySchema,
  StartSessionBodySchema,
} from "@graphharness/contracts";
import type { Hono } from "hono";
import { jsonBody, query } from "../http.ts";
import type { HubContext } from "../services/context.ts";
import { createExam, deleteExam, listExams, patchExam } from "../services/exams.ts";
import { getReport, listReports, renderReport, reportPdfPath } from "../services/reports.ts";
import { closeSession, listSessions, startSession } from "../services/sessions.ts";

export function registerSessionsRoutes(api: Hono, ctx: HubContext): void {
  // ---------------------------------------------------------------- exams
  api.get("/exams", (c) => c.json(listExams(ctx, query(c, ExamListQuerySchema))));
  // `jsonBody`/`query` from http.ts infer zod's INPUT type with `.default()`; here it is parsed by hand.
  api.post("/exams", async (c) => c.json(createExam(ctx, CreateExamBodySchema.parse(await c.req.json().catch(() => ({})))), 201));
  api.patch("/exams/:id", async (c) => {
    const { id } = IdParamsSchema.parse(c.req.param());
    return c.json(patchExam(ctx, id, await jsonBody(c, PatchExamBodySchema)));
  });
  api.delete("/exams/:id", (c) => {
    deleteExam(ctx, IdParamsSchema.parse(c.req.param()).id);
    return c.body(null, 204);
  });

  // ---------------------------------------------------------------- LH sessions
  api.get("/sessions", (c) => c.json(listSessions(ctx, SessionListQuerySchema.parse(c.req.query()))));
  // Today button (ADR 102 §12): the user opens it from the PWA.
  api.post("/sessions", async (c) => c.json(await startSession(ctx, await jsonBody(c, StartSessionBodySchema), "learner"), 201));
  api.post("/sessions/:chatId/close", (c) => c.json(closeSession(ctx, ChatIdParamsSchema.parse(c.req.param()).chatId), 202));

  // ---------------------------------------------------------------- reports
  api.get("/reports", (c) => c.json(listReports(ctx, query(c, ReportListQuerySchema))));
  api.get("/reports/:id", (c) => c.json(getReport(ctx, IdParamsSchema.parse(c.req.param()).id)));
  api.post("/reports/:id/render", async (c) => c.json(await renderReport(ctx, IdParamsSchema.parse(c.req.param()).id)));
  api.get("/reports/:id/pdf", (c) => {
    const { id } = IdParamsSchema.parse(c.req.param());
    const pdf = readFileSync(reportPdfPath(ctx, id));
    return c.body(new Uint8Array(pdf), 200, { "content-type": "application/pdf", "content-disposition": `inline; filename="report-${id}.pdf"` });
  });
}
