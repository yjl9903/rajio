# Session Rajio Version

## Summary

`session.toml` records the rajio CLI package version that created or last saved the
session as top-level `rajio_version`. Loading requires an exact string match with the
running CLI version.

## Changes

- Remove `schema_version` from `SessionState` and generated `session.toml`.
- Write `rajio_version` from `packages/rajio/package.json` when creating sessions.
- Reject sessions whose `rajio_version` is missing or differs from the running package
  version.
- Remove `invalid_schema_version` check output because unsupported session versions fail
  during load.

## Tests

- New sessions include `rajio_version` and omit `schema_version`.
- Missing and mismatched `rajio_version` values fail to load.
- Existing check filtering tests use another fatal session issue.

## Assumptions

- No backward compatibility for sessions that only have `schema_version`.
- Version comparison is exact string equality, not semver compatibility.
