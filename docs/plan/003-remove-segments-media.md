# Remove Segments Media Path Plan

## Summary

`segments.toml` should not expose the source media path. The media path is session input and remains
tracked in `session.toml`; subtitle segment files should contain only subtitle source kind,
generation time, and segment data.

## Implementation

- Remove `source.media` from the `SegmentsFile` type and segment file schema.
- Stop passing and writing `mediaPath` in raw transcript merge output.
- Let transcript work and translation work naturally omit `source.media` when cloning newly generated
  segment files.
- Do not migrate historical files or add special compatibility behavior.
- Update docs and tests to reflect that media path belongs to `session.toml`, not `segments.toml`.

## Verification

- `pnpm --filter rajio test:ci`
- `pnpm --filter rajio typecheck`
