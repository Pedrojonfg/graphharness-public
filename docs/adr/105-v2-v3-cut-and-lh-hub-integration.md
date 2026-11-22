# ADR 105: LH ↔ Hub integration, language and identity, and the V2 / V3 cut

- **Status:** accepted (Pedro, 2026-11-10)
- **Context:** an analysis of inconsistencies between LH and the Hub (language, identity, design, vocabulary, extracted-but-unused data, installation) and a brainstorm of synergies. This ADR fixes the decisions and splits the work between before V2, V2 and V3.
- **Scope:** this ADR records the decisions on language (see 4) and refines the original plans for the P3b and P3c patches.

## 1. Identity and shape of the apps

1. **Two apps, not one.** LH cannot be mounted under a sub-path: `next.config.ts` has no `basePath` and there are ~70 `fetch("/api/…")` calls with absolute paths; a single origin would require a large, fragile patch. LH (:443) and the Hub (:8443) stay separate, with the same look and cross-links.
2. **Product name: `graphharness`.** It replaces an earlier working name. "Learning Harness", "LH" and "Study Hub" remain as component names in the documentation, not as the product.
3. **The LH fork remains a local clone** (on a feature branch) until Pedro decides to publish it as a private repo. The maintenance rules stand: every patch is listed in `PATCHES.md`.

## 2. Language

4. **LH's interface stays in English.** Its ~95 components are not patched and no translation layer is added. Only `lang="es"` and Spanish `metadata`.
5. **The teacher's voice and language are set with new fork fragments** (`shared/90-idioma.md` and `practice/90-idioma.md`, because practice only admits 4 shared fragments), not by overriding `shared/10-voice.md`: that replaces the whole fragment and stops receiving upstream changes. Content: Spanish, informal address (tuteo), and the language does not change even if the material is in English.
6. **Dictation:** unchanged. The Hub stays on `es-ES` and LH keeps its selector.

## 3. Design

7. **Hub style for everything.** LH is repainted with the Hub's colors and loses the LH logo (`lh-mark.tsx`). It is a patch (P4) limited to the tokens of `app/globals.css` ("THE SKIN") and the logo. The fine-grained interface decision (typefaces, dark/light theme, what to keep of LH's look) is made later, in a UI round.
8. **LH → Hub link:** a discreet link in LH's menu, in a new component (`components/hub/`).
9. **No end-of-session notice inside LH.** The summary lives in the Hub ("Today" shows yesterday's) and is reached through the link from 8.

## 4. Data and domain rules

Every point in this section changes the evidence/state rules or the data model and **needs its own ADR with concrete values** (like 101) before being implemented.

10. **`missClass` changes the weight of the evidence** of LH practices (today it is extracted in `lh-client` and discarded). A slip weighs little; the other classes (`cue`, `discrimination`, `execution`, `structural`) also feed the next suggested action (cards, exercises or a session).
11. **Confidence (0–100) enters the computation of P** (today it is stored in `evidence_events.confidence` and unused).
12. **Response time counts, with little weight.** A fluency signal, never dominant; dictation and mobile make it noisy.
13. **The weight of the LLM judge's `inferred` evidence is tuned with data** by comparing its verdicts with later deterministic results for the same concept. It needs months of use: V3.
14. **Concepts shared between subjects.** Today a concept belongs to one subject; it becomes shareable, with common evidence. It changes the data model: V3.

## 5. Integration with the teacher (fork patches)

15. **P3c: the teacher also sees the Hub.** Today `hub_mastery` is only in the prober and the practitioner.
16. **New read-only or capture tools:** `hub_errors` (recurring personal errors, so the practitioner picks problems that tell them apart), `hub_capture` (save a card or note from the session) and `hub_profile` (error types and modalities that work). Each one is a patch that has to be maintained on every monthly update.
17. **P3b stays in V2:** `hub_exercise` for the practitioner (an exercise with deterministic grading inside LH), with the math answer interface it needs. It had been planned from the start.
18. **Shared quota:** the Hub pauses its `cheap` jobs while LH has an active turn, by reading LH's `GET /api/activity` (no patch in LH). There is no single consumption panel.

## 6. Prior knowledge

19. **Prior-knowledge report when importing material**: "you already master 70 % of this PDF, 20 % has expired, 10 % is new". It lives in the Hub (PWA and MCP), without touching LH.
20. **"Prior" includes similarity between propositions**, not just the state of the assigned concepts: a `cheap` LLM step matches the new propositions with the existing ones.
21. **Prior-mastery line on LH's new-session screen**: it goes with the P3c patch (15).
22. **Syllabus per subject (optional):** given by Pedro, once per subject, through the agent. It serves to detect what has never been seen. Without a syllabus, everything stays as it is today.

## 7. Plan, offline and packaging

23. **7-day plan** (minimal version of the between-session plan): with exam dates and weak concepts, on top of `suggestedToday`. The version with time estimates is V3.
24. **Offline cards: V3**, unless Pedro says he reviews often without coverage.
25. **Quantitative economics:** undecided. Pedro provides 3–5 real exercises and then the list of new `eval` functions is defined. It blocks nothing until then.
26. **Packaging for other users: V3.** V2 is not conditioned on it; only the rule that configuration lives in `.env`, with nothing fixed in code, is kept.

## Split

**Before V2 (small tasks):**
- `install.sh` and `DEPLOY.md` enable `hub.enabled`, `LH_HUB_URL` and the `90-idioma.md` fragments (today they do not: on a new VPS it would be forgotten).
- `90-idioma.md` fragments in the fork + `lang="es"` and `metadata` (4, 5).
- LH → Hub link (8).
- PNG `apple-touch-icon` in the Hub (today it is SVG, which iOS probably ignores).
- README up to date (it says LH's mobile interface "is not done yet").

**V2:**
- P3b (17), P3c and new tools (15, 16).
- Prior-knowledge report with similarity (19, 20, 21) and optional syllabus (22).
- ADR + implementation of `missClass`, confidence and time (10, 11, 12).
- Job pause during an LH turn (18).
- Unified visual theme (7).
- 7-day plan (23).

**V3:**
- Evidence and concepts shared between subjects (14).
- Judge tuning with data (13).
- Plan with estimates (23).
- Offline cards (24).
- Packaging (26).
- New `eval` functions (25), once there are exercises.

## Pending

- ADR on weights: `missClass`, confidence and response time (10–12).
- ADR on shared concepts (14), before V3.
- Update the fork's `PATCHES.md` with P3c, P4 and the language fragments when they are implemented.
