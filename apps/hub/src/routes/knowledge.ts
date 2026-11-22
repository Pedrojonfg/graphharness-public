// REST routes of the KNOWLEDGE lane under /api/v1 (shapes and statuses come from API_ROUTES). The logic lives in services/.
import {
  AddConceptNoteBodySchema,
  BriefQuerySchema,
  ConceptSuggestionsQuerySchema,
  CreateSubjectBodySchema,
  ImportClassNotesBodySchema,
  ImportMaterialBodySchema,
  LlmUsageQuerySchema,
  MasteryQuerySchema,
  MergeConceptsBodySchema,
  PatchConceptBodySchema,
  PatchConceptEdgesBodySchema,
  PatchConceptStateBodySchema,
  PatchSubjectBodySchema,
  PlanQuerySchema,
  ResolveConceptsBodySchema,
  SearchKnowledgeBodySchema,
  SplitConceptBodySchema,
  SubjectIdParamsSchema,
  type LlmUsageQuery,
  type PatchConceptEdgesBody,
} from "@graphharness/contracts";
import type { Hono } from "hono";
import { resolve } from "node:path";
import { HubError } from "../errors.ts";
import { jsonBody, query } from "../http.ts";
import { dailyBrief } from "../services/brief.ts";
import {
  acceptSuggestion,
  applySplit,
  conceptDetail,
  dismissSuggestion,
  listSuggestions,
  mergeConcepts,
  patchConcept,
  patchEdges,
} from "../services/concepts.ts";
import type { HubContext } from "../services/context.ts";
import { declareLearning } from "../services/declarations.ts";
import { health } from "../services/health.ts";
import { inbox } from "../services/inbox.ts";
import { llmUsage } from "../services/llm-usage.ts";
import { importClassNotes, importMaterial, listMaterials } from "../services/materials.ts";
import { mastery } from "../services/mastery.ts";
import { addConceptNote } from "../services/notes.ts";
import { getWeekPlan } from "../services/plan.ts";
import { resolveConcepts, searchKnowledge } from "../services/search.ts";
import { createSubject, listSubjects, patchSubject, subjectMap, subjectOverview } from "../services/subjects.ts";

export function registerKnowledgeRoutes(api: Hono, ctx: HubContext): void {
  // ------------------------------------------------------------ subjects
  api.get("/subjects", (c) => c.json(listSubjects(ctx)));
  api.post("/subjects", async (c) => c.json(createSubject(ctx, await jsonBody(c, CreateSubjectBodySchema)), 201));
  api.patch("/subjects/:id", async (c) => c.json(patchSubject(ctx, c.req.param("id"), await jsonBody(c, PatchSubjectBodySchema))));
  api.get("/subjects/:id/map", (c) => c.json(subjectMap(ctx, c.req.param("id"))));
  api.get("/subjects/:id/overview", (c) => c.json(subjectOverview(ctx, c.req.param("id"))));

  api.post("/knowledge/search", async (c) => c.json(searchKnowledge(ctx, await jsonBody(c, SearchKnowledgeBodySchema))));
  api.post("/knowledge/resolve", async (c) => c.json(await resolveConcepts(ctx, await jsonBody(c, ResolveConceptsBodySchema))));

  // ------------------------------------------------------------ concepts
  api.get("/concepts/:id", (c) => c.json(conceptDetail(ctx, c.req.param("id"))));
  api.post("/concepts/:id/notes", async (c) =>
    c.json(addConceptNote(ctx, { conceptId: c.req.param("id"), text: (await jsonBody(c, AddConceptNoteBodySchema)).text, origin: "pwa" }), 201),
  );
  api.patch("/concepts/:id/state", async (c) => {
    const body = await jsonBody(c, PatchConceptStateBodySchema);
    const r = await declareLearning(ctx, { conceptId: c.req.param("id"), ...body, origin: "pwa" });
    if (r.status === "needs_ack") throw new HubError(409, { error: "weak_prerequisites", weakPrerequisites: r.weakPrerequisites });
    return c.json(r);
  });
  api.post("/concepts/:id/merge", async (c) => c.json(mergeConcepts(ctx, c.req.param("id"), (await jsonBody(c, MergeConceptsBodySchema)).sourceIds)));
  api.post("/concepts/:id/split", async (c) => c.json(applySplit(ctx, c.req.param("id"), (await jsonBody(c, SplitConceptBodySchema)).parts, "pwa"), 201));
  api.patch("/concepts/:id", async (c) => c.json(patchConcept(ctx, c.req.param("id"), await jsonBody(c, PatchConceptBodySchema))));
  // `jsonBody` types with the schema's input; after the parse, the defaults (`add`/`remove` = []) are already applied.
  api.patch("/concept-edges", async (c) =>
    c.json(patchEdges(ctx, (await jsonBody(c, PatchConceptEdgesBodySchema)) as PatchConceptEdgesBody)),
  );

  // ------------------------------------------------------------ materials
  api.get("/materials/:subjectId", (c) => c.json(listMaterials(ctx, SubjectIdParamsSchema.parse(c.req.param()).subjectId)));
  api.post("/materials/notes", async (c) => c.json(await importClassNotes(ctx, await jsonBody(c, ImportClassNotesBodySchema)), 201));
  api.post("/materials/import", async (c) => {
    const body = await jsonBody(c, ImportMaterialBodySchema);
    const root = resolve(ctx.config.materialsDir);
    // the PWA sends `relative`; MCP sends absolute paths — we normalise here.
    const paths = body.paths.map((p) => (p.startsWith("/") ? p : resolve(root, p)));
    return c.json(await importMaterial(ctx, { subjectId: body.subjectId, paths }));
  });

  // ------------------------------------------------------------ curator suggestions and inbox
  api.get("/concept-suggestions", (c) => c.json(listSuggestions(ctx, query(c, ConceptSuggestionsQuerySchema).status)));
  api.post("/concept-suggestions/:id/accept", (c) => c.json(acceptSuggestion(ctx, c.req.param("id"), "pwa")));
  api.post("/concept-suggestions/:id/dismiss", (c) => c.json(dismissSuggestion(ctx, c.req.param("id"))));
  api.get("/inbox", (c) => c.json(inbox(ctx)));

  // ------------------------------------------------------------ brief, LLM usage and health
  api.get("/brief", (c) => c.json(dailyBrief(ctx, query(c, BriefQuerySchema).date)));
  api.get("/plan", (c) => c.json(getWeekPlan(ctx, query(c, PlanQuerySchema))));
  api.get("/llm-usage", (c) => c.json(llmUsage(ctx, (query(c, LlmUsageQuerySchema) as LlmUsageQuery).days)));
  api.get("/mastery", (c) => c.json(mastery(ctx, query(c, MasteryQuerySchema))));
  api.get("/health", async (c) => c.json(await health(ctx)));
}
