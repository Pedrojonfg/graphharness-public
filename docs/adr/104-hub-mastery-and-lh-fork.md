# ADR 104: `GET /mastery` and the F6/F7 patches to the LH fork

- **Status:** accepted (Pedro, 2026-11-10)

1. **The Hub exposes `GET /api/v1/mastery?propositionIds=a,b&query=`** (read-only; an addition to the original REST surface). LH's `hub_mastery` tool (P3a) calls it.
   - `propositionIds`: up to 100 LH proposition ids separated by commas. `query`: free text (FTS5 over concepts, 10 max). At least one is required (400 otherwise).
   - Response: `{concepts: [{conceptId, name, state, stale, lastEvidenceAt, ageDays, propositionIds}], unmappedPropositionIds}`. `stale` is the flag computed by `isEvidenceStaleForDiagnostic`. Deleted propositions, propositions without a concept, or belonging to merged/retired concepts go to `unmappedPropositionIds`; LH treats them as `unknown`.
   - No database schema changes.
2. **How LH reaches the Hub.** A setting `hub: { enabled?: boolean }` in `settings.json` (off if missing) and the environment variable `LH_HUB_URL` (default `http://127.0.0.1:4100`, loopback: the Hub and LH live on the same VPS). With `hub.enabled` off the tool is not registered. If the Hub does not answer (3 s timeout), the tool returns a text saying there is no data and the agent probes as usual.
3. **`90-hub-mastery.md` fragments** of the prober and the practitioner are worded conditionally ("if you have `hub_mastery`…"), because LH composes the fragments even when the tool is not registered.
4. **The fork lives outside this repo.** F6 and F7 are built in a clone of upstream `v0.5.0` until a private fork of LearnHarness exists. `PATCHES.md` lives in the fork.
