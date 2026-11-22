# Provenance of the code ported from GraphLearn

The ported code comes from GraphLearn, an earlier project.

Origin: private repository graphlearn, commit 65b56d6 (archived). Every ported file carries a `Ported from graphlearn/<path>` header.

| Destination | GL origin | Adaptation |
|---|---|---|
| packages/core/src/state.ts | packages/contracts/src/graph.ts | `nodeId` → `conceptId`; no project or Supabase schemas; review threshold, prior and deltas via env; `weight` in `applyGradeToProbability` |
| packages/core/src/state.test.ts | packages/contracts/src/graph.test.ts | Without the pilot-template test |
| packages/core/src/decay.ts (+ test) | packages/contracts/src/evidence-decay.ts | No constant changes |
| packages/core/src/manual.ts | packages/contracts/src/manual-state.ts | The HTTP schema moves to contracts; `DeclarationOrigin` is added |
| packages/core/src/flashcards/* | packages/flashcards/src/{scheduler,grade}.ts (+ test) | No changes |
| packages/contracts/src/{recipe,template,instance,error-pattern,distractor,flashcards}.ts (+ tests) | packages/contracts/src/ | `TemplateDomainSchema` accepts `economics` |
| apps/eval/{app/**, tests/test_{formulas,health,matrix_multiply,pattern_hash,recipes}.py, pyproject.toml} | apps/eval | No logic changes and no changes to `ALLOWED_FUNCS`; project renamed `graphharness-eval`. New: `/v1/errors/reproduce` |
| packages/llm/src/json.ts | packages/llm/src/json.ts | No changes |
| packages/llm/src/client.ts | packages/llm/src/client.ts | Keeps the 2-attempt JSON+zod loop; transport changes to `claude -p` (spawn) or openai-compatible (native fetch), with a semaphore and `onUsage`; no ai-sdk and no quotas |
| packages/latex/src/escape.ts | apps/worker/src/pdf/latex.ts (`escapeText`, `isSafeMath`, `lineWithMath`) | Does not collapse line breaks; `isSafeMath` also rejects unescaped `%` and `#` |
| packages/latex/src/tikz.ts | apps/worker/src/pdf/latex.ts (`graphTikz`) | `TikzGraph` input; deduplicates edges |
| packages/latex/src/render.ts | apps/worker/src/pdf/{latex,master}.ts | Fixed templates with the data of session-close steps 5–6; GL-058 warnings inside the `.tex` |
| packages/latex/src/compile.ts | apps/worker/src/pdf/compile.ts + the with/without-graph pattern of master.ts | System pdflatex via spawn, no Docker; `shell_escape=f`, `openin_any=p`, `openout_any=p` |
| packages/contracts/scripts/generate-openapi.ts | packages/contracts/scripts/generate-openapi.ts | Routes of the Hub REST API |
| packages/contracts/src/api/diagnostics.ts | packages/contracts/src/diagnostic.ts | Diagnostic DTOs |
| apps/hub/src/services/reports.ts (`splitEquation`, `verifyFormula`) | packages/llm/src/explain.ts | No logic changes; `verify` calls eval `/v1/formulas/verify` (LaTeX) for the formulas of the session report |
| apps/hub/src/services/exercises.ts | packages/llm/src/explain.ts (`splitEquation`, `verifyFormula`, `stripMath`) | A formula without a checkable equality is not shown; no LLM retry; eval via the Hub's `/v1/formulas/verify` |
| apps/hub/src/services/cards.ts | apps/api/src/flashcards/flashcard-routes.ts (queue, review, override, import) | SQLite; confirmation items first and deferred (ADR 102 item 10); `flashcard` evidence with weight 0.5; the override corrects the failure event |
| apps/hub/src/services/practice-common.ts | apps/api/src/diagnostic/mcq.ts (`buildMcqOptions`) | No cross-user frequency weights: correct answer + all eval distractors (≤ 7 options), Fisher–Yates |
| packages/llm/prompts/template-generate.v1.md | packages/llm/src/recipes.ts (`RECIPE_SYSTEM`, `RECIPE_FORMAT`) | Adds a method sheet, limits and several methods; up to 6 errors |
| packages/llm/prompts/exercise-explain.v1.md | packages/llm/src/explain.ts (`EXPLAIN_SYSTEM`, `EXPLAIN_FORMAT`, `buildExplainPrompt`) | No TikZ or slider; method sheet, limits and Pedro's steps; does not reveal the result while the exercise is still open |
| apps/pwa/src/components/MathView.tsx | apps/web/src/components/Ejercicio.tsx | Only `MathView`, `TextWithMath`, `sympyToTex`, `valueTex`, `Value`; adds `Paragraphs` |
| apps/pwa/src/components/AnswerInput.tsx | apps/web/src/components/Ejercicio.tsx | Over `ClientInstance`; choice with buttons |
| apps/pwa/src/map/graph.ts | apps/web/src/mapa/grafo.ts | `layoutGraph`/`relations` over `SubjectMap` |
| apps/pwa/src/map/GraphCanvas.tsx | apps/web/src/components/GrafoCanvas.tsx | Color by state; dashed if `pending` |
| apps/pwa/src/pages/CardsPage.tsx | apps/web/src/pages/Flashcards.tsx | Inspired by; confirmation marked, 60 s override |
| apps/pwa/src/components/Dictation.tsx | apps/web/src/components/Dictado.tsx | Inspired by; Web Speech API |
