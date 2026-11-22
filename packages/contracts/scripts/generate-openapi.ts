// Ported from graphlearn/packages/contracts/scripts/generate-openapi.ts (65b56d6).
// Generates apps/hub/openapi.yaml from API_ROUTES; `pnpm generate:openapi` from the root. Here the routes come from the table.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extendZodWithOpenApi, OpenAPIRegistry, OpenApiGeneratorV31 } from "@asteasolutions/zod-to-openapi";
import { stringify } from "yaml";
import { z } from "zod";
import { API_BASE } from "../src/api/common.ts";
import { API_ROUTES } from "../src/api/routes.ts";

extendZodWithOpenApi(z);

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, "../../../apps/hub/openapi.yaml");

const registry = new OpenAPIRegistry();

for (const r of API_ROUTES) {
  const responses: Record<string, { description: string; content?: Record<string, { schema: z.ZodTypeAny | { type: "string"; format: "binary" } }> }> = {};
  for (const [status, spec] of Object.entries(r.responses)) {
    const type = spec.contentType ?? "application/json";
    const schema = spec.schema ?? (spec.contentType ? { type: "string" as const, format: "binary" as const } : undefined);
    responses[status] = schema ? { description: spec.description, content: { [type]: { schema } } } : { description: spec.description };
  }
  registry.registerPath({
    method: r.method,
    // Hono `:id` → OpenAPI `{id}`.
    path: r.path.replace(/:([A-Za-z]\w*)/g, "{$1}"),
    summary: r.summary,
    request: {
      ...(r.params ? { params: r.params } : {}),
      ...(r.query ? { query: r.query } : {}),
      ...(r.body ? { body: { content: { "application/json": { schema: r.body } } } } : {}),
    },
    responses,
  });
}

const doc = new OpenApiGeneratorV31(registry.definitions).generateDocument({
  openapi: "3.1.0",
  info: {
    title: "Hub API",
    version: "1.0.0",
    description: "REST API of the Hub for the PWA. No authentication: only reachable from the tailnet.",
  },
  servers: [{ url: API_BASE }],
});

writeFileSync(outPath, stringify(doc, { aliasDuplicateObjects: false }));
console.log(`Wrote ${outPath} (${API_ROUTES.length} routes)`);
