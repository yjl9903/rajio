# Remove the built-in Codex SDK integration

## Decision

Remove the SDK dependency and all built-in agent execution logic. The user confirmed that
no compatibility layer is required. Manual stages remain editable by humans or external
agents and are advanced through explicit `--commit` commands.

## Implementation

- Remove the SDK from the package manifest and pnpm lockfile, including its platform packages.
- Delete the internal agent runner, prompt generation, event logging/rotation, and automatic
  agent-and-commit wrapper. Remove the redundant manual-stage branch.
- Remove the full-run CLI option and workflow flag. Automatic progression is controlled
  solely by `--continue=until-manual|step`; both modes stop at manual stages.
- Remove agent readiness checks from doctor. Probe only the selected transcription provider;
  ElevenLabs sessions do not require or probe OpenAI credentials. Preserve the OpenAI SDK,
  environment configuration, and transcription provider.
- Remove obsolete CLI entrypoint tests and documentation. Update CLI help and the doctor
  documentation to describe the selected-provider checks. Leave README.md unchanged.
- Do not migrate or delete files in existing user sessions; no runtime compatibility code
  or session-format change is needed.

## Verification

- `pnpm test:ci`: all 273 tests passed; both packages built and passed typecheck.
- Selected-provider isolation, missing OpenAI credentials, provider failure, and exactly one
  OpenAI probe are covered. Existing workflow tests cover manual-stage waiting and commits.
- Built `doctor --help` reflects the selected-provider checks.
- Source, tests, package manifest, and lockfile contain no Codex SDK imports, agent execution/logging
  logic, or removed CLI flags. `git diff --check` passes.

## Follow-up Audit

- Remove the environment documentation's remaining claims that OpenAI credentials are used
  for built-in agent/manual AI work. These credentials belong to OpenAI transcription.
- Remove the orphaned legacy force-commit field cleanup from manual-stage commits; no current
  code writes or reads that field, and no historical compatibility layer is required.
- Retain external-agent skill installation instructions, editorial policies, and the OpenAI
  transcription SDK. These remain part of the supported workflow.

## Release Artifact Audit

- Inspect the dry-run package file list as well as tracked source. The ignored package-local
  skill copy was stale and still documented the removed full-run option in three places.
- Regenerate that copy through `pnpm --filter rajio prepack`; do not edit generated copies
  manually. Its file set and contents now match `skills/rajio` exactly, including removal
  of the obsolete CLI reference file.
- The dry-run package contains 73 files and no removed SDK imports, runner/logging symbols,
  CLI flags, or legacy force-commit fields.
- Runtime checks confirm both removed CLI options are rejected before session creation;
  root and doctor help contain no obsolete entries. No source behavior changed in this audit.
