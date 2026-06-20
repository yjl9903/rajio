# ElevenLabs Provider-Aware Audio And Transcription Plan

## Summary

Switch一期 transcription to top-level session config and provider-aware audio strategy. Only
`elevenlabs + scribe_v2 + integrated` is supported.

Refactor code layout:

- `src/audio/`: media probing, extraction, chunk planning, and clip audio extraction.
- `src/transcription/`: config resolution, ElevenLabs call, checkpoints, normalization, segment
  generation.

## Key Changes

- Add top-level session config:
  - `[transcription]`
  - `provider = "elevenlabs"`
  - `model = "scribe_v2"`
  - `segmenter = "integrated"`
- Resolve config from CLI > description frontmatter > default only when session config is missing or
  when `--reset=transcript_raw` accepts explicit CLI override.
- After `session.toml` has `[transcription]`, ignore later `description.md` transcription changes.
- If CLI transcription args differ from recorded `[transcription]`, fail unless
  `--reset=transcript_raw`; the error prints the exact rerun command.
- Reject unsupported provider/model/segmenter values directly.

## Audio And Transcription Flow

- `audio` stage always extracts `audio/extracted.m4a` and records metadata/hash.
- `audio` stage records extracted audio `audio_size` and `audio_sha256`; transcription validates
  them when present.
- For ElevenLabs, `audio` stage records strategy `single_file` and does not create or require
  `audio/chunks`.
- `transcript_raw` reads `[transcription]` and audio strategy:
  - ElevenLabs transcribes one input: `audio/extracted.m4a`.
  - Checkpoints use `transcript/raw/checkpoints/input-000.toml`.
  - Checkpoint records `provider/model/segmenter` and resumes only when all match.
- `clips transcribe` follows the same provider strategy:
  - Extract requested range to `clips/<id>/source.m4a`.
  - ElevenLabs transcribes that file once.
  - Checkpoints use `clips/<id>/checkpoints/input-000.toml`.
  - Output segment times are offset to source-media time.

## Code Structure Refactor

- Move audio/video utilities from workflow stage files into `src/audio/`.
- Keep `workflow/stages/audio.ts` as a thin session-update wrapper.
- Keep `workflow/stages/transcription.ts` as a thin raw-stage orchestration wrapper.
- Move transcription logic into `src/transcription/`:
  - config types/resolution/validation
  - ElevenLabs SDK request
  - checkpoint read/write/compatibility
  - raw response normalization and segment generation
- Avoid generic provider abstractions while only ElevenLabs is supported.

## ElevenLabs Behavior

- Runtime config reads `ELEVENLABS_API_KEY`.
- Call ElevenLabs STT with `model_id=scribe_v2`, `language_code=ja`, `diarize=true`,
  `timestamps_granularity=word`.
- Store TOML-compatible response snapshot in checkpoint; dropped `null` fields are acceptable.
- Raw `segments.toml` keeps `segments[].words`.
- `transcript_work` drops `words`; translation/export ignore them.
- Segment text excludes `spacing` and `audio_event`; raw `words` keeps timed items with
  `text/start/end`.

## Public Interfaces

- Main command and `clips transcribe` accept:
  - `--transcription-provider`
  - `--transcription-model`
  - `--transcription-segmenter`
- Existing `--chunk-*` CLI options remain accepted and validated. The chunking strategy stays in
  code for future models, while ElevenLabs integrated transcription currently selects
  `single_file` and does not write chunk metadata.
- `doctor` checks `ELEVENLABS_API_KEY` for the recorded transcription provider.
- OpenAI env remains for Codex/manual workflow use, not transcription provider connectivity.

## Test Plan

- Config: default init, frontmatter init, CLI override, top-level session config wins afterward.
- Reset guard: changed CLI config without `--reset=transcript_raw` fails; reset accepts and rewrites
  config.
- Audio: ElevenLabs records `single_file` and does not require/write chunk metadata.
- Raw: one extracted audio input, matching checkpoint resumes, mismatched provider/model/segmenter
  does not resume.
- Checkpoint path: raw uses `transcript/raw/checkpoints/input-000.toml`; clips use
  `clips/<id>/checkpoints/input-000.toml`.
- ElevenLabs normalization: word mapping, source offset, speaker boundary, spacing/audio event
  handling, `confidence = exp(logprob)`.
- Work stage: raw keeps `words`, transcript work drops `words`.
- Clips: one extracted range, one checkpoint, matching resume.
- Doctor: missing `ELEVENLABS_API_KEY` fails for ElevenLabs.

## Assumptions

- Existing sessions with completed `transcript_raw` are not automatically rerun.
- Legacy sessions missing `[transcription]` get ElevenLabs default when workflow next needs
  transcription config.
- Old `transcript/raw/chunks/*.toml` checkpoints are ignored after this change.
