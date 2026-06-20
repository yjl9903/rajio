# Segments List Issues Pagination

## Summary

`segments list --issues` supports `--offset` and `--limit`. Issue filters run first, then
pagination slices the filtered result. CLI errors are printed directly to stderr so JSON/CSV output
mode cannot silence fatal errors.

## Key Changes

- Treat `--offset/--limit` as pagination for all rows or `--issues` results.
- Keep filter modes exclusive for `--id`, `--start/--end`, and `--issues`.
- Reject `--id` or `--start/--end` mixed with `--offset/--limit`, because pagination only applies
  to all rows or issue-filtered rows.
- Print top-level CLI errors directly to stderr instead of through the logger.

## Test Plan

- `listSegments()` proves `--issues empty_zh --offset 1 --limit 1` returns the second issue match.
- Conflicting filter tests expect a clear `filter modes cannot be mixed` message.
- CLI JSON mode succeeds for issue pagination.
- CLI JSON mode prints mixed-filter errors to stderr.

## Assumptions

- No backward compatibility is needed for the old rejection of `--issues` with `--offset/--limit`.
- Existing output stats remain unchanged.
