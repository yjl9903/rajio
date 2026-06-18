# Per-Segment Check Skip Annotations

## Summary

Use explicit per-segment `skip_checks` annotations in `segments.toml` for intentional
subtitle QA exceptions. A skip applies only to one segment and one issue code, and every
skip must include a reason. Regular `--commit` and export pass only when all blocking QA
errors are either fixed or explicitly skipped on the affected segment.

Example:

```toml
[[segments]]
id = "12"
start = 10.0
end = 12.0
speaker = "A"
ja = "あああああああああああああああああああああああああああああ！！！"
zh = "你你你你你你你你你你你你你你你你你你你你你你你你你！！！"
skip_checks = [
  { code = "zh_repeated_punctuation", reason = "Official title spelling." },
  { code = "zh_line_hard_limit", reason = "Official title should stay on one line." }
]
```

## Key Changes

- Add `skip_checks?: { code: SkippableIssueCode; reason: string }[]` to `Segment` and
  `segmentSchema`.
- Allow skipping all current segment-level `error` QA codes:
  `ja_line_hard_limit`, `zh_line_hard_limit`, `ja_line_break_can_merge_soft`,
  `zh_line_break_can_merge_soft`, `ja_line_break_hard_limit`, `zh_line_break_hard_limit`,
  `duration_too_short`, `duration_too_long`, `ja_reading_speed_limit`,
  `zh_reading_speed_limit`, `subtitle_gap_too_short`, `ja_common_punctuation`,
  `zh_common_punctuation`, `ja_terminal_punctuation`, `zh_terminal_punctuation`,
  `ja_punctuation_only_line`, `zh_punctuation_only_line`, `ja_repeated_punctuation`,
  `zh_repeated_punctuation`.
- Keep fatal/data integrity issues non-skippable: schema, duplicate IDs, invalid timing,
  overlap, empty required text, missing files, failed stages, and similar workflow issues.
- When an issue matches the same segment id and code in `skip_checks`, downgrade it to
  `warning` and include the reason in the message.
- Report stale annotations as blocking `fatal` `unused_skip_check` issues when a segment has
  a valid skip entry that does not match any generated issue.

## CLI Behavior

- `rajio <target> --commit` becomes the only manual commit path. It succeeds when no
  unskipped fatal/error issues remain.
- `rajio check` silently omits skipped issues because the segment annotation is the manual
  confirmation.
- `rajio check --level error` still reports stale `unused_skip_check` fatal issues.

## Segment Tooling

- `segments edit` remains the simple single-segment field editor for `start`, `end`,
  `speaker`, `ja`, and `zh`.
- `segments edit` preserves existing `skip_checks` when rewriting the segment.
- Add a narrow cleanup option:

```bash
rajio segments edit <target> <id> --stage translation --clear-skip-checks
```

- Extend `segments apply` edit operations with full-replacement `skip_checks` support:

```toml
[[operations]]
op = "edit"
segment_id = "12"
zh = "你你你你你你你你你你你你你你你你你你你你你你你你你！！！"

[[operations.skip_checks]]
code = "zh_repeated_punctuation"
reason = "Official title spelling."
```

- `segments apply` semantics: missing `skip_checks` preserves existing annotations;
  `skip_checks = []` clears annotations; present non-empty arrays replace annotations exactly.
- `segments split` and `segments merge` do not inherit old `skip_checks`; split/merge results
  need fresh explicit annotations via `segments apply`.
- `cloneForTranslation` preserves transcript-stage `skip_checks` so Japanese QA exceptions carry
  into `translation/work/segments.toml`.

## Tests

- Segment validation: matched skips, stale skips, invalid skip codes, empty reasons, and
  non-skippable fatal issues.
- Workflow: commit/export behavior.
- Segment tooling: `segments edit` preservation/clear, `segments apply` set/clear, and
  split/merge not carrying stale skips.
