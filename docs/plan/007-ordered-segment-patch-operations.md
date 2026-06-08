# Ordered Segment Patch Operations

## Summary

Replace grouped segment patches with a single ordered `[[operations]]` TOML format. Operations run
in file order so a patch can merge segments and then split the intermediate merged segment.

## Key Changes

- `parseSegmentPatch` accepts only top-level `operations`.
- `segments apply` keeps the same CLI shape and requires the ordered operation format.
- Operation ids use explicit roles: `segment_id`, `source_id`, `source_ids`, `merged_id`, and
  `replacements[].segment_id`.
- Split operations keep midpoint gap behavior with default `gap = 0.08`.
- `--verbose` prints affected rows in operation order.

## Interface

```toml
[[operations]]
op = "edit"
segment_id = "12"
zh = "修正后的中文字幕"

[[operations]]
op = "merge"
source_ids = ["13", "14"]
merged_id = "13-14"
speaker = "A,B"
ja = "結合した日本語"
zh = "合并后的中文字幕"

[[operations]]
op = "split"
source_id = "13-14"
gap = 0.08

[[operations.replacements]]
segment_id = "13a"
start = 10.0
end = 13.2
speaker = "A"
ja = "前半の日本語"
zh = "前半中文字幕"

[[operations.replacements]]
segment_id = "14a"
start = 13.2
end = 16.0
speaker = "B"
ja = "後半の日本語"
zh = "后半中文字幕"

[[operations]]
op = "delete"
segment_id = "15"
```

## Test Plan

- Ordered edit, merge, split, and delete patch applies atomically.
- Merge-then-split can use an intermediate `merged_id`.
- Split operation inserts midpoint gaps for all internal replacement boundaries.
- Invalid later operation rolls back earlier successful operations.
- Duplicate current ids after any operation are rejected.
- CLI `segments apply` file and stdin tests use `[[operations]]`.
- Run `pnpm --filter rajio test` and `pnpm --filter rajio typecheck`.
