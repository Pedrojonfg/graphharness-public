# lh-client fixtures

Everything under `synthetic/` is **synthetic**: it was written by hand for this repository, on an invented
subject (basic thermodynamics), with invented ids, titles and timestamps. The files are shaped to match the
zod schemas in `../src/types.ts`, which in turn mirror the public HTTP API of
[LearnHarness](https://github.com/amosblomqvist/learnharness). No LearnHarness code or data is included here.

Because the fixtures are synthetic, the tests that use them check our client against **our own reading** of
that API, not against a live LearnHarness. Checking against a real instance is the job of
`src/contract.test.ts` (`pnpm --filter @graphharness/lh-client test:contract`, with `LH_CONTRACT_URL` pointing
at a LearnHarness started on a temporary data directory).

The larger JSON files were emitted once from a throwaway script that held the same literals; no generator is
kept in the repository, so the files themselves are the source of truth.

## `synthetic/chats/` - session records

| File | Contents |
|---|---|
| `chat_k3p8w2ud_7e1b44a0.json` | Teaching session (46 messages): two `probe` questions (one answered in parallel with an `ask_user_question`), one `recall`, `probe_done`, a `quiz` with an invalid `nodeId` (`isError`), two `plan_init` calls (6 then 8 nodes), three `quiz` calls (an "I don't know" answer, a wrong answer with confidence 0 and `readingThinking`, and a dismissed one), two `explain` calls, a second `ask_user_question`, a background-job marker and a compaction marker |
| `chat_k3p9c5zr_2d80f6b3.json` | Practice session (16 messages): `graph-context` marker, a `problem` + `conclude` with outcome `solved` (rung `null`), a second `problem` that the student dismissed (`problem-dismissed` marker plus the synthetic `conclude` with outcome `dismissed`) |

## `synthetic/graph/` - graph ledgers

`nodes.jsonl` (24 propositions), `chains.jsonl` (10 chains) and `sessions.jsonl` (chat id and title), one JSON
object per line. They hold the same data that `http/graph.json` serves.

## `synthetic/http/` - HTTP responses

| File | Route | Notes |
|---|---|---|
| `graph.json` | `GET /api/graph` | Full snapshot, including keys the client must drop (`nodes`, `edges`, `logicalEdges`, `impLinks`, `clusters`, `positions`, `nodeSessions`) |
| `chats.json` | `GET /api/chats` | The two sessions, most recent first |
| `chat.json` | `GET /api/chats/:id` | The practice session plus `pricing`, `turnInFlight`, `compacting` and `coverage` |
| `chat-markdown.md` | `GET /api/chats/:id/markdown` | Markdown transcript of the practice session |
| `chat-404.json` | `GET /api/chats/:id` (404) | `{error}` |
| `chats-create.json` | `POST /api/chats` | `{id, title}` |
| `chat-send.json`, `chat-send-409.json` | `POST /api/chat` | 200 `{ok:true}`; 409 when a turn is already running |
| `models-not-configured-503.json` | `POST /api/chat`, `POST /api/chats` (503) | `{error, code: "models_not_configured", missing}` |
| `coverage-extract-202.json`, `coverage-extract-409.json` | `POST /api/graph/coverage/extract` | 202 `{started:true}`; 409 `{error}` |
| `graph-status.json`, `graph-status-idle.json` | `GET /api/graph/status` | Two running extractions; none |
| `graph-import.json` | `POST /api/graph/import` | Two successful per-file results (one with `droppedChains` and a `notice`) |
| `graph-import-models-not-configured.json` | `POST /api/graph/import` | In-band rejection with `code: "models_not_configured"` |
| `events.sse` | `GET /api/events` | `event:`/`data:` frames for every event type the tests use, with `: ping` keep-alives in between |

## Consumers

`../src/client.test.ts`, `../src/extract.test.ts`, `apps/hub/test/sessions/sessions.test.ts`,
`apps/worker/test/sessions/session-close.test.ts` and, through `apps/worker/test/ingest/helpers.ts`, the
worker ingestion tests.
