# rajio CLI Reference

Use this file as the command reference for operating a `rajio` session. The workflow
rules in `SKILL.md` still apply: manual proofreading and translation are agent work,
raw transcript files are read-only references, and clip transcripts are review artifacts.

## Agent Defaults

- Always pass the session target as the first positional argument on every command.
- Prefer `--json` for `segments list`, `segments edit`, `segments apply`,
  `segments split`, `segments merge`, `segments delete`, `clips list`, and
  `clips show` whenever the output will be parsed.
- Edit only manual work files through `rajio segments`: `transcript/work/segments.toml`
  with `--stage transcript`, or `translation/work/segments.toml` with
  `--stage translation`.
- Do not edit `transcript/raw/segments.toml` or `transcript/raw/chunks/*.toml`.
- Use `rajio clips` only to independently retranscribe difficult source-video ranges
  for comparison. Clip output never updates the main transcript automatically.
- Use `rajio check` to validate file shape and common segment issues. It does not
  replace manual QA for ASR mistakes, names, terms, context, or translation quality.
- Do not use `--agent=codex` for ordinary single-video proofreading or translation
  unless the user explicitly asks for batch or automatic multi-session operation.

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
- `RAJIO_FFMPEG_BIN`
- `RAJIO_FFPROBE_BIN`

When a command needs runtime configuration, rajio loads `.env` from the command cwd,
then loads `.env` from the resolved session directory. Later files override earlier
values, so priority is:

```text
session .env > cwd .env > process environment
```

Transcription commands upload audio chunks to the configured OpenAI-compatible provider.
Follow the privacy rule in `SKILL.md` before starting transcription.

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
rajio /path/to/session --force-commit --continue=until-manual
rajio /path/to/session --reset transcript_raw
```

Workflow controls:

- `--continue until-manual|step`: default is `until-manual`. `until-manual` runs
  automatic stages until the next manual stage. `step` runs at most one automatic
  stage unless `--full` is also set.
- `--commit`: validate and commit the current manual stage, recording the current
  work file hash in `session.toml`, then continue according to `--continue`.
- `--force-commit`: commit the current manual stage after manually confirming that all
  remaining blocking errors are intentional subtitle QA exceptions. It records
  `force_committed = true` with the current work file hash. It does not bypass schema,
  empty text, missing `zh`, invalid timing, overlap, or duplicate ID errors.
- `--reset <stage>`: reset the selected stage and all downstream stages to
  `pending`, set `current_stage` to that stage, and continue. Valid stages are
  `audio`, `transcript_raw`, `transcript_work`, `translation_work`, and `export`.
  Reset changes `session.toml` state; it does not delete files.
- `--full`: run all remaining stages automatically. Manual stages use Codex by
  default. With `--agent=false`, transcript work is committed without Codex, but
  `translation_work` still waits because Chinese text must be produced manually or
  by an agent.
- `--agent codex|false`: batch automation control. `codex` runs the Codex agent for
  the current manual stage and commits it. `false` disables Codex in `--full` mode.
- `--verbose`: print every validation warning where the command supports verbose
  output instead of summarized warnings.

Force commit is an exception path, not a normal QA shortcut. Before using it, run:

```bash
rajio check /path/to/session --level error --verbose
```

Inspect every remaining error manually. Use `--force-commit` only when keeping the
exception makes the subtitle more accurate, natural, or comfortable, for example an
official title or event name such as `STRAIGHT! REACH!! CHEER!!!`. Do not use it for
unfinished translation, empty text, broken timing, overlaps, duplicate IDs, bad schema, or
large unreviewed batches of errors.

Reset boundaries:

- `--reset audio`: re-extract audio, recreate audio chunks, rerun transcription, and
  invalidate all downstream work.
- `--reset transcript_raw`: preserve audio metadata/chunks, clear raw transcript
  checkpoints, rerun ASR, and invalidate transcript work, translation work, and export.
- `--reset transcript_work`: preserve raw transcript and regenerate
  `transcript/work/segments.toml`.
- `--reset translation_work`: preserve clean committed transcript work and regenerate
  `translation/work/segments.toml`.
- `--reset export`: preserve clean committed translation work and regenerate outputs.
- If media changed and `--reset` is not `audio`, the command errors and asks for an
  audio-stage rerun first.
- If a committed manual work file changed, rajio marks it `dirty` and retargets the
  workflow to that manual stage before continuing.

Audio chunk options:

- `--chunk-target <seconds>`: target local audio chunk length. Default `600`;
  minimum `60`.
- `--chunk-boundary-search <seconds>`: seconds around the target cut point to search
  for silence. Default `90`; range `0..300`.
- `--chunk-silence-noise <db>`: ffmpeg `silencedetect` noise threshold. Default `-35`.
- `--chunk-silence-duration <seconds>`: ffmpeg `silencedetect` minimum silence
  duration. Default `0.4`; must be non-negative.

`--chunk-target + --chunk-boundary-search` must be at most `1350` seconds. Chunk
options are read during first audio generation and `--reset audio`, then recorded under
`stages.audio.chunking` in `session.toml`. `--reset transcript_raw` reuses existing
`stages.audio.chunks[]` and does not apply new chunk options.

## Segments Commands

Use these commands for stable targeted edits to manual work-stage `segments.toml` files.

```bash
rajio segments list /path/to/session --stage transcript
rajio segments edit /path/to/session <id> --stage transcript [fields]
rajio segments apply /path/to/session [file] --stage translation
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

- TTY without `--json`: human-readable table.
- Non-TTY without `--json`: CSV.
- `--json`: structured JSON.

Segment mutation commands print affected rows, except `segments apply`, which defaults to
operation counts. `--dry-run` validates and prints the result without writing
`segments.toml`.

### segments list

```bash
rajio segments list /path/to/session --stage transcript --json
rajio segments list /path/to/session --stage transcript --id 12
rajio segments list /path/to/session --stage transcript --id 12 --around 3
rajio segments list /path/to/session --stage transcript --offset 100 --limit 50
rajio segments list /path/to/session --stage transcript --start 600 --end 660
rajio segments list /path/to/session --stage translation --issues empty-zh --json
```

`segments list` accepts only one filter mode per invocation:

- `--id <id>`: list one segment.
- `--id <id> --around <count>`: list one segment plus that many neighboring segments
  on each side. `--around` must be a non-negative integer.
- `--offset <count> --limit <count>`: list a zero-based window. `--offset` and
  `--limit` must be non-negative integers. If `--limit` is omitted, list from offset
  to the end.
- `--start <seconds> --end <seconds>`: list segments whose `start` is in
  `[start, end)`. Both options are required together.
- `--issues <types>`: list segments matching comma-separated issue types:
  `invalid-time`, `overlap`, `long`, `fragment`, and `empty-zh`.

In JSON mode, list output includes:

- `segments`: rows with `id`, `start`, `end`, `speaker`, `ja`, and `zh`.
- `stats`: `total`, `listed`, `translated`, and `untranslated` counts.

### segments edit

```bash
rajio segments edit /path/to/session 12 --stage transcript \
  --start 10.2 --end 13.4 --speaker A --ja "修正した日本語"

rajio segments edit /path/to/session 12 --stage translation \
  --zh "修正后的中文字幕" --dry-run --json
```

Editable fields are `--start`, `--end`, `--speaker`, `--ja`, and `--zh`. At least one
field is required.

### segments split

```bash
rajio segments split /path/to/session 12 --stage transcript \
  --at 11.8 --gap 0.08 --id1 12.1 --id2 12.2 \
  --ja1 "前半の日本語" --ja2 "後半の日本語" \
  --speaker1 A --speaker2 B
```

`segments split` replaces one segment with exactly two segments separated by a subtitle
gap. Required options are `--at`, `--id1`, `--id2`, `--ja1`, and `--ja2`.

Rules:

- `--at` is the midpoint of the inserted gap.
- `--gap` is optional and defaults to `0.08`; values below `0.08` are rejected.
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

### segments apply

```bash
rajio segments apply /path/to/session patch.toml --stage translation --dry-run --json
rajio segments apply /path/to/session patch.toml --stage translation
rajio segments apply /path/to/session --stage translation <<'EOF'
[[edits]]
id = "12"
zh = "修正后的中文字幕"
EOF
```

`segments apply <target> [file]` applies a TOML patch as the batch form of edit, split, merge,
and delete operations. Pass a patch file path, or omit `[file]` only when supplying
TOML on stdin in the same shell command. It prints operation counts by default; add
`--verbose` to print affected segment rows.

Patch rules:

- A patch must contain at least one of `[[edits]]`, `[[splits]]`, `[[merges]]`, or
  `[[deletes]]`.
- `[[edits]]` requires `id` plus at least one changed field: `start`, `end`, `speaker`,
  `ja`, or `zh`.
- `[[splits]]` replaces one source segment with two or more `[[splits.segments]]`.
  `gap` is optional and defaults to `0.08`; values below `0.08` are rejected.
  Replacement segments use virtual continuous timing: they must cover the original
  segment continuously with no gaps or overlaps, start at the original `start`, and end
  at the original `end`. Each internal boundary is treated as the midpoint of the
  inserted gap, so a boundary at `13.2` with `gap = 0.08` becomes previous
  `end = 13.16` and next `start = 13.24`.
- Every generated split segment must remain at least `0.5` seconds long after gap
  insertion.
- If a split source has `zh`, every replacement segment must include `zh`.
- `[[merges]]` accepts two or more adjacent source ids in `ids`; `id` and `ja` are
  required. If any source has `zh`, merged `zh` is required.
- `[[deletes]]` requires only `id`.
- Final segment ids must be unique.

Patch example:

```toml
[[edits]]
id = "12"
zh = "修正后的中文字幕"

[[splits]]
id = "long"
gap = 0.08

[[splits.segments]]
id = "long.1"
start = 10.0
end = 13.2
speaker = "A"
ja = "前半の日本語"
zh = "前半中文字幕"

[[splits.segments]]
id = "long.2"
start = 13.2
end = 16.0
speaker = "A"
ja = "後半の日本語"
zh = "后半中文字幕"

[[merges]]
ids = ["13.1", "13.2"]
id = "13"
speaker = "A,B"
ja = "結合した日本語"
zh = "合并后的中文字幕"

[[deletes]]
id = "14"
```

For large or risky batches, keep the patch under a session-local `patches/` directory,
run with `--dry-run --json`, then apply the same file without `--dry-run`.

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
- creates `clips/<clip-id>/chunks/chunk-*.m4a`
- uploads chunks to ASR
- writes successful chunk checkpoints to `chunks/chunk-*.toml`
- writes failed chunk logs to `chunks/chunk-*.error.log`
- writes absolute source-video transcript times to `clips/<clip-id>/segments.toml`
- resumes by skipping successful chunk checkpoints and retrying failed or missing chunks

It supports the same chunk options as the default command and records the resolved
options in `clip.toml`.

Clip directory shape:

```text
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

If the same start/end/label/chunking combination already has a clip directory, the
command resumes that clip. Otherwise it creates a new id; if the base id is already used
by a different clip, a numeric suffix is added.

### clips list

```bash
rajio clips list /path/to/session
rajio clips list /path/to/session --json
```

Output columns are `id`, `label`, `start`, `end`, `duration`, `status`, and `segments`.
Status values:

- `done`: `segments.toml` exists and parses.
- `failed`: no parseable `segments.toml`, and at least one chunk error log exists.
- `partial`: no parseable `segments.toml`, no error log, and at least one checkpoint exists.
- `missing`: no parseable `segments.toml` and no usable checkpoint state.

### clips show

```bash
rajio clips show /path/to/session clip-120000-180000
rajio clips show /path/to/session clip-120000-180000 --json
```

`clips show <target> <id>` prints only that clip's `segments.toml` rows using the same segment
columns and output modes as `segments list`. It does not print `clip.toml` metadata.

## Check

```bash
rajio check /path/to/session
rajio check /path/to/session --level error
rajio check /path/to/session --level warning
rajio check /path/to/session --stage transcript
rajio check /path/to/session --stage translation --json
rajio check /path/to/session --verbose
```

`rajio check` validates `session.toml` and `segments.toml` files under `transcript/`
and `translation/`. The target is required.

Filters:

- `--level all|error|warning`: default is `all`.
- `--stage audio|transcript|transcript_raw|transcript_work|translation|translation_work|export`.
  `transcript` means both `transcript_raw` and `transcript_work`; `translation` means
  `translation_work`.

Output:

- Default human output groups repeated issues by severity, code, file, and stage, with
  up to five examples per group.
- `--verbose` prints every issue.
- `--json` prints summary JSON.
- `--verbose --json` adds sorted full `issues`.

Exit behavior:

- If any filtered issue is an error, process exit code is `1`.
- If no filtered error remains, the command exits successfully, even if unfiltered errors
  existed outside the selected stage/level.

## Doctor

```bash
rajio doctor /path/to/session
```

`rajio doctor` checks session runtime readiness: `.env` loading, API key presence,
OpenAI-compatible provider reachability, ffmpeg, ffprobe, Codex availability where
relevant, and Node.js version expectations. The target is required. If any check fails,
process exit code is `1`.

Run `doctor` before automatic transcription/export stages or when provider, ffmpeg, or
environment setup looks misconfigured.

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
