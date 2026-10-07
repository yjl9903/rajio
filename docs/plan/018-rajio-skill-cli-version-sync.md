# Rajio Skill And CLI Version Sync

## Summary

`skills/rajio/SKILL.md` carries the same version as the rajio CLI package in
frontmatter metadata, and the release bump flow updates it together with package
versions.

## Changes

- Add `metadata.author: OneKuma` and `metadata.version: "0.1.0"` to
  `skills/rajio/SKILL.md` frontmatter.
- Include `skills/rajio/SKILL.md` in the root `release` script's `bumpp` file list.
- Copy `skills/rajio/` into the package-local `skills/` directory during `build`,
  replacing any previous copy in the tsdown `build:done` hook using Node file APIs.
  Resolve paths relative to `tsdown.config.ts`; the build script only runs `tsdown`.
  Remove the `prepack` lifecycle script; packaging and publishing use the build output
  already present.
- Include the source skill directory in the rajio Turbo build inputs and the copied
  `skills/` directory in its outputs so cache invalidation and restoration cover both
  compiled code and skill documents.
- Document that agents should compare the `rajio doctor` CLI version output with the
  SKILL frontmatter `metadata.version` before automatic stages.
- Place the doctor check at the start of the transcript-work section, after
  `description.md` preparation.

## Tests

- Build and release-script change only; no runtime tests required.
- Manually check the SKILL version, both package versions, and `release` file list match.
- Run `pnpm --filter rajio build` and compare the package-local skill copy with its source.
- Verify Turbo's resolved build inputs include the source skill files and its outputs
  include both `dist/` and `skills/`.

## Assumptions

- The SKILL version follows the rajio package/CLI version and is not released separately.
- `rajio doctor` does not read SKILL files; the comparison is an agent operating rule.
