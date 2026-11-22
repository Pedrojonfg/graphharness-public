// Mirrored LH sessions and their cycle in the Hub (`lh_sessions`; `/sessions` route).
import { z } from "zod";
import { IdSchema, IsoDateTimeSchema, MaterialPathSchema } from "./common.ts";

export const SessionKindSchema = z.enum(["teaching", "practice"]);
export const HubSessionStateSchema = z.enum(["open", "closing", "closed", "failed"]);
export type HubSessionState = z.infer<typeof HubSessionStateSchema>;

export const LhSessionSchema = z.object({
  chatId: IdSchema,
  title: z.string(),
  kind: SessionKindSchema,
  subjectId: IdSchema.nullable(),
  startedBy: z.enum(["learner", "agent"]).nullable(),
  hubState: HubSessionStateSchema,
  lastTurnSettledAt: IsoDateTimeSchema.nullable(),
  closedAt: IsoDateTimeSchema.nullable(),
  /** `https://<host-lh>/chat/<chatId>`. */
  url: z.string().url(),
  /** Latest session report, if it exists. */
  reportId: IdSchema.nullable(),
});
export type LhSession = z.infer<typeof LhSessionSchema>;

/** GET /sessions?subjectId&hubState&limit — from most recent to oldest. */
export const SessionListQuerySchema = z.object({
  subjectId: IdSchema.optional(),
  hubState: HubSessionStateSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type SessionListQuery = z.infer<typeof SessionListQuerySchema>;
export const SessionListSchema = z.array(LhSessionSchema);

/**
 * POST /sessions/:chatId/close and MCP `close_session` — queues `session-close`. Idempotent:
 * if it is already `closing`, `queued: false` and the current state.
 */
export const CloseSessionResponseSchema = z.object({
  chatId: IdSchema,
  hubState: HubSessionStateSchema,
  queued: z.boolean(),
});
export type CloseSessionResponse = z.infer<typeof CloseSessionResponseSchema>;

/**
 * POST /sessions ("open LH session on X" button in Today; ADR 102 §12) and MCP `start_session`.
 * 503 = LH `models_not_configured` envelope as is.
 */
export const StartSessionBodySchema = z.object({
  subjectId: IdSchema,
  goal: z.string().trim().min(1).max(2000),
  kind: SessionKindSchema,
  materialPaths: z.array(MaterialPathSchema).max(10).optional(),
  focusConceptIds: z.array(IdSchema).max(50).optional(),
});
export type StartSessionBody = z.infer<typeof StartSessionBodySchema>;

export const StartSessionResponseSchema = z.object({
  chatId: IdSchema,
  /** `https://<host-lh>/chat/<chatId>`. */
  url: z.string().url(),
});
export type StartSessionResponse = z.infer<typeof StartSessionResponseSchema>;
