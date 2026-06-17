# Default Apply Check Output

## Summary

`rajio segments apply` always prints patch-scoped check feedback after applying a patch. This gives
batch workers immediate validation for their patch without adding a separate `--check` mode.

## Behavior

- Patch TOML accepts optional top-level `start` and `end` metadata for the patch's media range.
- `segments apply` computes a check range from patch `start/end`, or from the min/max time of
  affected segments when metadata is missing. Missing metadata also keeps affected-segment
  neighbors in scope so boundary gap/overlap issues are not filtered out.
- `--dry-run` checks the in-memory patched result without writing files.
- Normal apply writes the patch, then checks the resulting work file state. Blocking check issues
  are reported but do not change the apply command exit code; apply is not rolled back.
- `rajio check --start <seconds> --end <seconds>` filters segment-level QA to overlapping
  segments while preserving non-segment fatal issues.
- Check JSON scope uses `languages?: ("ja" | "zh")[]`.

## Apply Output

- Non-verbose non-JSON output prints an apply summary and grouped check summary.
- Non-verbose JSON output prints `{ apply, check }`.
- Verbose JSON output also includes top-level `segments`; rows include affected segments plus
  in-range segments with remaining issues. Each row includes `affected` and issue metadata.
- Verbose non-JSON output prints the same rows with `AFFECTED` and `ISSUES` columns.

## Check Target

- Transcript apply checks Japanese QA.
- Translation apply infers languages from patch operations:
  - `edit`: `ja`, `zh`, and `skip_checks` code prefixes choose languages.
  - `split`: checks Japanese; replacement `zh` also checks Chinese.
  - `merge`: checks Japanese; merged `zh` also checks Chinese.
  - `delete` and timing-only edits default to Chinese.
- Multi-language checks deduplicate non-segment fatal and language-neutral issues.

## Tests

- Apply JSON includes `apply` and `check`.
- Verbose apply JSON includes `segments[].issues`.
- Verbose human apply includes `ISSUES`.
- Patch metadata range wins over affected-segment fallback.
- Range-filtered `rajio check` keeps only overlapping segment QA and non-segment fatal issues.
