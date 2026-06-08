# rajio v1 complete design and implementation plan

## Summary

Implement a resumable `rajio <target>` CLI for Japanese audio/video subtitle work:
AI transcription, Japanese transcript proofread and polish, Chinese translation,
translation proofread and polish, and subtitle export. Work is organized as a session
directory. Execution state lives in
`session.toml`; artifacts live directly under the session directory so transcript and
translation work can be committed to the repository. Final output is `SRT + ASS`.

Core rule: descriptive metadata belongs in `description.md`; execution state belongs in
`session.toml`. The selected media path is recorded in `session.toml` as stable session
input, while title, URL, publish date, and human/agent context remain in `description.md`.

## CLI

Default command:

```bash
rajio <target> [options]
```

Segment editing commands:

```bash
rajio segments <command> --session <target> --stage transcript
rajio segments <command> --session <target> --stage translation
```

Check command:

```bash
rajio check [target]
```

`check` validates `session.toml` and every `segments.toml` under `transcript/` and
`translation/`. It is intended for humans and Codex agents to verify file shape, session
references, and editable work before committing a manual stage. Raw ASR output under
`transcript/raw/segments.toml` is checked for parse/schema validity but not strict subtitle
quality or timeline cleanup, because those issues are expected to be fixed in
`transcript/work/segments.toml`.

`<target>` supports:

- Description markdown: use the markdown file's parent directory as the session.
- Session directory: read existing `session.toml`, or initialize from the directory's
  single markdown description or single media file.
- Media file: use the media file's parent directory as the session.

Options:

- `--media <path>`: override the media path for this invocation. For a new session, the
  selected media path is saved in `session.toml`; for an existing session, the saved media
  path is reused unless `--media` is supplied.
- `--continue=until-manual|step`: controls automatic progression; default is
  `until-manual`.
- `--commit`: commit the current manual stage.
- `--agent=codex|false`: currently only `codex` is supported. If `--commit` and
  `--agent=codex` are both present, run agent flow.
- `--full`: run all remaining stages automatically. Manual stages use Codex by default.
  With `--agent=false`, transcript proofread and polish can be skipped, but translation
  still stops at `translation_work` because Chinese text must be produced by a human or
  Codex agent.
- `--reset <stage>`: regenerate from a stage. Valid stages are `audio`,
  `transcript_raw`, `transcript_work`, `translation_work`, and `export`.

`rajio check` defaults to concise human output and summarizes repeated issues by file,
stage, severity, and code. Use `rajio check --verbose [target]` to print every issue.
Use `rajio check --json [target]` for compact summary JSON; full issue details
are emitted only with `rajio check --verbose --json [target]`. `--level` and `--stage`
apply consistently to human and JSON output before summaries, details, and exit codes are
computed.

ASR chunking target:

- The audio stage must split when the extracted audio is either too large for the
  transcription upload limit or too long for `gpt-4o-transcribe-diarize`.
- Use 24 MB as the local safety threshold for the documented 25 MB upload limit.
- Use 1350 seconds as the local safety threshold for the observed 1400 second
  `gpt-4o-transcribe-diarize` per-request duration limit.
- When splitting, target 600 second chunks by default. Before cutting at the target
  timestamp, search nearby `ffmpeg silencedetect` intervals and cut at the midpoint of
  the closest silence. This is a best-effort sentence-boundary proxy: it reduces the
  chance of cutting through speech, but cannot guarantee grammatical sentence boundaries.
- If no usable silence exists near the target point, fall back to a fixed time boundary so
  every upload remains under the ASR duration limit.

Environment variables:

- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`
- `RAJIO_FFMPEG_BIN`
- `RAJIO_FFPROBE_BIN`

The CLI loads `.env` once from the command working directory, then once from the
resolved session directory. Later files override earlier values, so priority is:
session `.env` > cwd `.env` > original process environment.

## Description Markdown

Frontmatter v1:

```yaml
media: ./video.mp4
title: Example title
url: https://example.com/video
published_at: 2026-06-05
```

Markdown body is free-form context for humans and agents: video description,
glossaries, names, fixed translations, reference paths, proofread/polish requirements,
and notes.
The CLI does not create dedicated fields for that body content.

`description.md` is the source of truth for title, original URL, publish date, and
human/agent context. Its `media` frontmatter is used when selecting the media path for a new
session.

`session.toml` records the selected media path in `[input].media` so directory targets keep
using the same media even if other media files are later added to the session directory. To
persistently change an existing session's media, run with `--media <path>` and regenerate from
`audio` as needed.

## Session Layout

```text
session/
  description.md
  session.toml
  audio/
    metadata.json
    extracted.m4a
    chunks/
  transcript/
    raw/
      segments.toml
      chunks/
        chunk-000.toml
        chunk-000.error.log
    work/
      segments.toml
      agent-output.jsonl
  translation/
    work/
      segments.toml
      agent-output.jsonl
  output/
    *.ja.srt
    *.zh.srt
    *.ja-zh.ass
```

- Do not use a `.rajio/` wrapper. `audio/`, `transcript/`, `translation/`, and
  `output/` are first-level session directories.
- `transcript/raw` is automatic output and should not be edited manually.
- `transcript/raw/chunks/*.toml` stores raw per-chunk ASR responses and chunk metadata.
  These files are resumable checkpoints: a retry skips existing successful chunk files
  after a failed transcription. Use `--reset transcript_raw` to start a full new
  transcription round.
- `transcript/raw/chunks/*.error.log` stores the timestamp and error text for failed chunk
  requests. Failed chunks do not produce checkpoint TOML and are retried on the next run.
- `work` is editable by humans or Codex agent and can be committed with the session.
- Commit does not copy to `final`; `session.toml` records the hash of the corresponding
  `work/segments.toml`.
- If `work/segments.toml` changes after commit, the stage becomes dirty. Downstream
  stages must refuse to read it until it is committed again.
- Codex prompts are not persisted. `agent-output.jsonl` stores Codex SDK streamed events
  and is rotated before rerunning an agent.
- `session.toml` does not record agent execution details. How proofread/polish work was
  performed is not workflow state.
- Do not keep request-level OpenAI records: no request IDs, request paths, or per-request
  metadata. Transcription keeps only normalized `segments.toml`, even if the
  implementation internally uses multiple requests.

### `session.toml`

`session.toml` is the only source of truth for execution state. It stores only session
identity, current stage, statuses, artifact paths, and hashes. It does not store
descriptive metadata, runtime config, prompts, `OPENAI_API_KEY`, OpenAI request metadata,
or agent execution fields.

```toml
schema_version = 1
session_id = "20260605-rajio-example"
created_at = "2026-06-05T12:00:00+08:00"
updated_at = "2026-06-05T12:30:00+08:00"
current_stage = "transcript_work"

[input]
description = "description.md"
media = "video.mp4"
media_sha256 = "..."
```

Notes:

- `description` only records the markdown path for context restoration. It does not copy
  frontmatter fields.
- `media` records the selected media path relative to the session directory. Directory
  targets restore this path before falling back to description frontmatter or single-media
  discovery.
- `media_sha256` records the actual processed media hash for replacement detection.
  The hash is compared against the restored media path, or the current `--media` override
  when supplied.
- If a session has no description markdown, `description` is omitted.

Fixed stages:

- `audio`
- `transcript_raw`
- `transcript_work`
- `translation_work`
- `export`

Stage statuses:

- `pending`: not started.
- `running`: started but not completed; treated as interrupted on CLI startup.
- `done`: automatic stage completed.
- `waiting`: manual stage is waiting for edit or agent.
- `committed`: manual stage is committed and hash is valid.
- `dirty`: manual stage changed after commit.
- `failed`: stage failed; `error` has a short summary.

Stage field example:

```toml
[stages.audio]
status = "done"
metadata = "audio/metadata.json"
audio = "audio/extracted.m4a"
chunks_dir = "audio/chunks"
chunk_count = 1
media_sha256 = "..."

[stages.transcript_raw]
status = "done"
input_audio = "audio/extracted.m4a"
segments = "transcript/raw/segments.toml"
segments_sha256 = "..."

[stages.transcript_work]
status = "committed"
source_segments = "transcript/raw/segments.toml"
segments = "transcript/work/segments.toml"
segments_sha256 = "..."
committed_at = "2026-06-05T12:20:00+08:00"

[stages.translation_work]
status = "waiting"
source_segments = "transcript/work/segments.toml"
segments = "translation/work/segments.toml"

[stages.export]
status = "pending"
ja_srt = "output/example.ja.srt"
zh_srt = "output/example.zh.srt"
bilingual_ass = "output/example.ja-zh.ass"
```

Rules:

- Prefer paths relative to the session directory.
- On startup, recompute hashes for committed manual stages. If a hash differs, mark the
  stage dirty.
- Before reading upstream work, downstream stages must confirm the upstream stage is
  committed and hash-valid.
- Automatic stages write artifact paths and hashes, set status to `done`, and advance
  `current_stage`.
- Manual stage setup copies source segments to work without automatic subtitle cutting, sets
  status to `waiting`, and stops. Transcript work starts from the raw transcript so human or
  agent edits can decide semantic split points, timing, and gaps together.
- `--commit` validates work, writes `segments_sha256` and `committed_at`, sets status to
  `committed`, and advances.
- `--agent=codex` runs Codex, writes JSONL output, then commits. On failure, the stage is
  `failed` and does not advance.

## Workflow

1. Initialize session: resolve target, description markdown, media path, and environment.
   Create or restore `session.toml`.
2. Audio: use `ffprobe/ffmpeg` to read metadata, extract audio, and split when needed.
   Splitting is based on both upload size and ASR request duration. Prefer silence-adjacent
   cut points so the ASR model does not lose context by starting or ending a chunk in the
   middle of speech.
3. Transcription: before calling the external transcription API, print the provider,
   model, upload object path, time range, and size for every chunk. Then run chunk
   requests through a concurrency-limited queue with concurrency 5. Each chunk logs start,
   completion, and failure; successful raw responses are written to
   `transcript/raw/chunks/chunk-000.toml` style checkpoint files. After all chunks are
   available, read those raw responses, normalize and offset non-empty text segments during
   merge, write `transcript/raw/segments.toml`, and initialize
   `transcript/work/segments.toml` as a direct copy for manual proofread and subtitle timing
   edits.
4. Transcript proofread and polish: human or Codex edits
   `transcript/work/segments.toml`; `--commit` validates it and records hash.
5. Translation: create `translation/work/segments.toml` from committed and clean
   transcript work, then stop for human or Codex to fill `zh`.
6. Translation commit: human or Codex edits `translation/work/segments.toml`; `--commit`
   validates it, requires `zh`, and records hash.
7. Export: read committed and clean translation work and generate Japanese SRT, Chinese
   SRT, and bilingual ASS.

## Data And Validation

`segments.toml` is the only subtitle source:

- Top level: `version`, `source`, `segments`.
- Source: `kind`, `generated_at`. Media paths are session input and stay in `session.toml`, not
  `segments.toml`.
- Segment: `id`, `start`, `end`, `speaker`, `ja`, `zh?`, `notes?`, `flags?`.
- Time unit is seconds.

Blocking validation for editable/manual subtitle files:

- Invalid TOML shape or segment schema.
- Invalid time values or adjacent overlaps.
- Required text is empty.
- Translation stage misses `zh`.
- Japanese subtitle line exceeds 20 visible non-space characters.
- Chinese subtitle line exceeds 24 visible non-space characters.
- Japanese or Chinese subtitle text contains three or more lines.
- Segment duration is shorter than 0.5 seconds or longer than 10 seconds.
- Japanese reading speed exceeds 6 visible non-space characters per second.
- Chinese reading speed exceeds 12 visible non-space characters per second.
- Gap from the previous subtitle is shorter than 80 ms.
- Japanese or Chinese subtitle line contains only punctuation.
- Japanese or Chinese subtitle text contains more than two repeated question/exclamation marks.
- Upstream work is dirty.

Warning validation:

- Japanese subtitle line exceeds 13 visible non-space characters.
- Chinese subtitle line exceeds 16 visible non-space characters.
- Japanese or Chinese subtitle text contains two lines; prefer one line or split segments.
- Segment duration is shorter than 0.8 seconds or longer than 7 seconds.
- Japanese reading speed exceeds 4 visible non-space characters per second.
- Chinese reading speed exceeds 9 visible non-space characters per second.
- Gap from the previous subtitle is 80-250 ms.
- Japanese or Chinese subtitle text uses ordinary comma or period punctuation; prefer a
  space, rewrite, or split.
- Japanese or Chinese subtitle line ends with ordinary sentence punctuation.
- Japanese or Chinese subtitle text contains two repeated question/exclamation marks.
- Segment may mix speakers or have unnatural splitting.

Raw transcript files are parsed and schema-checked, but strict timing, text, line-length, and
translation completeness rules are deferred to editable work files.

## Implementation Notes

- Keep the existing `breadc` CLI architecture.
- Session management is encapsulated by a `Session` class under `src/session/`.
  It owns target resolution, session directory paths, media/description resolution,
  `session.toml` load/save, dirty detection, relative path conversion, description
  restoration, and artifact directory helpers. It does not execute workflow steps.
  File names use lowercase, e.g. `src/session/session.ts`.
- Session-specific support code also lives under `src/session/`, including description
  markdown parsing and `rajio check` validation.
- Workflow code lives under `src/workflow/`.
  - `index.ts` orchestrates stage progression and CLI option semantics.
  - `stages/audio.ts`, `stages/transcription.ts`, `stages/manual.ts`, and
    `stages/export.ts` own stage-specific behavior.
  - Shared stage helpers, such as ordering and manual-stage path naming, live in
    `stages.ts`.
  - `transcription.ts` owns the OpenAI-compatible transcription call and response-shape
    normalization because both are coupled to the transcription API surface.
  - Codex agent invocation remains shared outside individual steps and is called from
    the manual stage implementation.
- Subtitle segment parsing, writing, validation, translation cloning, and segment editing
  helpers live under `src/segments/`.
- `src/index.ts` is only a reserved package entry and currently exports `Session`.
- Generic helpers live under `src/utils/`, currently filesystem/path helpers and
  environment-derived runtime configuration.
- Dependencies:
  - `gray-matter`: parse markdown frontmatter.
  - `smol-toml`: read and write `session.toml`.
  - `zod`: validate session and segments schemas.
- Codex agent invocation:
  - Use `@openai/codex-sdk` to start a Codex thread with `workingDirectory`,
    `workspace-write` sandbox, `never` approval policy, and `skipGitRepoCheck`.
  - Generate the prompt in memory and pass it to the SDK.
  - Write streamed SDK events to the current stage's `work/agent-output.jsonl`.

## Implementation Steps

1. Create this `docs/plan/001-rajio-v1.md` document.
2. Implement `Session`, description, env, path/hash, session TOML, and segments modules.
3. Implement the `breadc` default command and option flow.
4. Implement `audio`, `transcript_raw`, `transcript_work`, `translation_work`, and
   `export` stages.
5. Implement Codex agent invocation and `agent-output.jsonl` rotation.
6. Add unit tests and mock integration tests.
7. Validate manually with the prepared test video:
   `.rajio/夏さく咲く49/春日さくらと乾夏寧の夏もさくらを咲かせたい 第49回【本放送版】.mp4`

## Tests

- Target parsing: markdown, directory, media file, ambiguous multiple markdown/media files.
- CLI option combinations: `--continue`, `--commit`, `--agent`, `--full`, `--reset`.
- Environment variable reading and priority.
- `session.toml` creation, restore, stage advancement, dirty hash detection.
- `segments.toml` schema and timeline validation.
- Mocked OpenAI, ffmpeg, ffprobe, and Codex SDK workflow.
- SRT and ASS export snapshot tests.
