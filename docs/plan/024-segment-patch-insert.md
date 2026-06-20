# Segment Insert Support

## Summary

Support issue #26 by adding two segment insertion entrypoints: `segments apply` accepts an ordered
`op = "insert"` operation, and `rajio segments insert` inserts one segment directly. Both use
`start`/`end` as the timeline source of truth and do not support manual before/after anchors.

## Interface

Patch form:

```toml
[[operations]]
op = "insert"
segment_id = "12.5"
start = 42.0
end = 43.2
speaker = "A"
ja = "追加された字幕"
zh = "新增字幕"
```

CLI form:

```bash
rajio segments insert /path/to/session \
  --id 12.5 \
  --start 42.0 \
  --end 43.2 \
  --speaker A \
  --ja "追加された字幕" \
  --zh "新增字幕" \
  --stage translation
```

## Behavior

- Insert before the first existing segment whose `start` is greater than the new segment `start`;
  append when no later segment exists.
- Require `segment_id`, `start`, `end`, `speaker`, and `ja`; `zh` is optional for transcript work.
- Require `zh` for `segments insert` and patch insert when applying against translation work.
- Reject inserted duplicate ids, invalid time, empty Japanese text, empty required Chinese text, and
  overlaps with the inserted segment's immediate neighbors.
- Keep existing `edit`, `split`, `merge`, and `delete` patch behavior unchanged.
- Keep normal apply check behavior for non-insert warnings/errors; `insert` only hard-fails the
  local fatal cases above.

## Tests

- Direct `segments insert` succeeds at the beginning, middle, and end.
- Direct insert dry-run does not persist and JSON prints the inserted row.
- Transcript insert can omit `zh`; translation insert rejects missing `zh`.
- Patch `op = "insert"` succeeds and reports `inserts` in stats.
- Duplicate id, invalid time, empty `ja`, missing required `zh`, and adjacent overlap fail
  atomically.
