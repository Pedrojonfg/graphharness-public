// Knowledge lane: declarations-expire. Idempotent: only touches expired `pending` declarations.
import { expireDeclarations } from "@graphharness/hub/services/declarations";
import type { JobHandlers } from "../runner.ts";

export const handlers: JobHandlers = {
  "declarations-expire": async (ctx) => {
    const n = expireDeclarations(ctx);
    if (n > 0) console.log(`[worker] declarations-expire: ${n} declarations expired`);
  },
};
