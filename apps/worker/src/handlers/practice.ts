// Practice lane: template-generate, error-hypothesize, cards-generate.
import { generateCardsForConcept, generateCardsForSession as generateForSession } from "@graphharness/hub/services/card-generation";
import type { HubContext } from "@graphharness/hub/services/context";
import { runErrorHypothesize } from "@graphharness/hub/services/errors";
import { runTemplateGenerate } from "@graphharness/hub/services/templates";
import type { JobHandlers } from "../runner.ts";

/** Close step 4: cards for the session's new propositions (grouped by concept). Returns the ids of the cards created. */
export async function generateCardsForSession(ctx: HubContext, chatId: string): Promise<string[]> {
  return generateForSession(ctx, chatId);
}

function stringField(payload: Record<string, unknown>, key: string): string | null {
  const v = payload[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function required(payload: Record<string, unknown>, key: string, job: string): string {
  const v = stringField(payload, key);
  if (!v) throw new Error(`${job}: missing ${key} in the payload`);
  return v;
}

export const handlers: JobHandlers = {
  "template-generate": async (ctx, job) => {
    await runTemplateGenerate(ctx, required(job.payload, "conceptId", job.type));
  },
  "error-hypothesize": async (ctx, job) => {
    await runErrorHypothesize(ctx, required(job.payload, "unknownErrorId", job.type));
  },
  "cards-generate": async (ctx, job) => {
    const chatId = stringField(job.payload, "chatId");
    if (chatId) await generateForSession(ctx, chatId);
    else await generateCardsForConcept(ctx, required(job.payload, "conceptId", job.type));
  },
};
