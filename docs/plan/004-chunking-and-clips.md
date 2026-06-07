# Silence-Aware Chunking And Clip Retranscription Plan

## Summary

Add local chunk splitting options for normal audio extraction/transcription, and add `clips`
commands for sidecar retranscription of source-video time ranges.

The default command reads chunk options from CLI arguments on first run and on `--reset audio`.
The effective options used to generate chunks are recorded in `session.toml` under
`stages.audio.chunking`. Clip retranscription records the same option shape in that clip's
`clip.toml`. OpenAI ASR chunking configuration is unchanged.

## Key Changes

- Add default-command options: `--chunk-target`, `--chunk-boundary-search`,
  `--chunk-silence-noise`, and `--chunk-silence-duration`.
- New audio stage writes `[stages.audio.chunking]` and no longer writes `chunk_count`,
  `chunk_max_seconds`, `chunk_target_seconds`, or `chunk_boundary`.
- `stages.audio.chunks[]` is the source of truth for normal audio chunks; unrecorded files in
  `audio/chunks/` are ignored.
- Audio stage does not write partial `chunks[]`; it writes chunk metadata only after all chunks are
  generated and validated.
- Add `rajio clips transcribe/list/show` under `packages/rajio/src/clips/`. Clip artifacts live in
  `clips/<clip-id>/` and do not mutate workflow stage state or main transcript/work files.

## Clips Directory

```text
session/
  clips/
    clip-120000-180000/
      clip.toml
      source.m4a
      chunks/
        chunk-000.m4a
        chunk-000.toml
        chunk-000.error.log
      segments.toml
```

- `clip.toml`: clip index and source of truth, including id, label, source media/hash, absolute
  start/end, chunking options, chunk list, segments path, and timestamps.
- `source.m4a`: audio extracted from the original media `[start, end)` range.
- `chunks/chunk-*.m4a`: audio chunks uploaded to ASR. Single-chunk clips also use this path.
- `chunks/chunk-*.toml`: successful ASR response checkpoints for resume.
- `chunks/chunk-*.error.log`: failed chunk logs. Failed chunks do not write checkpoints.
- `segments.toml`: normalized sidecar transcript with absolute source-video segment times.

## Clips Commands

- `rajio clips transcribe --session <target> --start <seconds> --end <seconds> [options]`
  - Extracts the source media range, creates `source.m4a` and `chunks/chunk-*.m4a`.
  - Supports the same four local chunk options as the default command and records them in
    `clip.toml`.
  - Writes successful chunk checkpoints and failed chunk error logs.
  - Merges checkpoints into `segments.toml`, offsetting segment times back to source-video time.
  - Supports checkpoint resume: successful chunks are skipped; failed or missing chunks are retried.

- `rajio clips list --session <target> [--json]`
  - Scans `clips/*/clip.toml`.
  - Uses the same output mode rule as `segments`: TTY human table, non-TTY CSV, `--json` JSON.
  - Columns: `id,label,start,end,duration,status,segments`.
  - Status values: `done`, `failed`, `partial`, `missing`.

- `rajio clips show <id> --session <target> [--json]`
  - Outputs only that clip's `segments.toml`, not `clip.toml` metadata.
  - Uses the same output mode rule and segment columns as `segments list`.

## Test Plan

- First audio stage and `--reset audio` apply CLI chunk options and write
  `stages.audio.chunking`.
- New audio stage no longer writes `chunk_count` or old overlapping fields.
- Audio interruption does not leave partial chunk lists in `session.toml`.
- `transcript_raw` rejects recorded chunks with missing files, size/hash mismatch, or invalid time.
- `clips transcribe` creates the planned directory shape and supports checkpoint resume.
- `clips list` outputs compact columns and correctly derives `status` and `segments`.
- `clips show` outputs only `segments.toml`.
- Verify with `pnpm --filter rajio test` and `pnpm --filter rajio typecheck`.

## Assumptions

- Silence boundary search is always enabled.
- `session.toml` and `clip.toml` are the sources of truth for normal chunks and clip chunks.
- Clip retranscription is review-only; no auto merge/replace is implemented.
