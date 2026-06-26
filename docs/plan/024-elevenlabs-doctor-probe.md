# ElevenLabs Doctor Probe Plan

后续被 `027` 扩展为 provider-aware doctor。

## Summary

Make `rajio doctor` validate `ELEVENLABS_API_KEY` with a no-upload ElevenLabs Speech-to-Text API
request instead of only checking that the variable exists.

## Key Changes

- Use `client.speechToText.transcripts.get()` with a fixed nonexistent transcript id as the
  no-upload transcription probe.
- Treat 404 or `invalid_uid` as success because either response proves the API key reached the
  Speech-to-Text transcript endpoint without uploading audio or starting transcription.
- Missing `ELEVENLABS_API_KEY` remains a `transcription` failure.
- A failed ElevenLabs probe is a `transcription` failure with the original error detail.
- A successful probe reports `ElevenLabs Speech-to-Text API is reachable`.

## Test Plan

- Mock ElevenLabs connectivity in doctor tests.
- Cover missing key, successful transcription probe, and failed transcription probe.

## Assumptions

- The transcript lookup endpoint is read-only and does not upload audio or run transcription.
- Scoped keys need Speech-to-Text access, not User/Subscription access, for the probe to pass.
