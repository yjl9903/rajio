# Check Summary Output

`rajio check` non-JSON, non-verbose output is a compact issue index.

- Keep summary ordering as `fatal`, `error`, then `warning`.
- Group human summaries by file, level, and issue code.
- Human summary lines omit stage labels, example segment context, and detailed issue messages.
- Human hints are printed once after the scope line.
- Persisted session check/commit segment-level hints point to
  `rajio segments list <target> --stage <stage> --issues <code>`.
- Patch-scoped `segments apply --dry-run` output does not print that hint because it checks an
  in-memory patched result; use apply `--verbose --json` for patch-scoped details.
- JSON output keeps detailed summary messages and examples for machine consumers.

Example:

```text
check scope: translation_work zh QA.
hint: Inspect an issue type with rajio segments list ./session --stage translation --issues <code>. Use --language ja to inspect Japanese QA.
translation/work/segments.toml: 2 error issues (zh_line_hard_limit).
translation/work/segments.toml: 37 warning issues (subtitle_gap_short).
```
