// Hono route utilities: validate with the contracts schemas and answer with the contract's errors.
import type { Context } from "hono";
import type { ZodType, ZodTypeDef } from "zod";

/** Validated JSON body (400 invalid_request if it does not match, via the app's onError). */
export async function jsonBody<T>(c: Context, schema: ZodType<T, ZodTypeDef, unknown>): Promise<T> {
  const raw: unknown = await c.req.json().catch(() => ({}));
  return schema.parse(raw);
}

export function query<T>(c: Context, schema: ZodType<T, ZodTypeDef, unknown>): T {
  return schema.parse(c.req.query());
}
