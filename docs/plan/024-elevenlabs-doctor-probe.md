# ElevenLabs Doctor Connectivity Check

Provider selection follows `027-openai-whisper-transcription-provider.md`.

## Summary

Use `GET /v1/models` for the ElevenLabs check in `rajio doctor`. The request checks API
reachability without uploading audio, starting transcription, or deliberately generating an
HTTP error. Replace the previous behavior without a compatibility mode.

## Behavior

- Require `ELEVENLABS_API_KEY` to be set for the ElevenLabs transcription provider.
- Call `client.models.list()` with the configured key and the existing 10-second timeout.
- Report `ElevenLabs API is reachable` when the request succeeds.
- Treat request errors as a `transcription` failure with the original error detail.
- Success does not establish key validity, Speech-to-Text permissions, or available quota:
  the models endpoint documents the API key as optional.
- Explain the check's scope in CLI help.

## Verification

- Exercise the SDK request with mocked HTTP responses: a successful models list and failing
  400, 401, and 404 responses.
- Preserve existing missing-key and provider-selection coverage.
- Run package tests, type checking, and formatting checks.

## Reference

- [ElevenLabs List models](https://elevenlabs.io/docs/api-reference/models/list)
