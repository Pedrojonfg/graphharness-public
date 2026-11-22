// REST routes of the PRACTICE lane under /api/v1: cards, exercises and diagnostics. The logic is in services/.
import {
  CardImportBodySchema,
  CardQueueQuerySchema,
  CardReviewBodySchema,
  CreateDiagnosticBodySchema,
  CreateExerciseBodySchema,
  DiagnosticAnswerBodySchema,
  ExerciseAttemptBodySchema,
  ExerciseExplainBodySchema,
} from "@graphharness/contracts";
import type { Hono } from "hono";
import { jsonBody } from "../http.ts";
import { cardQueue, importCards, retireCard, reviewCard } from "../services/cards.ts";
import type { HubContext } from "../services/context.ts";
import { answerDiagnostic, createDiagnostic } from "../services/diagnostics.ts";
import { attemptExercise, createExercise, exerciseHint, explainExercise } from "../services/exercises.ts";

export function registerPracticeRoutes(api: Hono, ctx: HubContext): void {
  // ------------------------------------------------------------ cards
  // Direct `.parse`: `query`/`jsonBody` type with the schema's input and here there is a `.default()`.
  api.get("/cards/queue", (c) => c.json(cardQueue(ctx, CardQueueQuerySchema.parse(c.req.query()))));
  api.post("/cards/import", async (c) => c.json(importCards(ctx, CardImportBodySchema.parse(await c.req.json().catch(() => ({})))), 201));
  api.post("/cards/:id/review", async (c) => c.json(await reviewCard(ctx, c.req.param("id"), await jsonBody(c, CardReviewBodySchema))));
  api.post("/cards/:id/retire", (c) => c.json(retireCard(ctx, c.req.param("id"))));

  // ------------------------------------------------------------ exercises
  api.post("/exercises", async (c) => c.json(await createExercise(ctx, await jsonBody(c, CreateExerciseBodySchema)), 201));
  api.post("/exercises/:instanceId/attempt", async (c) =>
    c.json(await attemptExercise(ctx, c.req.param("instanceId"), await jsonBody(c, ExerciseAttemptBodySchema))),
  );
  api.post("/exercises/:instanceId/hint", async (c) => c.json(await exerciseHint(ctx, c.req.param("instanceId"))));
  api.post("/exercises/:instanceId/explain", async (c) =>
    c.json(await explainExercise(ctx, c.req.param("instanceId"), await jsonBody(c, ExerciseExplainBodySchema))),
  );

  // ------------------------------------------------------------ diagnostics
  api.post("/diagnostics", async (c) => c.json(await createDiagnostic(ctx, (await jsonBody(c, CreateDiagnosticBodySchema)).examId), 201));
  api.post("/diagnostics/:id/answer", async (c) =>
    c.json(await answerDiagnostic(ctx, c.req.param("id"), await jsonBody(c, DiagnosticAnswerBodySchema))),
  );
}
