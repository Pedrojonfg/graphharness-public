# ADR 102 — Gaps filled during implementation

- **Status:** proposed (for Pedro's review)

What the original data-model design left undefined but the pipelines and the API needed, and how it was resolved (migration `002_gaps.sql` and code):

1. **`concept_suggestions`** — the curator's merge and split suggestions. `GET /concept-suggestions` and `list_concept_suggestions` read them; they are only applied when accepted.
2. **`diagnostics`** — the state of a diagnostic pass. The answers are `attempts` with `context='diagnostic'`.
3. **`unassigned_questions`** — LH questions without a concept (step 4 of LH session ingestion). `evidence_events.concept_id` is NOT NULL, so they cannot go there. They are used by `session-reingest` and by metric R2.
4. **`lh_sessions.last_turn_started_at`** — the automatic close has to know whether a turn is in progress.
5. **`template_errors.hint`** — cache of the hint rephrased per error.
6. **`meta`** — operational key-value store (last backup, repo size and last sync), for `/health`.
7. **`chain_support`** counts **distinct chains** (as the schema comment says), not premises.
8. **Curator edges** (`source='curator'`): they are born with `low` confidence, because they are an LLM proposal with no chains supporting them. They do not count for warnings or inference until `edges-derive` finds support and raises them. `edges-derive` does not touch edges with `source='manual'` or `removed=1`.
9. **`suggestedToday`**: closeness = `1/(1+daysToExam)` (with no exam, `1/31`). If there is no evidence, P' = 0.5. Dependents count as `1 + n`, so that a leaf concept does not end up with priority 0.
10. **Confirmation items:** they are stored from the start as `cards` with `purpose='confirmation'` and `declaration_id` (with `instance_id` if they come from a template). `itemId` is the card id. The PWA queue does not show them until `DECLARATION_CONFIRM_DEFER_MIN` minutes have passed (the "deferred" confirmation). From that moment they go first.
11. **Concept of `explain`/`recall`** (the LH ingestion spec does not say): `explain` carries a `nodeId` and goes through `plan_node_map`, like `quiz`. `recall`, which belongs to the probing phase and carries no `nodeId`, goes through the LLM, like `probe`.
12. **REST routes that the screens need and that the original API list does not include:**
    - `POST /sessions` is the mirror of `start_session`, for the Today button.
    - `GET /inbox` feeds the Inbox: concepts without a subject, open suggestions, failed templates, unknown errors and concepts without live propositions.
    - `POST /concept-suggestions/:id/dismiss` (in MCP, `dismiss_concept_suggestion`) dismisses a suggestion.
    - `GET /llm-usage` gives LLM usage for Settings (R4).
13. **Cards:** the queue includes the answer, because grading is local. The exception is confirmation items with an instance and an open answer: the Hub grades them with eval from `given`. An instance's solution never reaches the client.
14. **Personal errors and the cap of 6 errors per eval recipe** (`MAX_ERRORS`): when generating an instance, the Hub passes eval the recipe with up to 6 errors. Personal ones go first, by descending `times_seen`, followed by those of the recipe.
