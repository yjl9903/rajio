# Segments List Multiple IDs

## Summary

Extend `segments list --id` to accept comma-separated segment ids, without adding
`segments show`. Segment ids are now globally invalid if they are empty, blank, untrimmed, or
contain commas.

## Key Changes

- Add shared segment id validation for `segments.toml`, segment patches, and new split/merge ids.
- Parse `segments list --id 12,15,19` as an ordered id list.
- Reject empty id tokens such as `--id 1,,2`.
- Apply `--around` to each requested id, deduplicate overlapping windows, and print results in
  source segment order.

## Test Plan

- `segments list --id 2 --json` returns `['2']`.
- `segments list --id 2,1 --json` returns `['2', '1']`.
- Missing ids still report `segment not found: <id>`.
- `segments list --id 1,,2` reports an invalid id list.
- `segments list --id 2,4 --around 1 --json` returns each context window deduped in source order.
- Segment validation and patch parsing/application reject blank, untrimmed, or
  comma-containing ids.

## Assumptions

- Existing files with invalid segment ids are invalid and require manual migration.
- No `segments show` alias is added.
