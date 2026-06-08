# Transcript Work Gap Normalization

## Summary

Fix ASR-generated `transcript/work/segments.toml` so mechanical 0ms or near-0ms adjacent
gaps do not produce mass `subtitle_gap_too_short` hard errors. Raw ASR output remains
unchanged; normalization happens only when creating transcript work.

## Key Changes

- Add a segment helper for transcript work gap normalization:
  - target gap is `0.08s`
  - use `SEGMENT_TIME_EPSILON` (`1e-3`) for float tolerance
  - for each adjacent pair with `gap < 0.08 - epsilon` and `gap >= -epsilon`, compute
    `midpoint = (previous.end + current.start) / 2`
  - set `previous.end = round6(midpoint - 0.04)` and
    `current.start = round6(midpoint + 0.04)`
  - leave real overlaps (`gap < -epsilon`) unchanged so normal validation reports them
  - skip boundaries touching already-invalid segments so manual repair behavior is preserved
  - skip any boundary where normalization would make either affected segment shorter than the
    existing `0.5s` hard minimum
- Use this helper in `setupManualStage` only for `transcript_work`, before writing
  `transcript/work/segments.toml`.
- Keep `translation_work` cloning unchanged.
- Change subtitle gap validation to use shared `SEGMENT_TIME_EPSILON` instead of a local
  `1e-9`, so exact 80ms and tiny float drift do not fail.
- No CLI flag, session schema, raw transcript format, or public API changes.

## Test Plan

- Add segment validation tests:
  - `0.08` gap passes without `subtitle_gap_too_short`
  - near-`0.08` float drift passes
  - clearly short gaps such as `0.07` still hard-error
- Add transcript work setup tests:
  - raw segments with 0ms adjacency generate `transcript/work` with centered 80ms gaps
  - tiny negative drift within epsilon is normalized
  - real overlap beyond epsilon is left for validation/check errors
  - normalization is skipped if it would create an adjusted segment shorter than `0.5s`
- Confirm `transcript/raw/segments.toml` is not mutated.
- Run `pnpm --filter rajio test` and `pnpm --filter rajio typecheck`.

## Assumptions

- The hard subtitle gap remains 80ms; 90ms was only a workaround for current float-boundary
  behavior.
- Normalization should not attempt semantic subtitle cutting or text edits.
- Existing manual split tooling keeps its current 80ms midpoint-gap behavior.
