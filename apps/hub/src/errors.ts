// Domain errors understood alike by the REST API (status + JSON body) and the MCP (isError + JSON).
import { LhError } from "@graphharness/lh-client";
import { ZodError } from "zod";

/** Throw this from a service: `body` is exactly the contract's error JSON (ApiErrorSchema & co). */
export class HubError extends Error {
  readonly status: number;
  readonly body: { error: string } & Record<string, unknown>;
  constructor(status: number, body: { error: string } & Record<string, unknown>) {
    super(body.error);
    this.name = "HubError";
    this.status = status;
    this.body = body;
  }
}

export const notFound = (): HubError => new HubError(404, { error: "not_found" });
export const badRequest = (error: string, extra: Record<string, unknown> = {}): HubError => new HubError(400, { error, ...extra });
export const conflict = (error: string, extra: Record<string, unknown> = {}): HubError => new HubError(409, { error, ...extra });

/** Translates any error to the contract's {status, body}. LH 503 (models_not_configured) passes through unchanged. */
export function toErrorResponse(err: unknown): { status: number; body: Record<string, unknown> } {
  if (err instanceof HubError) return { status: err.status, body: err.body };
  if (err instanceof ZodError)
    return { status: 400, body: { error: "invalid_request", issues: err.issues.map((i) => ({ path: i.path, message: i.message })) } };
  if (err instanceof LhError) {
    if (err.status === 503)
      return { status: 503, body: err.body && typeof err.body === "object" ? (err.body as Record<string, unknown>) : { error: err.message, code: err.code } };
    if (err.status === 404) return { status: 404, body: { error: "not_found" } };
    return { status: 502, body: { error: "lh_unavailable", message: err.message } };
  }
  console.error("[hub] unhandled error:", err);
  return { status: 500, body: { error: "internal_error" } };
}
