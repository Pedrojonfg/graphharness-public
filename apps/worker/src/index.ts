// Worker process (hub-worker.service): job queue + periodic triggers + listener for LH events.
import { createContext } from "@graphharness/hub/services/context";
import { ALL_HANDLERS } from "./handlers/index.ts";
import { listenLhEvents } from "./lh-events.ts";
import { runForever } from "./runner.ts";
import { tickSchedule } from "./schedule.ts";

const ctx = createContext();
const stop = new AbortController();
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => stop.abort());

const last = new Map<string, number>();
tickSchedule(ctx, last);
const timer = setInterval(() => tickSchedule(ctx, last), 30_000);
void listenLhEvents(ctx, stop.signal);
await runForever(ctx, ALL_HANDLERS, { signal: stop.signal });
clearInterval(timer);
