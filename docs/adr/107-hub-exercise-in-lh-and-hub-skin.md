# ADR 107: `hub_exercise` in LH (P3b) and the Hub skin in LH (P4)

- **Status:** accepted (Pedro, 2026-11-11; recommended options approved one by one)
- **Context:** ADR 105 §7 and §17 left P3b and P4 for a design round. An LH tool cannot wait for the student's answer within the same call: `problem` ends the turn and the answer comes back as a tagged message. That constrains P3b.

## P3b: Hub exercises inside LH

1. **A single tool, a single action.** `hub_exercise` only *starts* (parameters `conceptId`, `propositionIds` or `query`). Attempts and hints are handled by the dock, not the agent: this way an attempt does not spend an LLM turn (shared quota) and the model never sees the solution. Only the practitioner has it; it is not in `hubAllTools`.
2. **Template choice:** `POST /api/v1/exercises` accepts `{templateId}` **or** `{conceptId}` (exactly one). With `conceptId` the concept's first active template is used; 404 if the concept does not exist, 409 `template_not_active` if it has none.
3. **LH dock** (not an iframe): statement, answer input (number and expression with KaTeX preview, vector and matrix as a grid, choice), "Check", an always-visible "Hint", "Skip", a second attempt after a miss, the solution at the end and "Continue". The answer logic is ported from the PWA (`Respuesta.tsx`, `Mates.tsx`). LH's interface stays in English (ADR 105 §2).
4. **Proxy on the LH server** (`/api/hub/exercises/:id/attempt|hint`): the browser does not talk to the Hub. 404 if `hub.enabled` is false; 502 `hub_unreachable` if it is down; the exercise id is validated.
5. **Hints:** requested by the student with the button; the teacher does not offer them beforehand (a rule in the prompt fragment). They count in `hints_used` and lower the evidence weight as in the Hub.
6. **Evidence without duplication:** the attempt counts once, in the Hub, when it is graded (source `hub_exercise`, ADR 106). LH session ingestion (`lh-client`) only looks at `quiz/probe/explain/recall` and `problem/conclude/plan_init`, so it ignores the `toolResult`s of `hub_exercise`; a test pins this down.
7. **The agent learns the result** through a new chat entry `{type:"exercise", exerciseCallId, outcome, attempts, hintsUsed}`: the server builds the tagged message ("Exercise result: …") and opens a turn. Only that marker closes the exercise; a `conclude` does not.

## P4: the Hub skin in LH

8. **Only the color tokens** of `app/globals.css`; LH stays dark and uses the Hub's dark palette. Typefaces, spacing and layout do not change.
9. **Logo:** LH's is replaced by the Hub icon (`components/hub/hub-mark.tsx`).
10. **Still to be decided** (proposed by the P4 agent, unresolved): PWA/manifest/favicon icons; the manifest's `theme_color` and the Electron color; the "#141414" hint in Settings; whether Tailwind's semantic colors (red/green/amber) and the confidence ramp move to `--weak/--solid/--review`; `--primary` is now the Hub's blue (primary buttons stop being light gray); borders become fainter (contrast 1.5 vs 1.9).

## Consequences

- Maintenance cost: P3b touches ~10 upstream LH files on every monthly update (details and how to re-apply in the fork's `PATCHES.md`).
- Known limitation: if the student reloads mid-exercise, the dock's attempt counter resets; the Hub still enforces the maximum of 2 (409 `exercise_finished`).
- LH's golden fixtures do not include `exercise-result`; a real session with an exercise has to be recorded and added (the fixtures' README forbids editing them by hand).
