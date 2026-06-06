# Repository Guidelines

## Project Structure & Module Organization

This is a pnpm/Turbo TypeScript workspace. The main package lives in `packages/rajio`.
Source files are under `packages/rajio/src`, grouped by feature: `session/` for session
state and validation, `workflow/` for processing stages, `utils/` for shared helpers, and
`cli.ts` for the command-line entrypoint. Tests are in `packages/rajio/test`. Build output goes
to `packages/rajio/dist` and should not be edited directly. Repository-level docs and plans live
in `docs/`, helper shell scripts in `scripts/`, and the installable agent skill in `skills/rajio/`.

## Build, Test, and Development Commands

- `pnpm install`: install workspace dependencies. Use Node `>=24`; CI currently runs Node `26.3.0`.
- `pnpm build`: run Turbo builds; `packages/rajio` is bundled by `tsdown`.
- `pnpm test:ci`: run typecheck-dependent CI tests with Vitest in non-watch mode.
- `pnpm typecheck`: run `tsc --noEmit` through Turbo.
- `pnpm format`: format TypeScript and JavaScript files with Prettier.
- `pnpm rajio <args>`: run the local CLI from `packages/rajio/src/cli.ts` via `tsx`.

For package-scoped work, commands such as `pnpm --filter rajio test` and
`pnpm --filter rajio build` are appropriate.

## Coding Style & Naming Conventions

Use strict TypeScript and ESM imports. Keep source files as `.ts`; use `.js` extensions in local
relative imports where required by the existing TypeScript bundler setup. Prettier is authoritative:
semicolons, single quotes, 100-character print width, and no trailing commas. Prefer descriptive
camelCase for functions and variables, PascalCase for classes and types, and kebab-case for CLI or
filesystem-facing names.

## Testing Guidelines

Vitest is the test framework. Add focused tests under `packages/rajio/test`, using `describe` blocks
that match the behavior being exercised, for example `describe('session workflow', ...)`. Prefer
temporary directories and explicit fixtures over relying on local machine state. Run `pnpm test:ci`
before opening a PR; use `pnpm --filter rajio test` while iterating.

## Commit & Pull Request Guidelines

Recent history uses conventional-style prefixes such as `feat:` and `chore:`. Keep commit subjects
short, imperative, and scoped to one change. Pull requests should include a brief summary, the
commands run for verification, and notes about CLI behavior, generated files, or workflow/session
format changes. Link relevant issues when available.

## Security & Configuration Tips

Do not commit secrets, media files, or generated session outputs. Runtime configuration is read from
`.env` files and environment variables such as `OPENAI_API_KEY`, `OPENAI_BASE_URL`,
`RAJIO_FFMPEG_BIN`, and `RAJIO_FFPROBE_BIN`; keep local overrides out of version control.
