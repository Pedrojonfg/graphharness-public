// REST for prior knowledge and the syllabus (ADR 105 §6) under /api/v1. Thin routes: the logic is in services/.
import { IdParamsSchema, PriorReportListQuerySchema, PutSyllabusBodySchema, SubjectIdParamsSchema } from "@graphharness/contracts";
import type { Hono } from "hono";
import { jsonBody } from "../http.ts";
import type { HubContext } from "../services/context.ts";
import { getPriorReport, listPriorReports } from "../services/prior.ts";
import { getSyllabus, putSyllabus, syllabusGaps } from "../services/syllabus.ts";

export function registerPriorRoutes(api: Hono, ctx: HubContext): void {
  // `query` from http.ts infers zod's INPUT (with `.default()`); here it is parsed by hand.
  api.get("/prior-reports", (c) => c.json(listPriorReports(ctx, PriorReportListQuerySchema.parse(c.req.query()))));
  api.get("/prior-reports/:id", (c) => c.json(getPriorReport(ctx, IdParamsSchema.parse(c.req.param()).id)));
  api.put("/syllabus/:subjectId", async (c) => {
    const { subjectId } = SubjectIdParamsSchema.parse(c.req.param());
    return c.json(putSyllabus(ctx, subjectId, (await jsonBody(c, PutSyllabusBodySchema)).text));
  });
  api.get("/syllabus/:subjectId", (c) => c.json(getSyllabus(ctx, SubjectIdParamsSchema.parse(c.req.param()).subjectId)));
  api.get("/syllabus/:subjectId/gaps", (c) => c.json(syllabusGaps(ctx, SubjectIdParamsSchema.parse(c.req.param()).subjectId)));
}
