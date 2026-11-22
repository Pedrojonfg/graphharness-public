import type { JobHandlers } from "../runner.ts";
import { handlers as ingest } from "./ingest.ts";
import { handlers as knowledge } from "./knowledge.ts";
import { handlers as practice } from "./practice.ts";
import { handlers as prior } from "./prior.ts";
import { handlers as sessions } from "./sessions.ts";

export const ALL_HANDLERS: JobHandlers = { ...ingest, ...knowledge, ...practice, ...sessions, ...prior };
