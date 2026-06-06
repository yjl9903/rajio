---
name: rajio
description: Use only when explicitly asked to operate a rajio Japanese video transcription and Chinese subtitle session.
---

# rajio

Use this skill to operate a `rajio` subtitle session for Japanese audio/video:
prepare context, extract audio, transcribe Japanese, proofread the transcript, translate
and polish Simplified Chinese subtitles, and export SRT/ASS files.

Do not use this skill unless the user explicitly asks for the rajio skill or asks you to
operate a rajio subtitle session.

## Non-Negotiable Rules

- Make the privacy boundary explicit before transcription: rajio uploads audio to the
  configured OpenAI-compatible transcription provider. Start transcription only after the
  user authorizes that upload.
- `transcript_work` and `translation_work` are manual stages. For an ordinary single-video
  session, perform proofread, polish, translation, validation, and commit work in the
  current agent session, but split long videos into explicit manual batches instead of
  trying to process hundreds of segments in one pass.
- Do not use `--agent=codex` for ordinary single-video transcript polish or translation.
  Use it only when the user explicitly asks for batch or fully automatic multi-session
  automation.
- During `translation_work`, do not call the OpenAI-compatible provider configured in
  `.env` to translate. Translate in the current agent session so context, glossary, and
  style decisions remain continuous.
- Never edit `transcript/raw/segments.toml` or `transcript/raw/chunks/*.toml`. Raw
  transcript files are references. Edit only `transcript/work/segments.toml`,
  `translation/work/segments.toml`, and `description.md`.
- `description.md` is the source of truth for media metadata, user notes, context,
  glossary, fixed terms, style requirements, and unresolved uncertainty. Keep it current
  throughout the session.
- Use `rajio check` as documented in the CLI section. It is not a substitute for manual
  QA of typos, ASR errors, proper nouns, context, terminology, fixed phrases, and
  translation consistency.
- Use `rajio segments` commands for stable targeted edits to work-stage `segments.toml`:
  list/filter segments, edit fields, split/merge subtitle units, and delete semantically
  empty filler segments. Always pass `--session /path/to/session` in agent work.

## Required Input

- Local audio/video path. Refuse to start without this.
- Optional but preferred: title, original URL, publish date, uploader/channel, synopsis,
  cast, program/corner names, user notes, fixed terminology, and translation style
  requirements.

If optional metadata is missing, proceed with filename-based defaults, record the
uncertainty in `description.md`, and revisit it when transcript context reveals more.

## CLI

First check whether `rajio` is available:

```bash
command -v rajio
```

If it is not installed, run commands through `npx rajio ...`.

Use the installed CLI:

```bash
rajio <target> [options]
rajio segments <command> --session <target> --stage transcript
rajio check <target>
rajio check <target> --level error
rajio check <target> --stage transcript
rajio check <target> --stage translation --json
rajio doctor <target>
```

Segment editing commands:

```bash
rajio segments list --session /path/to/session --stage transcript
rajio segments list --session /path/to/session --stage transcript --json
rajio segments list --session /path/to/session --stage transcript --id 12 --id 13 --id 14
rajio segments list --session /path/to/session --stage transcript --id 12 --around 3
rajio segments list --session /path/to/session --stage transcript --offset 100 --limit 50
rajio segments list --session /path/to/session --stage transcript --start 600 --end 660
rajio segments list --session /path/to/session --stage transcript --issues invalid-time,overlap,long,fragment
rajio segments list --session /path/to/session --stage translation --issues empty-zh --json
rajio segments edit 12 --session /path/to/session --stage transcript --start 10.2 --end 13.4 --speaker A --ja "修正した日本語"
rajio segments edit 12 --session /path/to/session --stage transcript --ja "修正した日本語" --dry-run --json
rajio segments apply patch.toml --session /path/to/session --stage translation
rajio segments apply --session /path/to/session --stage translation <<'EOF'
[[edits]]
id = "12"
zh = "修正后的中文字幕"
EOF
rajio segments split 12 --session /path/to/session --stage transcript --at 11.8 --id1 12.1 --id2 12.2 --ja1 "前半の日本語" --ja2 "後半の日本語" --speaker1 A --speaker2 B
rajio segments merge 12.1 12.2 --session /path/to/session --stage transcript --id 12 --ja "結合した日本語" --speaker A,B
rajio segments delete 13 --session /path/to/session --stage transcript
```

Always pass `--session /path/to/session` in agent work, even though the CLI can infer a
session from cwd. This avoids editing the wrong session after directory changes. Replace
`--stage transcript` with `--stage translation` when working on
`translation/work/segments.toml`.

`segments list` accepts one filter mode at a time:

- `--id [...id]`: show one or more specific segment ids.
- `--id <id> --around <count>`: show one segment plus surrounding context; this requires
  exactly one `--id`.
- `--offset <count> --limit <count>`: show a zero-based segment window; omit `--limit`
  to read from offset to the end.
- `--start <time> --end <time>`: show segments whose `start` time is in `[start, end)`.
- `--issues <types>`: show segments matching comma-separated issue types:
  `invalid-time`, `overlap`, `long`, `fragment`, and `empty-zh`. Use
  `--issues empty-zh --json` to list untranslated segments and read JSON `stats` for
  total, listed, translated, and untranslated counts.

`segments apply [file]` applies a TOML patch as the batch form of `edit`, `split`,
`merge`, and `delete`. Pass a file path to read from disk, or omit `[file]` to read the
patch from stdin. Use `--dry-run` to validate without writing `segments.toml`.
The mutating `edit`, `apply`, `split`, `merge`, and `delete` commands all support
`--dry-run`; dry-run commands still print the affected segment rows.
These commands do not run full subtitle validation; run `rajio check` separately when you
need validation feedback.

When omitting `[file]`, provide stdin in the same shell command, for example with
`<<'EOF' ... EOF`. In non-interactive shells, a bare `segments apply` may read empty
stdin and fail. For larger or riskier batches, prefer writing a temporary patch file,
running `rajio segments apply patch.toml --session ... --stage ... --dry-run`, then
applying the same file without `--dry-run`.

All `rajio segments` commands print the affected segment rows. Non-JSON output is a
human-readable table; agents should use `--json` for parsing so stdout stays valid JSON
and `start`/`end` remain numeric seconds.

`rajio check` defaults to concise human output grouped by severity, issue code, file, and
stage. Each group includes a few examples with segment id, time range, duration, text
length, adjacent segment ids, and a short text summary. Use these modes deliberately:

- `rajio check /path/to/session --level error`: show only blocking errors.
- `rajio check /path/to/session --stage transcript`: focus on transcript raw/work issues.
- `rajio check /path/to/session --stage translation`: focus on translation work issues.
- `rajio check /path/to/session --verbose`: print every issue when you need the full list.
- `rajio check /path/to/session --json`: output structured `ok`, `counts`, `summary`, and
  `issues` for agents, scripts, or UI. Prefer `--json` over parsing human output.

```toml
[[edits]]
id = "12"
zh = "修正后的中文字幕"

[[splits]]
id = "long"

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

Useful options:

- `--continue=until-manual`: run automatic stages until the next manual stage.
- `--continue=step`: run one automatic stage.
- `--commit`: commit the current manual stage after validating its work file.
- `--media <path>`: invocation-only media override.
- `--force`: rerun or overwrite current-stage artifacts.
- `--agent=codex`: batch-only automation escape hatch. Do not use for ordinary manual
  single-video stages.

Environment read by rajio:

- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`
- `RAJIO_FFMPEG_BIN`
- `RAJIO_FFPROBE_BIN`

rajio loads `.env` from the command working directory, then from the session directory.
Session `.env` takes priority over cwd `.env`, which takes priority over the process
environment.

## Workflow

### 0. Prepare The Session

1. Resolve the media path to an absolute path and confirm it exists.
2. Choose the session directory. If the user provides one, use it. Otherwise create one
   near the media file or in the current workspace using a filesystem-safe title or media
   stem. Do not copy large media files unless the user asks.
3. Create or update `description.md`.
4. Gather confirmed context before transcription when practical. Use the original URL,
   official pages, video title, filenames, on-screen text, user notes, and later transcript
   discoveries. Record uncertainty explicitly instead of guessing.

Use this `description.md` shape:

```markdown
---
media: ./video.mp4
title: Video title or filename stem
url: https://example.com/original
published_at: 2026-06-06
---

## Context

- Source/uploader:
- User notes:
- Video synopsis:
- Cast/speakers:
- Program/corner structure:
- Known fixed greetings or sign-offs:
- Related events/products/works mentioned:

## Glossary And Fixed Terms

- Japanese term/person/place -> Chinese translation or note
- Common ASR confusion -> Correct Japanese term / Chinese translation

## Style Requirements

- Translate into natural Simplified Chinese subtitles.
- Preserve important names and terminology consistently.
```

Before automatic stages, run:

```bash
rajio doctor /path/to/session
```

Do not start transcription until `doctor` passes or the environment issue is resolved.

### 1. Run To Transcript Work

Run:

```bash
rajio /path/to/session --continue=until-manual
```

Expected result: rajio creates or reads `session.toml`, extracts audio, transcribes
Japanese, writes raw transcript artifacts, creates `transcript/work/segments.toml`, and
stops at `transcript_work`.

If transcription is chunked, wait for chunk success or error logs. Do not restart while
requests may still be in flight unless there is a clear CLI/provider failure.

Treat automatically created work segments as a draft. Review text, speaker boundaries,
timing, and chunk boundaries during transcript proofread.

### 2. Proofread And Polish Japanese

Edit `transcript/work/segments.toml` with the structured segment tools when possible.
Do not translate in this stage.

Use the segment commands documented in the CLI section with `--stage transcript`.

Validate often with `rajio check` as documented in the CLI section. This only checks data
shape, timing, required fields, and subtitle limits; before committing, still polish the
content semantically against the acceptance criteria below.

Acceptance criteria:

- Every segment has stable `id`, numeric `start`/`end`, non-empty `speaker`, and non-empty
  Japanese `ja`.
- Timestamps increase and do not overlap.
- Japanese text is coherent, natural, and corrected against `description.md`, glossary,
  proper nouns, and raw transcript references.
- Known names, program titles, corner names, event names, hashtags, greetings, mail reads,
  and sign-offs are corrected consistently.
- Search the whole transcript for likely ASR variants of fixed terms, not only exact
  glossary terms.
- Check high-risk positions explicitly: opening title call, self-introductions, listener
  greetings, corner starts, event announcements, mail-address reads, and ending sign-off.
- Keep each Japanese subtitle line under 28 visible characters when practical; 40 visible
  characters is the hard limit.
- Prefer one-line `ja`, but allow at most one `\n` in `ja` when a genuinely long sentence
  cannot be split naturally without creating a bad subtitle cut. Hard limits apply per line.
- Avoid comma punctuation in Japanese subtitle text. Replace an essential pause comma with
  a space, or split the segment.
- Do not end Japanese subtitle lines with sentence punctuation such as `。`, `？`, `！`, or
  commas.

Speaker and segment structure:

- A normal segment should represent one readable subtitle unit.
- Do not preserve unreadable fragments such as single characters or syllables when adjacent
  fragments form one jointly spoken phrase.
- If multiple speakers complete the same short phrase together, merge it into one segment
  with complete `ja`; combine speakers with comma-separated values such as
  `speaker = "A,B"` when attribution matters.
- Preserve segment IDs unless a structural correction truly requires a change.

Before committing:

- Update `description.md` with newly confirmed context and terminology.
- Search for known ASR confusions and wrong proper nouns.
- Spot-check opening, middle, and ending subtitles for proper nouns and fixed phrases.
- Confirm no remaining segment is an unreadable fragment that should be merged.

When clean:

```bash
rajio /path/to/session --commit --continue=until-manual
```

Expected result: rajio commits `transcript_work`, creates
`translation/work/segments.toml`, and stops at `translation_work`.

### 3. Translate And Polish Chinese

Edit `translation/work/segments.toml` with the structured segment tools when possible,
and fill or refine `zh` for every segment.

For long videos, translate and polish in explicit batches instead of attempting the whole
file in one pass. A practical batch is usually 50-100 segments or 5-10 minutes of media,
adjusted by density. Use the segment editing commands documented in the CLI section with
`--stage translation`; in translation work, patch or command updates may set `zh`, `zh1`,
and `zh2` where the command supports those fields.

During batch work, keep glossary updates and unresolved uncertainty in `description.md`,
and search earlier completed batches when a new name, phrase, or style decision appears.
Do not commit `translation_work` until every batch has been translated, terminology has
been cross-checked, and `rajio check /path/to/session` passes.

If translation reveals a transcript typo, wrong name, wrong fixed phrase, missing context,
or bad segment structure, fix `transcript/work/segments.toml` first, update
`description.md`, recommit the transcript, then reconcile the translation.

Validate often with `rajio check` as documented in the CLI section. This only checks data
shape, timing, required fields, and subtitle limits; before committing, still polish the
content semantically against the acceptance criteria below.

Acceptance criteria:

- Keep `id`, `start`, `end`, `speaker`, and `ja` aligned with the committed transcript
  unless a transcript fix is required or an intentionally removed subtitle segment is a
  very short, semantically empty filler.
- Every segment has non-empty `zh`.
- Chinese is natural Simplified Chinese subtitle language, not word-by-word literal output.
- Preserve meaning, tone, speaker intent, jokes, references, and discourse flow.
- Very short segments that are only meaningless fillers, breaths, interjections, or pure
  hesitation sounds may be deleted from the subtitle if removing them does not change
  meaning, speaker intent, or timing comprehension.
- Smooth spoken hesitation, false starts, and harmless repetition in Chinese unless they are
  semantically important, characterize the speaker, or affect the scene's rhythm.
- Keep Chinese renderings globally consistent for people, programs, corners, events,
  hashtags, works, products, honorific decisions, and recurring phrases.
- Use `description.md` as the glossary and style source. Update it if new confirmed terms
  are discovered.
- Translate merged multi-speaker phrases as one complete subtitle. Do not preserve
  syllable-by-syllable fragments in Chinese.
- Keep each Chinese subtitle line under 24 visible characters when practical. This is a
  soft limit, not a mandatory split rule.
- Do not create an awkward short trailing subtitle only to satisfy a soft length limit.
  Preserve subtitle continuity and readability first.
- 34 visible characters per Chinese subtitle line is the hard limit. If a genuinely long
  sentence cannot be shortened naturally, allow at most one `\n` in `ja` and at most one
  `\n` in `zh` instead of forcing a bad segment split. Hard limits apply per line.
- Avoid comma punctuation in Chinese subtitle text. Replace an essential pause comma with a
  space, or split the segment.
- Do not end Chinese subtitle lines with sentence punctuation such as `。`, `？`, `！`, or
  commas.

Before committing:

- Compare `description.md` glossary against `translation/work/segments.toml`.
- Search for inconsistent Chinese names, untranslated Japanese names, wrong titles, and
  stale translations from earlier draft assumptions.
- Spot-check opening, middle, ending, fixed greetings, mail reads, event announcements,
  and sign-off for Japanese correctness and Chinese readability.
- Check subtitle continuity across adjacent segments: the Chinese should read as connected
  dialogue, not isolated literal fragments.
- Record unresolved uncertainty in `description.md` or mention it in the final report.

When clean, commit and export:

```bash
rajio /path/to/session --commit --continue=until-manual
```

Expected output:

- `output/*.ja.srt`
- `output/*.zh.srt`
- `output/*.ja-zh.ass`

### 4. Final Verification

Before reporting completion:

1. Run `rajio check` as documented in the CLI section.
2. Treat the result as data validation only.
3. Confirm `session.toml` is not stuck in `failed`, `dirty`, or an unexpected manual stage.
4. Confirm expected output files exist under `output/`.
5. Perform manual content QA:
   - proper nouns and fixed terms
   - opening title call and speaker introductions
   - middle section timing and speaker continuity
   - event/work/corner names
   - ending sign-off
   - Chinese readability, subtitle continuity, and terminology consistency
6. Search final work files for known ASR-confusion variants and glossary terms one last
   time.
7. Report output files, remaining warnings, assumptions, content-QA limits, and any spots
   needing user judgment.

## Failure Handling

- If `rajio check` reports schema, duplicate ID, empty text, invalid time, or overlap
  errors, fix the relevant work file before committing.
- If a committed manual stage becomes `dirty`, inspect the changed work and rerun
  `--commit` only after it passes manual review and validation.
- If transcription fails, inspect `transcript/raw/chunks/*.error.log`, check credentials,
  provider access, media path, ffmpeg, and ffprobe, then retry. Completed chunk checkpoints
  are reused unless `--force` is used.
- If translation reveals a transcript problem, fix and recommit `transcript_work`, then
  regenerate or reconcile `translation/work/segments.toml`.
