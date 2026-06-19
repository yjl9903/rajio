# Manual Commit Check Output

## Summary

Manual commit validation output should use the same issue generation, filtering, and summary rules
as `rajio check`. The default scope is derived from the manual stage being committed:

- `transcript_work` shows Japanese QA.
- `translation_work` shows Chinese QA.

This keeps inherited Japanese QA warnings out of default translation commits while preserving the
existing ability to inspect them through `rajio check --stage translation --language ja`.

## Behavior

- `rajio check` human output prints a concise scope line before issue summaries or
  `check passed.`
- `rajio check --json` includes a top-level `scope` object. `counts` reports issues after
  scope/range filtering but before `--level`; `summary` and verbose `issues` honor `--level`.
- `rajio <target> --commit` prints the same compact summary issue format for the commit scope.
  Segment-level issue hints point to `rajio segments list <target> --stage <stage> --issues <code>`.
- Commit failure errors use the same `segments list --issues` direction for blocking issue details.
- Commit remains quiet when no issues are printed and does not emit `check passed.`
- Translation commit scope hints still point users to `rajio check <target> --stage translation
  --language ja` for the separate inherited Japanese QA view; commit does not gain a `--language`
  option.

## Non-Goals

- Export-stage blocking validation does not print warning output and does not use check scope text.
- Segment edit/list verbose output remains operation feedback, not check issue output.
