# Rajio Skill And CLI Version Sync

## Summary

`skills/rajio/SKILL.md` carries the same version as the rajio CLI package in
frontmatter metadata, and the release bump flow updates it together with package
versions.

## Changes

- Add `metadata.author: OneKuma` and `metadata.version: "0.1.0"` to
  `skills/rajio/SKILL.md` frontmatter.
- Include `skills/rajio/SKILL.md` in the root `release` script's `bumpp` file list.
- Document that agents should compare the `rajio doctor` CLI version output with the
  SKILL frontmatter `metadata.version` before automatic stages.
- Place the doctor check at the start of the transcript-work section, after
  `description.md` preparation.

## Tests

- Documentation and release-script change only; no runtime tests required.
- Manually check the SKILL version, both package versions, and `release` file list match.

## Assumptions

- The SKILL version follows the rajio package/CLI version and is not released separately.
- `rajio doctor` does not read SKILL files; the comparison is an agent operating rule.
