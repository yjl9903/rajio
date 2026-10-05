# Use Node.js native environment parsing

## Decision

Replace the dotenv dependency with `node:util`'s `parseEnv`, available within the existing
Node.js >=24 requirement. Use native .env syntax without a compatibility layer for dotenv-only
syntax, such as colon-separated assignments or double-quoted carriage-return escapes.

## Implementation

- Read each existing .env file as UTF-8 and assign its parsed values to `process.env`.
- Preserve the documented priority: session .env > cwd .env > original process environment.
- Continue skipping missing files and loading only once when cwd and session directory match.
- Let file read errors propagate instead of discarding dotenv's returned errors.
- Remove dotenv from the package manifest and lockfile. Leave README.md unchanged.

## Verification

- `pnpm --filter rajio test --run`: all 273 tests passed, including runtime environment
  priority and doctor configuration loading.
- `pnpm --filter rajio build` and `pnpm --filter rajio typecheck`: passed.
- `pnpm exec prettier --check packages/rajio/src/utils/env.ts` and `git diff --check`: passed.
- No dotenv references remain in runtime source, the package manifest, or the lockfile.
