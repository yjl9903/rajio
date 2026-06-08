# Report Failed Automatic Stage In `rajio check`

## Summary

Make `rajio check` fail when the current stage is an automatic stage with `status = "failed"`,
especially `transcript_raw`, so users are not misled by `ok: true` after a failed automatic run.
Avoid adding `failed_stage` for manual stages because their failures often already surface as
concrete `segments.toml` validation errors.

## Key Changes

- In `packages/rajio/src/session/check.ts`, check `state.stages[state.current_stage]` after
  status enum validation.
- Emit `failed_stage` only when:
  - `state.current_stage` is one of `audio`, `transcript_raw`, or `export`.
  - That stage has `status = "failed"`.
- Issue shape:
  - `file`: `session.toml`.
  - `stage`: current stage.
  - `level`: `error`.
  - `code`: `failed_stage`.
  - `message`: include the stage name and append `stageState.error` when present.
- Keep `failed` as a valid status; this is not an `invalid_stage_status` issue.
- Do not emit `failed_stage` for `transcript_work` or `translation_work`.

## Public Behavior

- `current_stage = "transcript_raw"` plus `transcript_raw.status = "failed"` makes
  `rajio check --json` return `ok: false`.
- Non-JSON `rajio check` prints an error summary and exits with code `1`.
- Manual stage segment problems continue to be reported through existing segment validation issues.
- `--stage transcript_raw` and `--stage transcript` include the raw failed-stage issue; unrelated
  stage filters exclude it.

## Tests

- Add a focused `checkRajio` test for failed `transcript_raw`, asserting `ok: false` and one
  `failed_stage` error.
- Add a manual-stage case for `transcript_work.status = "failed"` as current stage, asserting no
  `failed_stage` issue is emitted.
- Add or extend JSON formatter coverage so the automatic failed-stage issue produces `ok: false` and
  `counts.error: 1`.
- Run `pnpm --filter rajio test`.

## Assumptions

- Automatic stage failures need an explicit session-level error because there may be no segment file
  issue to report.
- Manual stage failures should avoid duplicate generic errors and rely on concrete segment validation
  output.
