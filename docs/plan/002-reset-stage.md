# Reset Stage Plan

## Summary

Add reset-stage control to the rajio workflow through the default command:

```bash
rajio <target> --reset <stage>
```

`--reset <stage>` means regenerate from the selected workflow stage. It resets that stage
and all downstream stages to `pending`, then lets the existing workflow continue. Remove
`--force` instead of keeping a second, overlapping rerun semantic.

## Public Interface

- Expose reset-stage control as `rajio <target> --reset <stage>`.
- Valid stages: `audio`, `transcript_raw`, `transcript_work`, `translation_work`, `export`.
- Remove `--force`.
- Update `CliOptions`: remove `force`, add `reset?: StageName`.

## Behavior Matrix

### No `--reset`

| Current stage      | Current status                 | Behavior                                                                                             |
| ------------------ | ------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `audio`            | `pending` / `failed`           | Run audio, then advance to `transcript_raw`.                                                         |
| `audio`            | `done`                         | Skip audio and advance to `transcript_raw`.                                                          |
| `transcript_raw`   | `pending`                      | Clear old raw chunk checkpoints and transcribe all chunks.                                           |
| `transcript_raw`   | `failed`                       | Retry transcription, reusing successful chunk checkpoints and only filling failed or missing chunks. |
| `transcript_raw`   | `done`                         | Skip transcription and advance to `transcript_work`.                                                 |
| `transcript_work`  | `pending`                      | Generate or overwrite `transcript/work/segments.toml`, then wait.                                    |
| `transcript_work`  | `waiting` / `dirty` / `failed` | Stop at the manual stage and prompt for edit plus `--commit`.                                        |
| `transcript_work`  | `committed`                    | Advance to `translation_work`.                                                                       |
| `translation_work` | `pending`                      | Generate or overwrite `translation/work/segments.toml`, then wait.                                   |
| `translation_work` | `waiting` / `dirty` / `failed` | Stop at the manual stage and prompt for edit plus `--commit`.                                        |
| `translation_work` | `committed`                    | Advance to `export`.                                                                                 |
| `export`           | `pending` / `failed`           | Export subtitles, overwriting output files.                                                          |
| `export`           | `done`                         | Report completion and output paths.                                                                  |

### Reset To `audio`

All stages become `pending`, and `current_stage` becomes `audio`. The workflow re-extracts
audio, recreates audio chunks, then reaches `transcript_raw` as `pending`, which clears old
raw chunk checkpoints and performs a full transcription.

### Reset To `transcript_raw`

`audio` is preserved. `transcript_raw`, `transcript_work`, `translation_work`, and `export`
become `pending`, and `current_stage` becomes `transcript_raw`. The workflow clears old raw
chunk checkpoints and performs a full transcription.

### Reset To `transcript_work`

`audio` and `transcript_raw` are preserved. `transcript_work`, `translation_work`, and
`export` become `pending`, and `current_stage` becomes `transcript_work`. The workflow
regenerates `transcript/work/segments.toml` from the current raw transcript and waits.

### Reset To `translation_work`

`audio`, `transcript_raw`, and `transcript_work` are preserved. `translation_work` and
`export` become `pending`, and `current_stage` becomes `translation_work`. If
`transcript_work` is clean committed, the workflow regenerates `translation/work/segments.toml`
and waits.

### Reset To `export`

Only `export` becomes `pending`, and `current_stage` becomes `export`. If translation work is
clean committed, the workflow regenerates subtitle output files.

## Edge Rules

- Reset-stage does not delete files. It invalidates stage state in `session.toml`.
- Reset manual stages overwrite their corresponding work file when setup runs because the
  stage is `pending`.
- Normal failure retry does not require `--reset`.
- Full retranscription uses `rajio <target> --reset transcript_raw`.
- Regenerating transcript proofread work without rerunning ASR uses
  `rajio <target> --reset transcript_work`.
- Media hash changes take priority and invalidate the full workflow back to `audio`. If this
  happens and the user requested a reset stage other than `audio`, the command errors and asks
  them to rerun from audio first.
- Dirty manual stages still retarget the workflow after reset. For example,
  `--reset export` stops at dirty `translation_work` instead of exporting.

## Implementation Changes

- Add default-command parsing for `--reset <stage>` and validate with `STAGES.includes()`.
- Add `resetSessionToStage(session, stage)` in the workflow layer.
- Change `runRajio()` startup order:
  1. `refreshMediaState()`.
  2. Reject non-audio reset if media was invalidated.
  3. Apply reset if requested.
  4. `refreshDirtyState()`.
  5. Retarget dirty manual stage.
  6. Continue the workflow.
- Remove force arguments and propagation from CLI, workflow, manual setup, and transcription.
- Keep `transcript_raw pending` as the full-regeneration path by clearing raw chunk checkpoints.
- Keep `transcript_raw failed` as the resume path by reusing successful chunk checkpoints.

## Test Plan

- No reset:
  - `transcript_raw failed` retries with successful checkpoint reuse.
  - `transcript_raw pending` clears checkpoints and transcribes all chunks.
  - Manual `waiting`, `dirty`, and `failed` stages do not overwrite work files.
- Reset:
  - `--reset audio` resets all stages.
  - `--reset transcript_raw` preserves audio, resets raw and downstream stages, and transcribes all chunks.
  - `--reset transcript_work` preserves raw and regenerates transcript work.
  - `--reset translation_work` preserves clean committed transcript work and regenerates translation work.
  - `--reset export` regenerates exports when translation is clean committed.
  - `--reset export` with dirty translation work stops at `translation_work`.
- CLI:
  - Invalid reset stage errors.
  - `--force` is no longer a declared command option.

## Assumptions

- The CLI can remove `--force` without a compatibility alias or explicit migration error.
- `--reset` uses internal stage names and does not add aliases.
- Reset is regeneration, not "move current stage while keeping target artifacts valid".
