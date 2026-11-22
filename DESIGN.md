# Design

GraphHarness is a personal system: one person per installation, on a VPS reachable only through Tailscale. This page is the short version of the design. The full reasoning is in the [ADRs](docs/adr).

## The core rule

> The LLM writes and composes. Code computes, compares and decides whether an answer is right.

What the system believes about you is computed by code, not by a model. Mastery is a probability per concept, calculated from a log of evidence events (answers, reviews, declarations), with decay and explicit weights. The log is not append-only: an event is changed only by an explicit override (for example correcting a flashcard review) or when two concepts are merged, and every weight is stored with the event, so the state can be rebuilt from the log. A language model drafts exercises, explanations and reports, but an exercise is only marked correct by the eval service (SymPy-based, with outbound network blocked in production), and a figure is only shown after the Hub compiles it with TeX's shell escape disabled and file access restricted.

## Architecture

| Component | Role |
|---|---|
| **Hub** (`apps/hub`) | Source of truth. Concepts, evidence log, per-concept state, cards, exercises, exams, reports. REST API and an MCP endpoint, backed by SQLite |
| **Worker** (`apps/worker`) | Background jobs: sync with LearnHarness, ingest study sessions, generate cards and reports, backups. Pauses cheap jobs while a study session is running |
| **eval** (`apps/eval`) | Grades and generates exercises deterministically. The Hub never judges an answer itself |
| **PWA** (`apps/pwa`) | The phone and laptop client: review queue, exercises, per-subject state, exams, reports |
| **hub-mcp** (`apps/mcp-stdio`) | Lets an agent read and write the Hub over stdio |
| **lh-client** (`packages/lh-client`) | Typed HTTP client for LearnHarness, the AI teacher the Hub is designed to work with (see below) |

**Relationship to LearnHarness.** The Hub gets its raw material from LearnHarness: the worker syncs LearnHarness's graph and study sessions over its public HTTP API and curates them into concepts, and the Hub adds state, evidence, reviews, exercises and reports on top. Unpatched upstream LearnHarness is the intended minimum for that. The deeper integration, where the teacher itself calls Hub tools (`hub_mastery`, `hub_exercise`, lenses and the mobile skin), needs patches to LearnHarness that live in a separate private fork and are **not part of this repository**. [ADR 104](docs/adr/104-hub-mastery-and-lh-fork.md), [107](docs/adr/107-hub-exercise-in-lh-and-hub-skin.md) and [109](docs/adr/109-lenses-expansions-and-core-node-vote.md) describe those patches as design records. Without them the teacher cannot see the Hub. Note that `lh-client` is tested against synthetic fixtures, not against a live LearnHarness.

## Four decisions worth knowing

**[ADR 101: decay is applied before the delta](docs/adr/101-decay-before-delta.md).** The previous design added a grade's delta to the stored probability without decaying it, so a forgotten concept came back to "solid" after one correct answer. Decay now runs first, then the evidence adds on top. The core tests pin this down.

**[ADR 106: evidence weight multipliers](docs/adr/106-evidence-weights.md).** An answer is not just right or wrong: how it was missed (careless slip versus structural misunderstanding), how confident the learner was, and how fast they answered all change how much it counts. The weight is a product of three bounded multipliers, every constant is configurable, and the state function stays the same because it just receives the final weight. Replaying the log still gives the same result.

**[ADR 108: didactic TikZ figures and code comprehension](docs/adr/108-tikz-figures-and-code-comprehension.md).** The agent never pastes raw TikZ to the student. It asks the Hub, which compiles the fragment with TeX's shell escape disabled and file access restricted, and stores a PDF and SVG. Programming subjects get Parsons, predict-the-output and spot-the-bug cards, graded locally without running arbitrary student code. See the [research brief](research/briefs/research-brief-tikz-and-code-comprehension.md).

**[ADR 109: lenses, expansions and a per-node vote](docs/adr/109-lenses-expansions-and-core-node-vote.md).** The thesis is that the move from counterintuitive to intuitive needs the same concept seen in several ways and in several places. On core nodes of a plan, the teacher offers a second lens and a second instance, may attach a clearly labelled optional expansion that is never assessed, and asks which lenses helped, so the data says which ones work. See the [research brief](research/briefs/research-brief-expert-mental-models.md).

## What it is not

It has no accounts, no multi-tenant model and no hosted service. Backups go to a private git repository you own. If you want other people to use an installation, that is a different design.

## Security model

The trust boundary is your Tailscale network, not the application. Read this before deploying.

- The Hub listens on `127.0.0.1:4100` only. `tailscale serve` publishes it to your tailnet on port 8443 (`infra/tailscale/serve.sh`).
- **The REST API and the PWA have no authentication of their own.** Any device on the tailnet can read and write everything the Hub stores. Keep the tailnet to your own devices, use Tailscale ACLs if it is shared, and never expose the port publicly (no port forwarding, no Tailscale Funnel).
- **`/mcp` is stricter:** it answers on loopback only, requires a bearer token (`HUB_MCP_TOKEN`; an empty token rejects every request), and refuses requests that arrive through the proxy.
- LearnHarness has no authentication either, so it is also bound to loopback and published only through `tailscale serve`.
- The eval service binds to loopback and is denied outbound network access by its systemd unit.
- Secrets live in `/etc/graphharness/hub.env`, never in the repository. `.env.example` only has defaults and empty values.

This design fits one person on a private VPS. It is not suitable for multiple users or for exposing to the internet.
