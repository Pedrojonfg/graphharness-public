# GraphHarness

A personal learning system designed to run on your own VPS, where you keep what you know and do useful things with it. The **Hub** stores what you know about each concept (state, evidence, flashcards, exercises, exams, reports) and exposes it over REST, MCP and a mobile PWA. It is built to sit next to [LearnHarness](https://github.com/amosblomqvist/learnharness), a study interface with an AI teacher, and to give it a memory. **Code computes and checks; the language model only writes.**

```
 phone / browser ──tailscale──▶ :8443 Hub (REST API + MCP + PWA) ──▶ SQLite
                       └────────▶ :443  LearnHarness (study sessions)    ▲
 agent ──hub-mcp (stdio)──▶ 127.0.0.1:4100/mcp                           │
 Hub ◀── hub-worker (jobs: LearnHarness sync, ingestion, cards, reports, backup)
 Hub ──▶ eval (FastAPI, 127.0.0.1:8001, no network)
```

New here? Read [DESIGN.md](DESIGN.md) first: one page with the core rule, the architecture, four decisions worth knowing and the security model. The full decision log is in [docs/adr](docs/adr).

**Scope.** The Hub needs a [LearnHarness](https://github.com/amosblomqvist/learnharness) instance as its source of material: it syncs LearnHarness's graph and study sessions over HTTP and builds everything else on top. The deeper integration, where the teacher inside LearnHarness calls Hub tools, needs patches that are in a separate private fork and are not part of this repository (see [DESIGN.md](DESIGN.md#architecture)). **Security:** the REST API and the PWA rely on Tailscale for access control and have no login of their own; read the [security model](DESIGN.md#security-model) before deploying.

## Layout

| Path | What it is |
|---|---|
| `apps/hub` | Hub server: REST, MCP, services, CLI (`src/cli.ts`) |
| `apps/worker` | Job queue (LearnHarness sync, session ingestion, cards, reports, backup) |
| `apps/pwa` | The PWA (React + Vite) served by the Hub |
| `apps/eval` | Deterministic exercise grading and generation (Python, FastAPI, uv) |
| `apps/mcp-stdio` | `hub-mcp`: stdio-to-HTTP adapter for the Hub's MCP endpoint |
| `packages/*` | `core` (pure domain), `contracts` (zod DTOs), `db` (SQLite + migrations), `lh-client`, `llm`, `latex` |
| `infra/` | systemd units, install/backup/restore scripts, Tailscale |
| `docs/` | Deployment, restore, UI/MCP parity, provenance, ADRs |
| `research/briefs/` | Research behind the figure and mental-model decisions |

## Run it locally

Requirements: Node 24, pnpm 10 (`corepack enable`), uv, sqlite3, rsync and `pdflatex` with TikZ.

```bash
pnpm install
pnpm typecheck
npx vitest run        # 888 TypeScript tests pass (7 are skipped by design)
pnpm test:eval        # 62 Python tests (eval)
```

Environment notes:
- **Node** must be 24. Do not put a different system node first on `PATH`: `better-sqlite3` is compiled against the active version.
- **pdflatex**: if the one on your `PATH` does not work (for example conda's), put a working one first when running the PDF tests.
- **sqlite3 and rsync** must be on `PATH`: the backup and restore tests run the real scripts.
- The tests that start the eval service are slow, and fail by timeout if the machine is busy. Run them on a quiet machine, or with `--maxWorkers=2`.

Start by hand:

```bash
HUB_DB=./hub.sqlite node apps/hub/src/index.ts          # Hub on 127.0.0.1:4100
node apps/worker/src/index.ts
cd apps/eval && uv run uvicorn app.main:app --port 8001
```

## The mobile app (PWA)

The Hub serves the PWA at `https://<vps>.<tailnet>.ts.net:8443/` through `tailscale serve`. On your phone: connect the Tailscale app (same tailnet as the VPS), open that URL in Safari (iOS) or Chrome (Android), then **Add to Home Screen**. It needs a connection: there is no data service worker.

## Deploying and operating

See [docs/DEPLOY.md](docs/DEPLOY.md) (install, update, MCP, backups, troubleshooting) and [docs/RESTORE.md](docs/RESTORE.md).

## Credits

- [LearnHarness](https://github.com/amosblomqvist/learnharness) by Amos Blomqvist (AGPL-3.0) is the study interface this project is designed to work with. The two programs talk over HTTP; this repository contains none of its code or data.
- Parts of the domain model, the evaluation service, the flashcard scheduler and the LaTeX pipeline were ported from GraphLearn, an earlier project. See [docs/PROVENANCE.md](docs/PROVENANCE.md) and [NOTICE.md](NOTICE.md).

## License

[MIT](LICENSE).
