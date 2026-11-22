// The two errors that come out of lh-client (ADR 105).

/**
 * LearnHarness answered with an HTTP error status, or it could not be reached.
 * `code` is the `code` of the LearnHarness body, unchanged, when it carries one
 * (e.g. 503 `models_not_configured`, which is handed back unchanged to the agent, ADR 105);
 * otherwise `http_<status>`. No response (network down): `status = 0`, `code = "unreachable"`.
 */
export class LhError extends Error {
  readonly status: number;
  readonly code: string;
  /** LearnHarness body, already parsed (JSON) or text; `undefined` if there was no response. */
  readonly body: unknown;

  constructor(message: string, opts: { status: number; code: string; body?: unknown; cause?: unknown }) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "LhError";
    this.status = opts.status;
    this.code = opts.code;
    this.body = opts.body;
  }
}

/**
 * LearnHarness answered 2xx but with a shape that does not match the schemas in `types.ts`:
 * upstream changed a contract the Hub reads (ADR 105). It must fail here and nowhere else.
 */
export class LhContractError extends Error {
  /** LearnHarness route, e.g. "GET /api/graph". */
  readonly route: string;
  /** Readable validation problems (zod paths + message). */
  readonly issues: string[];

  constructor(route: string, issues: string[]) {
    super(`LearnHarness contract broken at ${route}: ${issues.join("; ")}`);
    this.name = "LhContractError";
    this.route = route;
    this.issues = issues;
  }
}
