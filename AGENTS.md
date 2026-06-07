# Repository Guidelines

## Project Map

This is a pnpm/Turbo TypeScript workspace. The main package is `packages/rajio`.

- `packages/rajio/src`: source code
  - `cli.ts`: CLI entrypoint
  - `session/`: session state and validation
  - `workflow/`: processing stages
  - `utils/`: shared helpers
- `packages/rajio/test`: Vitest tests
- `packages/rajio/dist`: generated build output; do not edit
- `docs/`: repository docs
- `docs/plan/`: implementation plans and design notes
- `scripts/`: helper scripts
- `skills/rajio/`: installable agent skill

## Planning

Before planned implementation work, check `docs/plan/` and related docs for existing decisions.
Save new agreed plans under `docs/plan/` with numbered kebab-case names, for example
`001-rajio-v1.md`. If behavior changes during implementation, update the plan instead of leaving it
stale.

## Commands

- `pnpm install`: install dependencies. Use Node `>=24`; CI uses Node `26.3.0`.
- `pnpm build`: run Turbo builds.
- `pnpm test:ci`: run CI tests.
- `pnpm typecheck`: run `tsc --noEmit` through Turbo.
- `pnpm format`: format with Prettier.
- `pnpm rajio <args>`: run the local CLI through `tsx`.

For package-scoped work, prefer `pnpm --filter rajio test` and `pnpm --filter rajio build`.

## Code Style

Use strict TypeScript and ESM imports. Keep source files as `.ts`; use `.js` extensions in local
relative imports where the existing setup requires them. Prettier is authoritative: semicolons,
single quotes, 100-character print width, and no trailing commas.

Use descriptive `camelCase` for values and functions, `PascalCase` for classes and types, and
`kebab-case` for CLI or filesystem-facing names.

## Tests

Use Vitest. Add focused tests under `packages/rajio/test`, with `describe` names matching the
behavior under test. Prefer temporary directories and explicit fixtures over local machine state.
Run `pnpm test:ci` before a PR; use `pnpm --filter rajio test` while iterating.

## Git And PRs

Use short conventional-style commit subjects such as `feat:` or `chore:`. Keep each commit scoped to
one change. PRs should include a summary, verification commands, and notes for CLI behavior,
generated files, or workflow/session format changes.

## Security

Do not commit secrets, media files, generated session outputs, or local `.env` overrides. Runtime
configuration may come from `.env`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `RAJIO_FFMPEG_BIN`, and
`RAJIO_FFPROBE_BIN`.
