# Terminal Current Stage

## Summary

Completed workflows should write `current_stage = "done"` in `session.toml` so the session's
top-level state is unambiguous. `[stages.export].status = "done"` remains the export artifact
record; `done` is not a real stage and does not create `[stages.done]`.

## Implementation

- Add a current-stage type that allows the fixed stage names plus `done`, while keeping
  `StageName` limited to `audio`, `transcript_raw`, `transcript_work`, `translation_work`,
  and `export`.
- Advance past `export` to `done`.
- Treat `done` as complete only when `[stages.export].status = "done"`.
- If workflow resume sees `current_stage = "done"` with incomplete export state, fail with a
  consistency error.
- `rajio check` reports an error when `current_stage = "done"` but export is not done.
- Keep `--reset` and `check --stage` stage-only; neither accepts `done`.

## Tests

- Completed export writes `current_stage = "done"`.
- Completed-session fixtures load with `done`.
- `rajio check` accepts `done` and does not report `failed_stage` for it.
- `rajio check` rejects `done` when export is pending or failed.
- Workflow resume from inconsistent `done` fails instead of no-oping.
