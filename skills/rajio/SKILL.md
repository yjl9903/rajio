---
name: rajio
description: Use only when explicitly asked to use rajio for Japanese audio/video subtitle translation.
---

# Rajio

Use this skill to translate Japanese audio/video into polished, carefully proofread
subtitles with `rajio`: prepare context, extract audio, transcribe Japanese, proofread
the transcript, run multi-round Simplified Chinese translation and review, polish the
final subtitle text, and export SRT/ASS files.

Do not use this skill unless the user explicitly asks for the rajio skill or asks you to
create polished Chinese subtitles from Japanese audio/video with rajio.

## Non-Negotiable Rules

- The highest priority is accurate, natural, comfortable subtitles. Do not mechanically
  satisfy formatting heuristics when doing so would make the transcript or translation less
  correct, less readable, or less pleasant to watch.
- Make the privacy boundary explicit before transcription: rajio uploads audio to the
  configured OpenAI-compatible transcription provider. Start transcription only after the
  user authorizes that upload.
- `transcript_work` and `translation_work` are manual stages. Always process these stages
  through sub-agent batches. The main agent orchestrates, merges, validates, and commits;
  it must not try to proofread or translate the full first-draft stage by itself.
- The final Chinese refinement pass is the explicit exception to that boundary: after
  sub-agent translation batches have produced and committed the first draft, the main
  agent must perform full-file Chinese subtitle refinement as described in
  [Refine Chinese Subtitles](#4-refine-chinese-subtitles).
- Do not use CLI `--agent=codex` as a substitute for sub-agent batch work unless the user
  explicitly asks for the CLI automation path.
- During `translation_work`, do not call the OpenAI-compatible provider configured in
  `.env` to translate. Translation is done by sub-agents using the batch context provided
  by the main agent.
- Never edit `transcript/raw/segments.toml` or `transcript/raw/chunks/*.toml`. Raw
  transcript files are references. Edit only `transcript/work/segments.toml`,
  `translation/work/segments.toml`, and `description.md`.
- `description.md` is the source of truth for media metadata, user notes, context,
  glossary, fixed terms, style requirements, and unresolved uncertainty. Keep it current
  throughout the session.
- Use `rajio check` as documented in the CLI section. It is not a substitute for manual
  QA of typos, ASR errors, proper nouns, context, terminology, fixed phrases, and
  translation consistency.
- Record intentional subtitle QA `error` exceptions with per-segment `skip_checks` in the
  work-stage `segments.toml`. Every skip must name the exact issue code and include a
  reason. Never skip `fatal` data/file/schema/timeline issues, unfinished translation, or
  unreviewed batches. Matched skips are omitted from check output; stale skips still report
  `fatal unused_skip_check`.
- Use `rajio segments` commands for stable targeted edits to work-stage `segments.toml`:
  list/filter segments, edit fields, split/merge subtitle units, and delete semantically
  empty filler segments. Shape: `rajio segments <command> <target>`.
- Use `rajio clips` commands for difficult source-video ranges that need independent
  retranscription for comparison. Clip outputs are sidecar review artifacts only; do not
  treat them as automatic replacements for `transcript/work/segments.toml`.

## Sub-Agent Batch Contract

- Spawn sub-agents for every `transcript_work` proofread batch and every
  `translation_work` translation batch. If sub-agent tooling is unavailable, stop and
  report that manual stages cannot be completed under this skill.
- Run sub-agent batches within the active concurrency/thread limit, and close or release
  completed workers before spawning more.
- Read [SUB_AGENTS.md](SUB_AGENTS.md) before spawning sub-agents. Keep this file focused
  on workflow rules; use that document for batch-worker instructions and prompt patterns.
- The main agent owns batch planning, patch application, glossary decisions, consistency
  QA, final full-file Chinese refinement, `description.md`, `rajio check`, commits,
  exports, and final reporting.

## Required Input

- Local audio/video path. Refuse to start without this.
- Optional but preferred: title, original URL, publish date, uploader/channel, synopsis,
  cast, program/corner names, user notes, fixed terminology, and translation style
  requirements.

If optional metadata is missing, proceed with filename-based defaults, record the
uncertainty in `description.md`, and revisit it when transcript context reveals more.

## CLI Quick Reference

For complete command syntax, examples, output formats, segment patch shape, clip artifact
details, and environment variables, read [CLI.md](CLI.md#rajio-cli-reference).

Check whether `rajio` is available:

```bash
command -v rajio
```

If it is not installed, run commands through `npx rajio ...`.

### Command Overview

Use the installed CLI:

```bash
rajio <target> [options]
rajio segments <command> <target> --stage transcript
rajio clips <command> <target>
rajio check <target>
rajio doctor <target>
```

### Default Command

The default command drives the whole session workflow.

Default command media option:

- `--media <path>`: invocation-only media override.

Default command workflow controls:

- `--continue=until-manual`: run automatic stages until the next manual stage.
- `--continue=step`: run one automatic stage.
- `--commit`: commit the current manual stage after validating its work file.
- `--reset <stage>`: regenerate from `audio`, `transcript_raw`, `transcript_work`,
  `translation_work`, or `export`.
- `--agent=codex`: CLI automation escape hatch. Do not use it as the default manual-stage
  workflow; use sub-agent batches instead.

Audio chunk options:

- `--chunk-target <seconds>`: local audio chunk target. Default `600`, minimum `60`.
- `--chunk-boundary-search <seconds>`: silence search window around the target cut point.
  Default `90`, range `0..300`.
- `--chunk-silence-noise <db>`: ffmpeg `silencedetect` threshold. Default `-35`.
- `--chunk-silence-duration <seconds>`: minimum silence duration. Default `0.4`.

These chunk options apply when audio chunks are generated, including first run and
`--reset audio`. They are recorded under `stages.audio.chunking` in `session.toml`.
`--reset transcript_raw` reuses existing `stages.audio.chunks[]` and does not apply new
chunk options.

### Segments

Most `rajio segments` commands print affected segment rows. `segments apply` is the
exception: by default it prints operation counts plus patch-scoped check feedback. Agents
should default to `--json` for parseable output. When using verbose JSON, pipe the output
through `jq` to select only the fields you need instead of reading the full raw payload.
See [CLI.md](CLI.md#segments-commands) for JSON structures.

Segment command examples:

```bash
rajio segments list /path/to/session --json --stage transcript
rajio segments list /path/to/session --json --stage transcript --id 12
rajio segments list /path/to/session --json --stage transcript --id 12 --around 3
rajio segments list /path/to/session --json --stage transcript --offset 100 --limit 50
rajio segments list /path/to/session --json --stage transcript --start 600 --end 660
rajio segments list /path/to/session --json --stage translation --issues empty_zh,zh_line_hard_limit
rajio segments list /path/to/session --json --stage translation --issues duration_too_long --level error
rajio segments apply /path/to/session patch.toml --json --stage translation
rajio segments apply /path/to/session --json --stage translation <<'EOF'
[[operations]]
op = "edit"
segment_id = "12"
zh = "修正后的中文字幕"
EOF
rajio segments edit /path/to/session 12 --json --stage transcript --start 10.2 --end 13.4 --speaker A --ja "修正した日本語"
rajio segments edit /path/to/session 12 --json --stage transcript --ja "修正した日本語" --dry-run
rajio segments split /path/to/session 12 --json --stage transcript --at 11.8 --gap 0.08 --id1 12.1 --id2 12.2 --ja1 "前半の日本語" --ja2 "後半の日本語" --speaker1 A --speaker2 B
rajio segments merge /path/to/session 12.1 12.2 --json --stage transcript --id 12 --ja "結合した日本語" --speaker A,B
rajio segments delete /path/to/session 13 --json --stage transcript
```

In `segments` commands, pass `/path/to/session` after the segment subcommand. Replace
`--stage transcript` with `--stage translation` for `translation/work/segments.toml`.

`segments list` accepts one filter mode at a time:

- `--id <id>`: show one segment.
- `--id <id> --around <count>`: show one segment plus surrounding context.
- `--offset <count> --limit <count>`: show a zero-based segment window; omit `--limit`
  to read from offset to the end.
- `--start <time> --end <time>`: show segments whose `start` time is in `[start, end)`.
- `--issues <codes>`: show segments matching validation codes such as `invalid_time`,
  `ja_line_hard_limit`, or `empty_zh`; add `--level error` to exclude warning-level
  matches for soft-or-hard codes like duration and reading speed.

`segments apply <target> [file]` applies an ordered TOML patch as the batch form of `edit`,
`split`, `merge`, and `delete`. Pass a file path, or omit `[file]` only when providing stdin in
the same shell command, such as `<<'EOF' ... EOF`. For batch work, prefer a patch file
under a session-local `patches/` directory. Normal apply writes the patched segments, then
runs patch-scoped check feedback. `--dry-run` validates the patch, previews affected output,
and runs the same checks without writing changes. Use `--verbose --json` with `jq` when you
need affected segment rows and their remaining issues.

```toml
created_by = "worker-a"
start = 120.0
end = 180.0

[[operations]]
op = "edit"
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
gap = 0.08

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

### Clips

Clip command examples:

```bash
rajio clips transcribe /path/to/session --start 120 --end 180 --label noisy-overlap
rajio clips list /path/to/session --json
rajio clips show /path/to/session clip-120000-180000 --json
```

Use clips when an initial transcription has a complex, noisy, overlapped, or error-prone
time range that should be independently recognized for comparison. `clips list` prints
only clip rows; `clips show` prints only that clip's `segments.toml`. Agents should
default to `--json` for `clips list` and `clips show`; otherwise output is a
human-readable table. See [CLI.md](CLI.md#clips-commands) for JSON structures.

### Check

Use `rajio check` before committing manual stages and before final reporting. It validates
session shape, timeline integrity, required text, and subtitle QA heuristics, but it does
not replace semantic review for ASR mistakes, names, terms, context, or translation
quality.

Use `--json` for machine-readable output; pipe it to `jq` when you need to extract fields
or slice down the output. See [CLI.md](CLI.md#check) for JSON structures.

- `rajio check /path/to/session --json --level error`: show blocking `fatal` and `error`
  issues.
- `rajio check /path/to/session --json --stage transcript --language ja`: check transcript
  work Japanese QA. Transcript checks only support `ja`.
- `rajio check /path/to/session --json --stage translation`: check translation work Chinese QA;
  `zh` is the default language for translation.
- `rajio check /path/to/session --json --stage translation --language ja`: inspect Japanese
  subtitle QA inherited into `translation/work/segments.toml`.
- Add `--verbose` only when you need full sorted `issues`, such as locating exact
  segment IDs and issue codes before adding `skip_checks`. When using verbose JSON, pipe
  it through `jq` to inspect only the fields you need instead of reading the full raw
  payload.

## Subtitle QA Rules

These are the subtitle QA thresholds enforced by `rajio check`; severity, stage, and
language filtering follow the Check section above.

| Rule                 | Warning                                                                                                             | Error                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Japanese line length | `ja` line exceeds 20 visible non-space characters                                                                   | `ja` line exceeds 28 visible non-space characters                          |
| Chinese line length  | `zh` line exceeds 16 visible non-space characters                                                                   | `zh` line exceeds 24 visible non-space characters                          |
| Line count           | Japanese or Chinese text has 2 lines                                                                                | Japanese or Chinese text has more than 2 lines                             |
| Subtitle duration    | shorter than 0.8 seconds or longer than 7 seconds                                                                   | shorter than 0.5 seconds or longer than 10 seconds                         |
| Reading speed        | Japanese exceeds 15 chars/s; Chinese exceeds 11 chars/s                                                             | Japanese exceeds 20 chars/s; Chinese exceeds 15 chars/s                    |
| Adjacent gap         | gap is 80-250 ms                                                                                                    | gap is under 80 ms                                                         |
| Punctuation          | ordinary comma/period punctuation, ordinary sentence-ending punctuation, or two repeated question/exclamation marks | punctuation-only line or more than two repeated question/exclamation marks |

Do not satisfy numeric limits by creating unreadable single-character, single-syllable,
or isolated filler subtitles. Prefer natural compression, merging with an adjacent segment,
retiming, or splitting at a semantic pause. Single `？` or `！` is allowed when needed for
intent, but use it sparingly.

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

`rajio doctor` validates runtime configuration and provider access using the target directory for `.env` loading. Do not start transcription until `rajio doctor` passes or the environment issue is resolved.

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

Treat automatically created work segments as a draft.

Rajio may write suggested patches under
`transcript/work/suggested-patches/`, but never applies them automatically. Review them during
the proofread stage below.

Suggested patch review:

- Review suggested patches in numeric filename order.
- Treat `confidence = "medium"` patches with extra care and `*-low.*` files as notes.
- Patch `reason` and `confidence` fields do not change apply behavior.

Example generated files:

```text
transcript/work/suggested-patches/
  01-punctuation-cleanup-chunk-000-000000s-000600s-high.toml
  02-fragment-merge-chunk-000-000000s-000600s-high.toml
  02-fragment-merge-chunk-000-000000s-000600s-medium.toml
  03-boundary-retime-chunk-000-000000s-000600s-high.toml
  04-long-segment-candidates-chunk-000-000000s-000600s-low.md
```

### 2. Proofread And Polish Japanese

Proofread flow:

1. Review automatically generated suggested patches under
   `transcript/work/suggested-patches/`, adjust them if needed, dry-run them with
   `rajio segments apply <session> <patch> --stage transcript --dry-run`, then apply the
   accepted safe patches.
2. Spawn transcript proofread sub-agents following [SUB_AGENTS.md](SUB_AGENTS.md). Each
   worker gets a label and assigned source-media `start`/`end` range.
3. Review each worker patch file and dry-run summary. Apply accepted patches to
   `transcript/work/segments.toml`.
4. Perform a whole-transcript review and polish pass for context, terminology, fixed
   phrases, structure, and readability across batch boundaries.
5. Commit `transcript_work` only after semantic review and validation are clean, or only
   intentional subtitle QA exceptions remain with exact `skip_checks`.

Use the segment commands documented in the CLI section with `--stage transcript`.
Do not translate in this stage.

For complex, noisy, overlapped, or suspicious ASR ranges, the main agent or a sub-agent may
use `rajio clips transcribe` to retranscribe the original media time range as sidecar
evidence. Then use
`rajio clips list --json` and `rajio clips show <id> --json` to compare the alternate
transcript against `transcript/work/segments.toml`. Clip output is reference material; do
not treat it as an automatic replacement.

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
- Follow the Subtitle QA Rules for line length, line count, duration, reading speed, gaps,
  and punctuation.

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

If only intentional subtitle QA exceptions remain, inspect them first:

```bash
rajio check /path/to/session --json --stage transcript --language ja --level error --verbose
```

If preserving an exception improves accuracy, naturalness, or readability, add
`skip_checks` to the affected segment with the exact issue code and a reason, then commit
normally:

```bash
rajio /path/to/session --commit --continue=until-manual
```

Expected result: rajio commits `transcript_work`, creates
`translation/work/segments.toml`, and stops at `translation_work`.

### 3. Translate And Polish Chinese

Initial translation flow:

1. Plan explicit translation batches by non-overlapping source-media time ranges instead
   of attempting the whole file in one pass. Choose range sizes by dialogue density and
   the active sub-agent concurrency limit.
2. Spawn translation sub-agents following [SUB_AGENTS.md](SUB_AGENTS.md). Each worker gets
   a label and assigned source-media `start`/`end` range.
3. Review each worker patch file and dry-run summary. Apply accepted patches to
   `translation/work/segments.toml` so every segment has filled or refined `zh`.
4. Perform a whole-file first-draft review for terminology, subtitle continuity, missing
   translations, Japanese corrections made during translation, and cross-batch style
   consistency.
5. Commit `translation_work` and export only after every batch has been translated,
   terminology has been cross-checked, and validation has no blocking `fatal` or Chinese
   `error` issues except reviewed intentional subtitle QA exceptions.

Use the segment commands documented in the CLI section with `--stage translation`, or
apply patches carefully, to fill translated subtitle text into `zh`.

During batch work, keep glossary updates and unresolved uncertainty in `description.md`,
and search earlier completed batches when a new name, phrase, or style decision appears.
Before committing, confirm this command has no blocking `fatal` or Chinese `error` issues:

```bash
rajio check /path/to/session --json --stage translation --level error
```

To inspect Japanese QA in the current translation work file, run the same command with
`--language ja`.

During `translation_work`, `translation/work/segments.toml` is the active subtitle work
file. If translation reveals a Japanese typo, wrong name, wrong fixed phrase, missing
context, or bad segment structure, correct the relevant `ja` and `zh` in
`translation/work/segments.toml` and update `description.md` when the decision affects
terminology or future batches.

If a translation problem points back to an uncertain or messy source-audio range, use
`rajio clips transcribe` for that original media time range and inspect it with
`rajio clips show <id> --json`. Use the sidecar transcript as a second reference before
editing the committed transcript and reconciling the translation.

Validate often with `rajio check` as documented in the CLI section. This only checks data
shape, timing, required fields, and subtitle limits; before committing, still polish the
content semantically against the acceptance criteria below.

Acceptance criteria:

- Keep `id`, `start`, `end`, and `speaker` stable unless a structural correction or
  intentionally removed semantically empty filler genuinely requires a change. `ja` may be
  corrected in `translation/work/segments.toml` when translation review finds a Japanese
  typo, name, or fixed-phrase issue.
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
- Follow the Subtitle QA Rules for line length, line count, duration, reading speed, gaps,
  and punctuation.
- Do not create an awkward short trailing subtitle only to satisfy a warning threshold.
  Preserve subtitle continuity and readability first.

Before committing:

- Compare `description.md` glossary against `translation/work/segments.toml`.
- Search for inconsistent Chinese names, untranslated Japanese names, wrong titles, and
  stale translations from earlier draft assumptions.
- Spot-check opening, middle, ending, fixed greetings, mail reads, event announcements,
  and sign-off for Japanese correctness and Chinese readability.
- Check subtitle continuity across adjacent segments: the Chinese should read as connected
  dialogue, not isolated literal fragments.
- Review Japanese `error` and `warning` issues still present in
  `translation/work/segments.toml`:

```bash
rajio check /path/to/session --json --stage translation --language ja --level warning
```

- Record unresolved uncertainty in `description.md` or mention it in the final report.

When clean, commit and export the first translation draft:

```bash
rajio /path/to/session --commit --continue=until-manual
```

If intentional Chinese QA exceptions remain, inspect them first:

```bash
rajio check /path/to/session --json --stage translation --level error --verbose
```

Add `skip_checks` to each affected segment only after manual review confirms every
remaining `error` issue is an intentional subtitle QA exception and no `fatal` issues
remain. Then commit normally.

```bash
rajio /path/to/session --commit --continue=until-manual
```

Expected result: rajio commits `translation_work`, runs export, and reaches the
terminal `done` state. This ends the CLI workflow, but the exported subtitles are still
only a first-pass translation and proofread draft. The current main agent must continue
with the refinement pass below before treating the subtitles as final polished output.

Expected draft output:

- `output/*.ja.srt`
- `output/*.zh.srt`
- `output/*.ja-zh.ass`

### 4. Refine Chinese Subtitles

After the first draft export, the main agent must perform at least one full-pass Chinese
subtitle refinement over `translation/work/segments.toml`, and should iterate through
multiple refinement passes until the subtitles are genuinely polished. This is not a
substitute for the sub-agent batch translation stage: do not use these passes to fill
large missing sections or redo the whole translation from scratch. Use them to raise the
already translated draft to final subtitle quality.

Preserve the committed draft's structure unless a change clearly improves accuracy,
readability, or subtitle continuity. Do not break the Subtitle QA Rules, timeline
integrity, required fields, segment IDs, or transcript alignment. If refinement changes
the work file after export, recommit `translation_work` and regenerate export output.

Refinement requirements:

- Treat refinement as an active, multi-round editorial process. After each pass, inspect
  remaining rough spots, recurring wording problems, and consistency risks, then run
  another pass when meaningful improvements are still available.
- Read the Chinese subtitles continuously across adjacent segments, not only segment by
  segment. Repair places where the text reads like isolated translated fragments.
- Enforce global term consistency for names, programs, corners, events, works, products,
  hashtags, recurring jokes, honorific choices, and fixed phrases.
- Match register, tone, and speaker intent to the local context: casual speech should not
  become stiff, jokes should not become flat, and emotional emphasis should not disappear.
- Prefer natural Simplified Chinese subtitle language over literal completeness. Compress
  harmless repetition and spoken clutter when the source meaning, rhythm, and speaker
  personality are preserved.
- Check pronouns, ellipses, omitted subjects, callbacks, and topic shifts against nearby
  Japanese context so Chinese lines do not become ambiguous or misleading.
- Smooth sentence flow across subtitle boundaries while keeping each subtitle readable on
  its own timing. Avoid awkward trailing fragments created only to satisfy line limits.
- Revisit glossary decisions in `description.md`; update it when a better confirmed term
  or style rule is chosen, then apply that choice consistently through the full file.
- Search for stale draft assumptions, mixed translations of the same term, untranslated
  Japanese, accidental simplified/traditional mismatches, and Chinese punctuation noise.
- Preserve meaningful speaker style differences where the source supports them, but do
  not over-characterize beyond the audio/video evidence.
- If a Chinese issue exposes a likely Japanese subtitle mistake, fix the `ja`/`zh` pair in
  `translation/work/segments.toml`, update `description.md` if needed, and rerun the
  translation checks.

During and after refinement, validate with:

```bash
rajio check /path/to/session --json --stage translation --language zh --level error
rajio check /path/to/session --json --stage translation --language ja --level warning
```

After the final refinement pass, run export reset with commit. This commits dirty
`translation_work` when refinement changed it, and otherwise just regenerates export from
the existing committed translation:

```bash
rajio /path/to/session --reset export --commit --continue=until-manual
```

If the final refined translation still has intentional Chinese QA exceptions, inspect them
first as documented above, add exact per-segment `skip_checks`, then rerun the same commit
and export reset command:

```bash
rajio /path/to/session --reset export --commit --continue=until-manual
```

Expected final output:

- `output/*.ja.srt`
- `output/*.zh.srt`
- `output/*.ja-zh.ass`

### 5. Final Verification

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
  are reused on retry; use `--reset transcript_raw` to start a full new transcription round.
- If the user asks to retry an earlier workflow step, run the default command with
  `--reset`: `--reset audio` retries audio extraction and chunking, `--reset transcript_raw`
  reruns transcription generation, `--reset transcript_work` regenerates the transcript
  work file, `--reset translation_work` regenerates the translation draft, and
  `--reset export` reruns subtitle export.
