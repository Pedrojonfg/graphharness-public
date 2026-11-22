# ADR 108: Didactic TikZ figures and code comprehension

- **Status:** accepted (Pedro, 2026-11-13; scope 1C + ADR + SVG via poppler/`pdftocairo`)
- **Context:** Research brief `research/briefs/research-brief-tikz-and-code-comprehension.md`. The Hub already uses TikZ only for concept maps in PDFs; there are no didactic figures or code-comprehension exercises. The golden rule stands: the LLM writes; code compiles, validates and grades.

## Decisions

1. **Pedagogical TikZ figures.** Pipeline: `LLM/agent → TikZ fragment → Hub compiles (sandbox) → PDF + SVG (pdftocairo) → asset in the figures table → PWA/report/explainer`. Default mode `teaching`.
2. **MCP.** Tools `compile_tikz_fragment`, `save_figure`, `list_figure_templates`. The agent does not paste raw TikZ to the student; it asks the Hub.
3. **Agent skill** (`hub-tikz`): teaching workflow + MCP call; classroom templates versioned in the repo.
4. **`programming` subject.** A new `subjects.kind` alongside `computable_math` and `general`.
5. **Cards.** New `kind`s: `parsons`, `predict`, `spot_bug`. Deterministic local grading. Optional field `figure_id`.
6. **Exercises.** Code templates/recipes (Parsons, faded Parsons with blanks, distractors). Eval determines shuffle/validation; no arbitrary student code is executed in V1.
7. **Adaptive distractors.** After repeated failures on the same exercise/card, distractors are reduced (intra-problem), without an LLM.
8. **Explainer.** It can attach an already-compiled `figureId`; the LLM does not embed TikZ in the steps JSON.
9. **LH.** `90-*` prompts and dock: Parsons/predict UI; the model does not see the solution (ADR 107).
10. **Outside the immediate product scope, but in the brief as T4/C3:** classroom template library + adaptive — **are implemented** in this batch (scope 1C).
11. **Manim / Python Tutor embed:** they do not block the cards MVP; Manim remains a separate video channel.

## Consequences

- Migration `005_figures_code.sql`: `figures` table, extended CHECK on `subjects.kind` and `cards.kind`, `cards.figure_id`, `templates.method_figure_id`.
- System dependency: `pdftocairo` (poppler-utils), already aligned with the VPS ecosystem.
- More MCP and PWA surface; LaTeX fragment tests require TeX + poppler in CI/local.
