# ADR 109: Lenses, second instance, expansions and per-core-node vote

- **Status:** accepted (Pedro, 2026-11-18; direction and decisions approved in conversation, and the vote with a multi-select `ask_user_question`, the core marker only in the plan's prose, and `widen` · "Expansion — not assessed" were confirmed)
- **Context:** Research brief `research/briefs/research-brief-expert-mental-models.md` (§9 records the conversation). Thesis: the learning that pays off most is the transition from the counterintuitive to the intuitive, and for that the same concept must be seen in different ways (Thurston with the derivative; Pedro's "keys" image for `Ax = b`) and in different places (linear dependence in linear algebra and in ODEs). Today LH's teacher teaches the *click* very well (unconditional facts + "how might I have discovered it", predict → teach → check), but nothing obliges it to offer several lenses, and `10-planning.md` tells it to produce a "minimal tree" with nothing off the path.

## Vocabulary

- **Lens:** a different way of seeing the *same* concept (algebraic, geometric, game/process, application). A demo is a way of drawing a dynamic lens, not a lens.
- **Second instance:** the same concept in another domain the student already knows.
- **Re-encounter:** the second instance across subjects, detected by the Hub.
- **Expansion:** a short addition that widens the concept beyond what is taught ("just as functions can be differentiated, matrices can be differentiated; the meaning would be…"). Never assessed.

## Decisions

1. **Scope: only core nodes** of the plan. The other nodes are taught as before.
2. **The teacher proposes the lenses**; there is no prior or curated catalog at this stage.
3. **Lenses and second instance in the session (prompt).** On a core node the teacher: (a) after the click, offers at least a second lens and ties it to the first with a translation question ("what you saw in A, what is it in B?", a normal `check`); (b) when the student already masters another domain where the concept lives (known from `hub_profile`/`hub_mastery`), gives a second instance there. Order: first a case that already works, then the second in another domain, then the abstract name; never before the first case has clicked. Each lens states **when it lies** (the limit of the metaphor).
4. **Exception to the "minimal tree" doctrine.** Lenses and the second instance count as path to the core, not as a digression. This is stated in a new fragment (`teacher/34-lenses.md`), without rewriting `10-planning.md`, so as not to lose upstream changes.
5. **Expansion** (new tool `widen`, teacher only):
   - arrives **after** the core node's `check`, **collapsed** behind an opt-in button, with the fixed label "Expansion — not assessed";
   - short (a few lines + a minimal example); at most one per core node; never followed by a question;
   - **correctness:** the teacher only asserts what is standard in a textbook and, if in doubt, runs `research` first or omits it. An expansion cannot be verified with a check, so the prompt treats it as risky content.
6. **Vote per core node.** When a core node ends, the teacher launches a multi-select `ask_user_question` ("which lenses helped you?", one option per lens + "none"). It is skippable and does not score. Confirmed: it uses the existing question (no new UI); there is no "End session" button in LH.
7. **The Hub stores the vote** and returns it to the teacher:
   - table `lens_feedback(id, chat_id, concept_id, node_id, lens_label, liked, created_at)` (migration `006_lens_feedback.sql`);
   - REST `POST /api/v1/lens-feedback` and `GET /api/v1/lens-feedback?conceptId=`, and the read MCP tool `list_lens_feedback`;
   - LH tools `hub_lens_feedback` (writes the vote) and a read of the lenses that worked for that concept, so the teacher offers them first (others are still proposed);
   - PWA parity (docs/UI-MCP-PARITY.md): a read-only "Lenses" list on the Concept page.
   - Implementation note: the `GET` accepts `conceptId` **or** `conceptQuery` (exactly one), like `/capture`; LH, which has no concept ids, uses `conceptQuery`. A label repeated within the same `POST` counts once (the last wins). The card and the two lens tools are registered like the rest of the `hub_*` tools.
8. **"I liked it" is not "it taught me".** The vote is a preference signal. Correlating it with later success per lens is left out of this phase (it requires tagging `check` with the lens, which would force touching the `quiz` schema, upstream code); it remains a later improvement, to be decided after seeing real data.
9. **"Core" marker.** The map parser (`mermaid-plan.ts`) does not support styles or classes. The teacher declares it only in the plan's prose ("core: a, b") and uses the `nodeId` in its calls; the map does not change (confirmed).
10. **Name and label of `widen`:** tool `widen`, collapsed card "Expansion — not assessed" (confirmed).
11. **Outside this ADR:** **re-encounters across subjects** depend on shared concepts (ADR 105 point 14; data model); they will get their own ADR. Until then, the second instance uses what `hub_profile` already says about the student, without identifying the same concept across subjects.

## Phases

- **F1 — Prompts and expansion (LH fork, patch P9):** `teacher/34-lenses.md`, `widen` tool + collapsible card, registration, prompt pins. No Hub.
- **F2 — Vote and memory (Hub + LH):** migration, service, REST, MCP, contracts, `hub_lens_feedback` tools, read, vote prompt fragment, PWA block.
- **F3 — Re-encounters:** shared-concepts ADR, later.

## Consequences

- LH: new files (`34-lenses.md`, `widen.ts`, `widen-card.tsx`, `hub/lens.ts`) plus 3–4 registration lines in `src/agent/tools.ts`, `components/artifacts/index.ts` and the pins of `tests/prompt-overrides.test.ts`. The golden fixtures are not edited by hand.
- The prompt text is written by subagents and reviewed by Pedro (like P3b/P4).
- Risks: longer sessions on core nodes; incorrect expansions that a check cannot catch; the vote measures perceived fluency, not learning (mitigated in 8).
- Verification: unit tests of the fork (npm test is slow: ~200 s in silence) and of the Hub; a live test of a session with a core node to see that the expansion collapses and the vote reaches the Hub.
