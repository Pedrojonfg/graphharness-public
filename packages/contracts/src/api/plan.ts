// DTO of the plan between sessions (ADR 105 §7, point 23; GET /plan and MCP `get_week_plan`).
import { z } from "zod";
import { DateOnlySchema, IdSchema } from "./common.ts";

/** GET /plan?days&from — days 1..14 (7 by default), from defaults to today. */
export const PlanQuerySchema = z.object({ days: z.coerce.number().int().min(1).max(14).optional(), from: DateOnlySchema.optional() });
export type PlanQuery = z.infer<typeof PlanQuerySchema>;

export const WeekPlanSchema = z
  .object({
    from: DateOnlySchema,
    days: z.array(
      z
        .object({
          date: DateOnlySchema,
          items: z.array(
            z
              .object({
                conceptId: IdSchema,
                conceptName: z.string(),
                subjectId: IdSchema.nullable(),
                kind: z.enum(["session", "cards", "exercises"]),
                why: z.string(),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
    unscheduledCount: z.number().int().nonnegative(),
  })
  .strict();
export type WeekPlanView = z.infer<typeof WeekPlanSchema>;
