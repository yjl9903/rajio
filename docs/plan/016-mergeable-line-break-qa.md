# Mergeable Two-Line Subtitle QA

## Summary

Report a dedicated QA issue when a Japanese or Chinese subtitle uses exactly two lines but
would still fit as one line. This makes unnecessary line breaks blocking when the merged
text is within the soft limit, while preserving the old two-line warning only when one line
would exceed the hard limit.

## Behavior

- For exactly two lines, merge as `line1.trim() + " " + line2.trim()` before counting.
- Use `countSubtitleTextUnits` for the merged text; the inserted space follows existing
  whitespace counting and does not add length.
- If merged length is within the language soft limit, report an `error`:
  `ja_line_break_can_merge_soft` or `zh_line_break_can_merge_soft`.
- If merged length is within the hard limit but over the soft limit, report a `warning`:
  `ja_line_break_can_merge_hard` or `zh_line_break_can_merge_hard`.
- If merged length exceeds the hard limit, keep the existing
  `ja_line_break_soft_limit` or `zh_line_break_soft_limit` warning.
- Three or more lines keep the existing `ja_line_break_hard_limit` or
  `zh_line_break_hard_limit` error.
- Per-line soft and hard length checks still run independently.

## Skip Checks

Only the new error-level codes are skippable:

- `ja_line_break_can_merge_soft`
- `zh_line_break_can_merge_soft`

The warning-level `*_line_break_can_merge_hard` codes are review-only and do not need
`skip_checks`.
