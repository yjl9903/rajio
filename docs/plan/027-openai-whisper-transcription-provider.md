# OpenAI Whisper Transcription Provider

## Summary

Add `openai + whisper-1 + integrated` as a second transcription provider. Keep ElevenLabs as the
default and keep existing sessions compatible.

## Behavior

- `[transcription] provider = "openai"` defaults to `model = "whisper-1"` when no model is set.
- OpenAI transcription uses the existing `OPENAI_API_KEY` and `OPENAI_BASE_URL` runtime config.
- OpenAI audio uses the existing local chunking path and 24 MB upload safety limit.
- ElevenLabs behavior stays unchanged: `scribe_v2`, single extracted audio file, no local chunks.
- Raw and clip checkpoints continue to include `provider/model/segmenter`, so switching providers
  requires resetting/recreating the affected transcription output.
- `src/transcription/provider.ts` is the only workflow-facing transcription API; workflow and clips
  pass prepared inputs and receive a merged `SegmentsFile`.

## Scope

- Support only OpenAI `whisper-1` for now because it supports `verbose_json` word timestamps.
- Do not add a generic provider registry until another provider makes the branch logic noisy.
