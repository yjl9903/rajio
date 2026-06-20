# Rajio CLI Reference

Use this file as the command reference for operating a `rajio` session. The workflow
rules in [SKILL.md](SKILL.md) still apply: manual proofreading and translation are agent work,
raw transcript files are read-only references, and clip transcripts are review artifacts.

## Agent Defaults

- Always pass an explicit session target. Target position follows the command shape:
  `rajio <target>`, `rajio check|doctor|clean <target>`, and
  `rajio segments|clips <command> <target>`.
- Prefer `--json` for `segments list`, `segments apply`, `segments edit`,
  `segments split`, `segments merge`, `segments delete`, `clips list`, `clips show`,
  and `check` whenever the output will be parsed.
- Edit only manual work files through `rajio segments`: `transcript/work/segments.toml`
  with `--stage transcript`, or `translation/work/segments.toml` with
  `--stage translation`.
- Do not edit `transcript/raw/segments.toml`, `transcript/raw/checkpoints/*.toml`, or
  `transcript/raw/chunks/*.toml`.
- Use `rajio clips` only to independently retranscribe difficult source-video ranges
  for comparison. Clip output never updates the main transcript automatically.
- Use `rajio check` to validate file shape and common segment issues. It is a quality
  floor, not a finished-quality signal, and does not replace manual QA for ASR mistakes,
  names, terms, context, translation quality, or editorial polish.

## Availability

Check whether the CLI is installed:

```bash
command -v rajio
```

If it is not installed, run the same commands through `npx rajio ...`.

## Environment

rajio reads these environment variables:

- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`
- `ELEVENLABS_API_KEY`
- `FFMPEG_PATH`
- `FFPROBE_PATH`

When a command needs runtime configuration, rajio loads `.env` from the command cwd,
then loads `.env` from the resolved session directory. Later files override earlier
values, so priority is:

```text
session .env > cwd .env > process environment
```

Transcription commands upload audio to the configured transcription provider.
Follow the privacy rule in [SKILL.md](SKILL.md) before starting transcription.

## Targets

The default command is:

```bash
rajio <target> [options]
```

`<target>` is required. It may be:

- a session directory
- `session.toml`
- a description markdown file
- a media file

Target resolution:

- Existing session directory: read `session.toml`; reuse `[input].media` unless
  `--media <path>` is supplied.
- New directory target: initialize from the directory's single description markdown,
  description `media` frontmatter, or single media file.
- Description markdown target: use the markdown file's parent directory as the session
  and resolve `media` frontmatter relative to the markdown file.
- Media file target: use the media file's parent directory as the session; use the
  media file unless `--media <path>` is supplied.
- If a directory has multiple candidate description markdown files or multiple media
  files and no stronger target/override is provided, the command errors.

`--media <path>` is an invocation override. For a new session it is saved in
`session.toml`; for an existing session it replaces the media path used for that run
without rewriting `[input].media`. If the processed media hash changes, rajio
invalidates the workflow back to `audio`.

## Default Command

```bash
rajio /path/to/session --continue=until-manual
rajio /path/to/session --continue=step
rajio /path/to/session --commit --continue=until-manual
rajio /path/to/session --reset transcript_raw
```

Workflow controls:

- `--continue until-manual|step`: default is `until-manual`. `until-manual` runs
  automatic stages until the next manual stage. `step` runs at most one automatic
  stage unless `--full` is also set.
- `--commit`: validate and commit the current manual stage, recording the current
  work file hash in `session.toml`, then continue according to `--continue`.
- `--reset <stage>`: reset the selected stage and all downstream stages to
  `pending`, set `current_stage` to that stage, and continue. Valid stages are
  `audio`, `transcript_raw`, `transcript_work`, `translation_work`, and `export`.
  Reset changes `session.toml` state; it does not delete files.
- `--full`: run remaining automatic stages. Manual stages still stop for manual edit
  and `--commit`.

Subtitle QA exceptions are recorded per segment in `segments.toml`, not in `session.toml`.
Before adding a skip annotation, run:

```bash
rajio check /path/to/session --json --level error --verbose
```

Inspect every remaining `fatal`/`error` issue manually. Only segment-level subtitle QA
`error` issues may be skipped, and every skip must name the exact issue code and give a
reason. Never skip unfinished translation, empty text, broken timing, overlaps, duplicate
IDs, bad schema, missing files, failed automatic stages, or large unreviewed batches of
errors. In `translation_work`, inherited Japanese subtitle QA hard rules are warnings and
appear in the `--language ja` check view, so they do not require skip annotations; Chinese
hard QA exceptions do.

```toml
[[segments]]
id = "12"
start = 10.0
end = 12.0
speaker = "A"
ja = "STRAIGHT! REACH!! CHEER!!!"
zh = "STRAIGHT! REACH!! CHEER!!!"
skip_checks = [
  { code = "zh_repeated_punctuation", reason = "Official title spelling." },
  { code = "zh_line_hard_limit", reason = "Official title should stay on one line." }
]
```

Matched skipped issues are omitted from `rajio check` output because the annotation is the
manual confirmation. If a skip no longer matches an actual issue on that segment, `rajio
check` reports a blocking `unused_skip_check` fatal issue until the stale annotation is
removed.

Allowed `skip_checks.code` values are:

- `ja_line_hard_limit`, `zh_line_hard_limit`
- `ja_line_break_can_merge_soft`, `zh_line_break_can_merge_soft`
- `ja_line_break_hard_limit`, `zh_line_break_hard_limit`
- `duration_too_short`, `duration_too_long`
- `ja_reading_speed_limit`, `zh_reading_speed_limit`
- `subtitle_gap_too_short`
- `ja_common_punctuation`, `zh_common_punctuation`
- `ja_terminal_punctuation`, `zh_terminal_punctuation`
- `ja_punctuation_only_line`, `zh_punctuation_only_line`
- `ja_repeated_punctuation`, `zh_repeated_punctuation`

Reset boundaries:

- `--reset audio`: re-extract audio, rerun transcription, and invalidate all downstream work.
- `--reset transcript_raw`: preserve audio metadata, clear raw transcript checkpoints, rerun ASR,
  and invalidate transcript work, translation work, and export.
- `--reset transcript_work`: preserve raw transcript and regenerate
  `transcript/work/segments.toml`.
- `--reset translation_work`: preserve clean committed transcript work and regenerate
  `translation/work/segments.toml`.
- `--reset export`: preserve clean committed translation work and regenerate outputs.
- If media changed and `--reset` is not `audio`, the command errors and asks for an
  audio-stage rerun first.
- If a committed manual work file changed, rajio marks it `dirty` and retargets the
  workflow to that manual stage before continuing. Recommit that manual stage after
  review; `dirty` is a workflow state, not a `rajio check` issue.

Audio chunk options:

- `--chunk-target <seconds>`: target local audio chunk length. Default `600`;
  minimum `60`.
- `--chunk-boundary-search <seconds>`: seconds around the target cut point to search
  for silence. Default `90`; range `0..300`.
- `--chunk-silence-noise <db>`: ffmpeg `silencedetect` noise threshold. Default `-35`.
- `--chunk-silence-duration <seconds>`: ffmpeg `silencedetect` minimum silence
  duration. Default `0.4`; must be non-negative.

`--chunk-target + --chunk-boundary-search` must be at most `1350` seconds. rajio keeps both
`single_file` and chunking audio strategies. With the current ElevenLabs/scribe_v2/integrated
flow, these options are validated but the audio stage records `strategy = "single_file"` and does
not write `stages.audio.chunking` or `stages.audio.chunks[]`.

## Segments Commands

Use these commands for stable targeted edits to manual work-stage `segments.toml` files.

```bash
rajio segments list /path/to/session --stage transcript
rajio segments apply /path/to/session [file] --stage translation
rajio segments edit /path/to/session <id> --stage transcript [fields]
rajio segments split /path/to/session <id> --stage transcript [fields]
rajio segments merge /path/to/session <id1> <id2> --stage transcript [fields]
rajio segments delete /path/to/session <id> --stage transcript
```

Stage selection:

- `--stage transcript` edits `transcript/work/segments.toml`.
- `--stage translation` edits `translation/work/segments.toml`.
- If `--stage` is omitted, the CLI uses the session's current manual stage only when
  `current_stage` is `transcript_work` or `translation_work`; otherwise it errors.
  Agents should still pass `--stage` explicitly.

Output mode:

- TTY without `--json`: human-readable output.
- Non-TTY without `--json`: CSV for commands that print segment rows.
- `--json`: structured JSON. Use shell pipelines with `jq` when you need to extract fields
  or slice down the output.

Segment mutation commands print affected rows, except `segments apply`, which defaults to
operation counts plus patch-scoped check feedback. `--dry-run` validates and prints the
result without writing `segments.toml`.

Segment ids must be non-empty, trimmed strings without commas.

### segments list

```bash
rajio segments list /path/to/session --stage transcript
rajio segments list /path/to/session --stage transcript --id 12
rajio segments list /path/to/session --stage transcript --id 12,15,19
rajio segments list /path/to/session --stage transcript --id 12,15,19 --around 3
rajio segments list /path/to/session --stage transcript --offset 100 --limit 50
rajio segments list /path/to/session --stage transcript --start 600 --end 660
rajio segments list /path/to/session --stage translation --issues empty_zh,zh_line_hard_limit
rajio segments list /path/to/session --stage translation --issues duration_too_long --level error
```

`segments list` accepts only one filter mode per invocation:

- `--id <ids>`: list a comma-separated id list in requested order. Segment ids
  themselves must not contain commas.
- `--id <ids> --around <count>`: list that many neighboring segments on each side of
  each requested id, deduplicated in timeline order. `--around` must be a non-negative
  integer.
- `--offset <count> --limit <count>`: list a zero-based window. `--offset` and
  `--limit` must be non-negative integers. If `--limit` is omitted, list from offset
  to the end.
- `--start <seconds> --end <seconds>`: list segments whose `start` is in
  `[start, end)`. Both options are required together.
- `--issues <codes>`: list segments matching comma-separated `rajio check` validation
  codes. Add `--level fatal|error|warning` to filter by threshold; default is `warning`,
  and `error` excludes warning-level matches for soft-or-hard codes like duration and
  reading speed.

In JSON mode, list output includes:

- `segments`: rows with `id`, `start`, `end`, `speaker`, `ja`, and `zh`.
- `stats`: `total`, `listed`, `translated`, and `untranslated` counts.

JSON shape:

```json
{
  "segments": [
    { "id": "12", "start": 10.2, "end": 13.4, "speaker": "A", "ja": "...", "zh": "..." }
  ],
  "stats": { "total": 120, "listed": 1, "translated": 80, "untranslated": 40 }
}
```

### segments apply

```bash
rajio segments apply /path/to/session patch.toml --stage translation --dry-run
rajio segments apply /path/to/session patch.toml --stage translation
rajio segments apply /path/to/session --stage translation <<'EOF'
[[operations]]
op = "edit"
segment_id = "12"
zh = "修正后的中文字幕"
EOF
```

`segments apply <target> [file]` applies an ordered TOML patch as the batch form of edit, split,
merge, and delete operations. Pass a patch file path, or omit `[file]` only when supplying
TOML on stdin in the same shell command.

Normal apply writes the patched segments, then runs patch-scoped check feedback. `--dry-run`
validates the patch, previews affected output, and runs the same checks without writing changes.
Blocking check issues are reported in the check output but do not change the apply command exit
code. Normal apply does not roll back already-written changes.

Patch example:

```toml
name = "Translation fixes"
summary = "Batch edits for the first review pass."
created_by = "worker-a"
start = 120.0
end = 180.0

[[operations]]
op = "edit"
reason = "Use the agreed translation for the title."
confidence = "high"
segment_id = "12"
zh = "修正后的中文字幕"

[[operations]]
op = "edit"
segment_id = "title"
skip_checks = [
  { code = "zh_repeated_punctuation", reason = "Official title spelling." },
  { code = "zh_line_hard_limit", reason = "Official title should stay on one line." }
]

[[operations]]
op = "split"
source_id = "long"
gap = 0.05

[[operations.replacements]]
segment_id = "long.1"
start = 10.0
end = 13.2
speaker = "A"
ja = "前半の日本語"
zh = "前半中文字幕"

[[operations.replacements]]
segment_id = "long.2"
start = 13.2
end = 16.0
speaker = "A"
ja = "後半の日本語"
zh = "后半中文字幕"

[[operations]]
op = "merge"
source_ids = ["13.1", "13.2"]
merged_id = "13"
speaker = "A,B"
ja = "結合した日本語"
zh = "合并后的中文字幕"

[[operations]]
op = "delete"
segment_id = "14"
```

Patch rules:

- A patch must contain at least one `[[operations]]`.
- A patch may include top-level `name`, `summary`, `created_by`, `start`, and `end` metadata.
  `summary` describes the patch content. `start` and `end` are source media seconds for the patch
  check range. If either is missing, apply checks the min/max time covered by affected segments
  and keeps their immediate neighbors in scope for boundary QA.
- Any operation may include `reason` and `confidence`; `confidence` must be
  `high`, `medium`, or `low`. These metadata fields are informational and do not
  change apply behavior.
- `op = "edit"` requires `segment_id` plus at least one changed field: `start`, `end`, `speaker`,
  `ja`, `zh`, or `skip_checks`.
- In an edit operation, missing `skip_checks` preserves existing annotations,
  `skip_checks = []` clears annotations, and a non-empty array replaces annotations exactly.
  Each skip requires an allowed `code` and non-empty `reason`.
- `op = "split"` replaces `source_id` with two or more `[[operations.replacements]]`.
  `gap` is optional and defaults to `0.05`; values below `0.05` are rejected.
  Replacement segments use virtual continuous timing: they must cover the original
  segment continuously with no gaps or overlaps, start at the original `start`, and end
  at the original `end`. Each internal boundary is treated as the midpoint of the
  inserted gap, so a boundary at `13.2` with `gap = 0.05` becomes previous
  `end = 13.175` and next `start = 13.225`.
- Every generated split segment must remain at least `0.5` seconds long after gap
  insertion.
- If a split source has `zh`, every replacement segment must include `zh`.
- Split replacements do not inherit `skip_checks`; add a later edit operation for each
  replacement that needs a fresh skip annotation.
- `op = "merge"` accepts two or more adjacent source ids in `source_ids`; `merged_id` and `ja` are
  required. If any source has `zh`, merged `zh` is required.
- Merged segments do not inherit `skip_checks`; add a later edit operation when the merged
  text still has an intentional QA exception.
- `op = "delete"` requires only `segment_id`.
- Current segment ids must be unique after every operation.

Output:

- Without `--json`, non-verbose output prints only an apply summary plus grouped check feedback.
- With `--json`, non-verbose output contains top-level `apply` and `check`.
- With `--verbose --json`, output also includes top-level `segments`; rows include affected
  segments plus in-range segments with remaining issues. Each row has `affected` and `issues`.
- With `--verbose` and no `--json`, apply prints the same rows with `AFFECTED` and `ISSUES`
  columns.

Non-verbose JSON output:

```json
{
  "apply": {
    "dry_run": true,
    "stats": { "edits": 1, "splits": 0, "merges": 0, "deletes": 0, "total": 1 }
  },
  "check": {
    "ok": true,
    "range": { "start": 120, "end": 180 },
    "scope": {
      "level": "warning",
      "stage": "translation_work",
      "languages": ["zh"],
      "description": "translation_work zh QA"
    },
    "counts": { "fatal": 0, "error": 0, "warning": 0 },
    "summary": []
  }
}
```

Verbose JSON output:

```json
{
  "apply": {
    "dry_run": true,
    "stats": { "edits": 1, "splits": 0, "merges": 0, "deletes": 0, "total": 1 }
  },
  "check": {
    "ok": false,
    "range": { "start": 120, "end": 180 },
    "scope": {
      "level": "warning",
      "stage": "translation_work",
      "languages": ["zh"],
      "description": "translation_work zh QA"
    },
    "counts": { "fatal": 0, "error": 1, "warning": 0 },
    "summary": [{ "level": "error", "code": "zh_line_hard_limit", "count": 1 }]
  },
  "segments": [
    {
      "id": "12",
      "start": 120,
      "end": 123,
      "speaker": "A",
      "ja": "こんにちは",
      "zh": "你好",
      "affected": true,
      "issues": [{ "level": "error", "code": "zh_line_hard_limit", "message": "..." }]
    }
  ]
}
```

When using `--verbose --json`, pipe the output through `jq` to select the fields you need and
avoid reading overly long raw output:

```bash
rajio segments apply /path/to/session patch.toml --stage translation --dry-run --verbose --json \
  | jq '.segments[] | select(.issues | length > 0) | {id, start, end, affected, issues}'
```

### segments edit

```bash
rajio segments edit /path/to/session 12 --stage transcript \
  --start 10.2 --end 13.4 --speaker A --ja "修正した日本語"

rajio segments edit /path/to/session 12 --stage translation \
  --zh "修正后的中文字幕" --dry-run

rajio segments edit /path/to/session 12 --stage translation --clear-skip-checks
```

Editable fields are `--start`, `--end`, `--speaker`, `--ja`, and `--zh`. Use
`--clear-skip-checks` to remove stale segment skip annotations. At least one field or
`--clear-skip-checks` is required. Ordinary edits preserve existing `skip_checks`.

### segments split

```bash
rajio segments split /path/to/session 12 --stage transcript \
  --at 11.8 --gap 0.05 --id1 12.1 --id2 12.2 \
  --ja1 "前半の日本語" --ja2 "後半の日本語" \
  --speaker1 A --speaker2 B
```

`segments split` replaces one segment with exactly two segments separated by a subtitle
gap. Required options are `--at`, `--id1`, `--id2`, `--ja1`, and `--ja2`.

Rules:

- `--at` is the midpoint of the inserted gap.
- `--gap` is optional and defaults to `0.05`; values below `0.05` are rejected.
- The first segment ends at `--at - --gap / 2`; the second starts at
  `--at + --gap / 2`.
- Both generated segments must remain at least `0.5` seconds long.
- `--id1` and `--id2` must be different and must not conflict with other segment ids.
- `--speaker1` and `--speaker2` default to the original speaker when omitted.
- If the source segment has `zh`, both `--zh1` and `--zh2` are required.

Use `segments apply` for splits into more than two replacement segments.

### segments merge

```bash
rajio segments merge /path/to/session 12.1 12.2 --stage transcript \
  --id 12 --ja "結合した日本語" --speaker A,B
```

`segments merge` merges exactly two adjacent segments in file order. Required options
are `--id` and `--ja`.

Rules:

- The two source ids must be adjacent in file order.
- The merged id must not conflict with another segment id except the two source ids.
- If either source segment has `zh`, `--zh` is required.
- If `--speaker` is omitted, speakers are merged as a comma-separated de-duplicated list.

Use `segments apply` to merge more than two adjacent source segments.

### segments delete

```bash
rajio segments delete /path/to/session 13 --stage transcript
```

`segments delete` removes one segment and prints the removed row. Use this only for
semantically empty filler or unwanted subtitle units, not for uncertain ASR text that
should be corrected or merged.

## Clips Commands

Clips are sidecar retranscription artifacts for difficult source-video ranges. They do
not modify workflow stage state, `transcript/raw/segments.toml`, or
`transcript/work/segments.toml`.

```bash
rajio clips transcribe /path/to/session --start 120 --end 180
rajio clips transcribe /path/to/session --start 120 --end 180 --label noisy-overlap
rajio clips list /path/to/session --json
rajio clips show /path/to/session clip-120000-180000 --json
```

### clips transcribe

```bash
rajio clips transcribe /path/to/session \
  --start 120 --end 180 --label noisy-overlap \
  --chunk-target 300
```

Required options are `--start` and `--end`, in source-video seconds. The range is
`[start, end)`.

`clips transcribe`:

- extracts the source media range to `clips/<clip-id>/source.m4a`
- uploads that source audio to ASR for the current ElevenLabs/scribe_v2/integrated flow
- writes successful checkpoints to `checkpoints/input-000.toml`
- writes failed logs to `checkpoints/input-000.error.log`
- writes absolute source-video transcript times to `clips/<clip-id>/segments.toml`
- resumes by reusing a matching checkpoint and retrying failed or missing checkpoints

It accepts the same chunk options as the default command for strategy compatibility, but current
ElevenLabs clip transcription uses `strategy = "single_file"`.

Clip directory shape:

```text
clips/
  clip-120000-180000/
    clip.toml
    source.m4a
    checkpoints/
      input-000.toml
      input-000.error.log
    segments.toml
```

If the same start/end range already has a clip directory, the command resumes that clip. Otherwise
it creates a new id; if the base id is already used by a different clip, a numeric suffix is added.

### clips list

```bash
rajio clips list /path/to/session
```

Output columns are `id`, `label`, `start`, `end`, `duration`, `status`, and `segments`.
JSON mode returns `{ "clips": [...] }` with the same fields.

Status values:

- `done`: `segments.toml` exists and parses.
- `failed`: no parseable `segments.toml`, and at least one checkpoint error log exists.
- `partial`: no parseable `segments.toml`, no error log, and at least one checkpoint exists.
- `missing`: no parseable `segments.toml` and no usable checkpoint state.

### clips show

```bash
rajio clips show /path/to/session clip-120000-180000
```

`clips show <target> <id>` prints only that clip's `segments.toml` rows using the same segment
columns and output modes as `segments list`. In JSON mode it returns `{ "segments": [...] }`
using the segment row shape documented above. It does not print `clip.toml` metadata.

## Check

```bash
rajio check /path/to/session
rajio check /path/to/session --level error
rajio check /path/to/session --level fatal
rajio check /path/to/session --stage transcript --language ja
rajio check /path/to/session --stage translation
rajio check /path/to/session --stage translation --language ja
rajio check /path/to/session --stage translation --start 120 --end 180
rajio check /path/to/session --verbose
```

`rajio check` validates `session.toml` and `segments.toml` files under `transcript/`
and `translation/`, then displays global `fatal` issues plus subtitle QA for the target
stage/language. The target is required.

Filters:

- `--level fatal|error|warning`: default is `warning`.
  - `warning` shows `fatal`, `error`, and `warning`.
  - `error` shows `fatal` and `error`.
  - `fatal` shows only `fatal`.
- `--stage audio|transcript|transcript_raw|transcript_work|translation|translation_work|export`.
  `transcript` maps to `transcript_work`; `translation` maps to `translation_work`.
- `--language ja|zh`: filters language-specific subtitle QA.
  - Transcript checks target `transcript/work/segments.toml`, default to `ja`, and reject
    `zh`.
  - Translation checks target `translation/work/segments.toml`, default to `zh`, and can
    use `ja` to inspect Japanese subtitle QA left in the translation work file.
  - Duration and adjacent-gap QA are language-neutral and appear in either language view.
- `--start <seconds> --end <seconds>`: filters segment-level QA to segments overlapping
  `[start, end)`. Both options are required together. Non-segment `fatal` issues are still
  shown.
- Without `--stage`, the target stage comes from `session.current_stage`. `export` and
  `done` default to `translation_work + zh`; `audio` and `transcript_raw` have no subtitle
  QA target and show only global `fatal` issues.

Output:

- Default human output groups repeated issues by severity, code, and file. Summary lines are
  compact issue indexes; use the hint's `segments list --issues <code>` command for matching
  segment rows.
- `--verbose` prints every issue.
- `--json` prints compact summary JSON with `counts.fatal`, `counts.error`, and
  `counts.warning`. Pipe it to `jq` when you need to extract fields or slice down the
  output.
- `--json --verbose` adds sorted full `issues`.
- `fatal` means data/file/schema/timeline/workflow integrity and cannot be skipped.
- `error` means subtitle QA hard issue; it blocks commit/export unless the exact issue code
  is listed in that segment's `skip_checks` with a reason.
- `warning` means subtitle QA soft issue for review only.
- A skipped `error` is omitted from output; stale or mistyped skips report
  `fatal unused_skip_check`.
- `translation_work` reports inherited Japanese subtitle QA hard rules as warnings in the
  `ja` language view. Chinese subtitle QA hard rules remain `error`, and data integrity
  problems remain `fatal`.

### Issue Codes

`rajio check` reports these validation codes. `segments list --issues` accepts the same
codes for segment-scoped issues; add `--level error` when you need only hard matches for
codes that can be either `warning` or `error`.

| Rule                  | When reported                                | Issue codes                                                                                                                                                                                                                                    |
| --------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data integrity        | duplicate ids, invalid time, overlap         | `duplicate_id`, `invalid_time`, `overlap`                                                                                                                                                                                                      |
| Required text         | required Japanese or Chinese text is empty   | `empty_ja`, `empty_zh`                                                                                                                                                                                                                         |
| Line length           | line exceeds soft or hard character limit    | `ja_line_soft_limit`, `ja_line_hard_limit`, `zh_line_soft_limit`, `zh_line_hard_limit`                                                                                                                                                         |
| Line breaks           | text has unnecessary or too many line breaks | `ja_line_break_can_merge_soft`, `ja_line_break_can_merge_hard`, `ja_line_break_soft_limit`, `ja_line_break_hard_limit`, `zh_line_break_can_merge_soft`, `zh_line_break_can_merge_hard`, `zh_line_break_soft_limit`, `zh_line_break_hard_limit` |
| Subtitle duration     | segment is too short or too long             | `duration_too_short`, `duration_too_long`                                                                                                                                                                                                      |
| Reading speed         | text is too dense for the duration           | `ja_reading_speed_limit`, `zh_reading_speed_limit`                                                                                                                                                                                             |
| Adjacent gap          | gap from previous segment is too short       | `subtitle_gap_too_short`, `subtitle_gap_short`                                                                                                                                                                                                 |
| Common punctuation    | ordinary comma/period punctuation appears    | `ja_common_punctuation`, `zh_common_punctuation` hard QA errors                                                                                                                                                                                |
| Terminal punctuation  | line ends with ordinary sentence mark        | `ja_terminal_punctuation`, `zh_terminal_punctuation` hard QA errors                                                                                                                                                                            |
| Repeated punctuation  | repeated question/exclamation punctuation    | `ja_repeated_punctuation`, `zh_repeated_punctuation` hard QA errors from 2 marks                                                                                                                                                               |
| Punctuation-only line | a line contains only punctuation             | `ja_punctuation_only_line`, `zh_punctuation_only_line` hard QA errors                                                                                                                                                                          |
| Skip annotations      | stale per-segment skip metadata              | `unused_skip_check`                                                                                                                                                                                                                            |

Compact JSON shape:

```json
{
  "ok": false,
  "scope": {
    "level": "warning",
    "stage": "translation_work",
    "languages": ["zh"],
    "description": "translation_work zh QA",
    "hint": "Use --language ja to inspect Japanese QA."
  },
  "range": { "start": 120, "end": 180 },
  "counts": { "fatal": 0, "error": 1, "warning": 2 },
  "summary": [
    {
      "file": "translation/work/segments.toml",
      "level": "error",
      "code": "zh_line_hard_limit",
      "count": 1,
      "message": "Segment 12 Chinese line 1 has 25 chars; hard limit is 24.",
      "examples": [{ "id": "12" }]
    }
  ]
}
```

With `--json --verbose`, `issues` is added. Each issue contains `file`, optional `stage`,
`level`, optional `code`, `message`, optional `segmentId`, and optional `segment` context
with `id`, `start`, `end`, `duration`, adjacent ids, text lengths, and text preview.

Exit behavior:

- If any displayed issue is `fatal` or `error`, process exit code is `1`.
- If no displayed `fatal` or `error` remains, the command exits successfully, even if
  unfiltered issues existed outside the selected stage/language/level.

## Doctor

```bash
rajio doctor /path/to/session
```

`rajio doctor` reports the rajio CLI version and update status, then checks session runtime
readiness: `.env` loading, ElevenLabs Speech-to-Text API reachability for ElevenLabs transcription,
OpenAI/Codex readiness where relevant, ffmpeg, ffprobe, and Node.js version expectations. The
target is required. If any check fails, process exit code is `1`.

Run `doctor` before automatic transcription/export stages or when provider, ffmpeg, or
environment setup looks misconfigured. Also compare the reported CLI version with
the current [SKILL.md](SKILL.md) frontmatter `metadata.version` before automatic
stages.

## Clean

```bash
rajio clean /path/to/session
```

`rajio clean` removes these generated session artifacts:

- `session.toml`
- `audio/`
- `transcript/`
- `translation/`
- `output/`

It does not remove `description.md`, source media files, or `clips/`. Use it only when
the user explicitly asks to discard generated workflow state and artifacts.
