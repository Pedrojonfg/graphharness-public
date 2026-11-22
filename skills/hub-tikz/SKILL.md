---
name: hub-tikz
description: >-
  Educational TikZ figures via the Hub MCP (ADR 108). Use it when the user asks for
  drawings, diagrams, axes, Venn diagrams, trees or flowcharts for class or
  flashcards. Do not paste raw TikZ into the chat.
---

# hub-tikz

Compiles and saves figures in the Hub; the student sees PDF/SVG, not LaTeX code.

## Workflow (mandatory)

1. **`list_figure_templates`** — pick a family (`geometry`, `axes`, `venn`, `tree`, `flowchart`) or list everything.
2. **Edit** the `tikz` field of the template (only the drawing body; the Hub wraps it in `tikzpicture` if needed).
3. **`compile_tikz_fragment`** — preview (`mode`: **`teaching`** by default). If there is an error, read the `pdflatex` log and fix it.
4. **`save_figure`** — persists the figure; use `conceptId` / `title` / `family` when you link it to a concept or exercise.

Templates versioned in the repo: `packages/latex/templates/figures/*.tex` (comment `% family: …`; `% libraries: …` is guidance for you, the Hub does not parse it).

## Mode

- Default **`teaching`**: didactic style, not optimized for dense printing.
- Only change `mode` if the user explicitly asks for another use.

## TikZ libraries (allowlist)

You may only request these in `libraries` for compile/save:

`arrows.meta`, `calc`, `positioning`, `shapes.geometric`, `decorations.pathreplacing`, `patterns`, `fit`, `backgrounds`.

Quick guide by template in the repo:

| Template   | Typical `libraries`                          |
|------------|-----------------------------------------------|
| geometry   | `calc`                                        |
| axes       | _(none)_                                      |
| venn       | _(none)_                                      |
| tree       | `positioning`                                 |
| flowchart  | `arrows.meta`, `positioning`, `shapes.geometric` |

## Forbidden in the fragment

Never use `\write18`, `\input`, `\usepackage` or `\include` in the TikZ you send. The Hub's sandbox rejects them (`FORBIDDEN_TEX`).

Do not invent libraries outside the allowlist.

## Example prompts (user → agent)

- "Draw a right triangle with legs 3 and 4 and label the vertices; save it to the Pythagoras concept."
- "From the axes template, show \(y=x^2\) between 0 and 2 and compile without saving yet."
- "Venn diagram of three sets A, B, C for probability; title “Independent events”."
- "Binary decision tree: root “Rain?”, children Yes/No; figure for today's flashcard."
- "Flowchart Input → Validate → Output with arrows; teaching mode."

## If compilation fails

Shorten the fragment, remove odd macros, check that the declared libraries match the Hub's implicit `\usetikzlibrary`, and retry `compile_tikz_fragment` before `save_figure`.
