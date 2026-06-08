# CLI Media Path Resolution

## Summary

CLI-supplied `--media` paths resolve from the current working directory, while description
frontmatter media remains relative to the description file. New sessions fail before writing
`session.toml` when the resolved media file is missing.

## Implementation Notes

- `--media ./path.mp4` uses normal CLI path semantics and resolves from `process.cwd()`.
- Existing `session.toml` media values keep their current semantics: relative values are
  session-relative and absolute values are absolute.
- The missing-media guard lives in the session creation path before new session state is saved.
- Read-only or maintenance CLI paths do not create sessions: `clean` loads the target without
  writing `session.toml`, and segment commands require an existing manual-stage session.
- No compatibility or migration behavior is added for already-polluted `session.toml` values.

## Test Plan

- Directory target with cwd-relative `--media` resolves to the intended file and stores a
  session-relative media path.
- Missing `--media` for a new session throws without creating `session.toml`.
- Missing frontmatter media for a new session throws without creating `session.toml`.
- Description frontmatter media continues to resolve relative to `description.md`.
- `clean` removes generated artifacts without creating `session.toml`.
- Segment commands fail without creating `session.toml` when no existing manual-stage session is
  present.
