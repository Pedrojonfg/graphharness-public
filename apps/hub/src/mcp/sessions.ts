// MCP tools of the SESSIONS lane: material, LH sessions, exams and reports.
// The input is re-validated with the contracts schema (the server already does it; this way the handler works standalone).
import {
  CloseSessionInputSchema,
  GetSessionReportInputSchema,
  ImportClassNotesInputSchema,
  ImportMaterialInputSchema,
  ListExamsInputSchema,
  RenderPdfInputSchema,
  StartSessionInputSchema,
  UpsertExamInputSchema,
} from "@graphharness/contracts";
import { listExams, upsertExam } from "../services/exams.ts";
import { importClassNotes, importMaterial } from "../services/materials.ts";
import { getSessionReportByChat, renderReport } from "../services/reports.ts";
import { closeSession, startSession } from "../services/sessions.ts";
import type { McpHandlers } from "./types.ts";

export const sessionsTools: McpHandlers = {
  import_class_notes: (ctx, input) => importClassNotes(ctx, ImportClassNotesInputSchema.parse(input)),
  import_material: (ctx, input) => importMaterial(ctx, ImportMaterialInputSchema.parse(input)),
  start_session: (ctx, input) => startSession(ctx, StartSessionInputSchema.parse(input), "agent"),
  close_session: async (ctx, input) => closeSession(ctx, CloseSessionInputSchema.parse(input).chatId),
  upsert_exam: async (ctx, input) => upsertExam(ctx, UpsertExamInputSchema.parse(input)),
  list_exams: async (ctx, input) => {
    const { from, to } = ListExamsInputSchema.parse(input ?? {});
    return { exams: listExams(ctx, { from, to }) };
  },
  get_session_report: async (ctx, input) => getSessionReportByChat(ctx, GetSessionReportInputSchema.parse(input).chatId),
  render_pdf: async (ctx, input) => ({ path: (await renderReport(ctx, RenderPdfInputSchema.parse(input).reportId)).path }),
};
