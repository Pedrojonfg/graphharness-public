# ADR 103: Pedro's decisions after the integration (W4)

- **Status:** accepted (Pedro, 2026-11-10)

1. **Subject of imported material: one subfolder per subject.**
   - Materials live in `MATERIALS_DIR/<subject-slug>/…`. `import_material` and `import_class_notes` only accept paths under their subject's folder.
   - The agent's notes go to `<slug>/agent-notes/YYYY-MM-DD-slug.md`. This replaces the earlier flat `agent-notes/` path.
   - If the subject has no `lh_source_folder`, its slug is assigned.
   - LH receives the relative path `<slug>/…`. The curator inherits the subject by folder prefix, through `fileSources`.
2. **`fileSources` in lh-client.** `getGraph()` returns `{propositions, chains, fileSources}` (`fileSources` is srcId → path). It still never reads `nodes` or `edges`.
3. **`session-close` does not block the worker.** The step that waits for extraction (step 1 of session close) does not poll inside the job. The job re-enqueues itself with `run_after = now + 10 s` until LH finishes or 15 min have passed since the start; then it continues with steps 2–7. In between, the worker serves other jobs.
4. **Hints before the first attempt.** A method hint can be requested without having attempted. The `hub_exercise` evidence is still that of the first attempt. If at least one hint was used before that attempt and it is correct, it counts as `mcq` (`quick`).
