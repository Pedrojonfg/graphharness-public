Versioned prompts of the Hub: one file per task and version, `<task>.v<N>.md` (e.g. `report-session.v1.md`).
`loadPrompt(task)` loads the highest version; the version (`<task>.v<N>`) is stored in `llm_usage` and in the generated records.
Placeholders are written `{{variable}}` and filled in with `fillPrompt`. The concrete prompts are written by the worker lanes.

Tasks (v1): `cards-generate`, `code-exercise-generate`, `concept-assign`, `concept-curate`, `concept-review`, `confirmation-card`, `error-hint`, `error-hypothesize`, `exercise-explain`, `figure-generate`, `prior-match`, `recall-judge`, `report-session`, `resolve-rerank`, `template-generate`.
