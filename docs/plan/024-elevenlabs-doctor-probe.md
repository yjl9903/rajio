# ElevenLabs Doctor Connectivity Check

Provider selection follows `027-openai-whisper-transcription-provider.md`.

## Summary

Use an authenticated `POST /v1/speech-to-text` request for the ElevenLabs check in
`rajio doctor`. Send only `model_id=scribe_v2` as multipart form data, without a file or URL.
The request cannot start transcription because it has no audio source. Replace the previous
behavior without a compatibility mode.

## Design rationale

Use the same endpoint as real transcription work, `POST /v1/speech-to-text`, so the probe
exercises the actual service path and sends the same API key used by the workflow. This avoids
relying on an unrelated service endpoint or requiring unrelated permissions such as model listing.

The request deliberately supplies no audio data: it contains only the model field, with no file
or URL. The resulting missing-source error is intentional. The purpose is to test connectivity
with empty audio input, without uploading media or running transcription. The specific expected
400 response therefore counts as probe success; arbitrary errors do not. An error entry in the
provider's request log is an accepted consequence of this design.

## Behavior

- Require `ELEVENLABS_API_KEY` and send it as `xi-api-key` with the existing 10-second timeout.
- Accept only HTTP 400 with `detail.code = invalid_parameters` and the exact message
  `Must provide either file or a URL parameter.` as a successful probe.
- Report `ElevenLabs API is reachable` when that expected response is received.
- Authentication errors, missing permissions, other validation errors, unexpected responses,
  rate limits, server errors, and transport/timeout errors fail with error details.
- The expected 400 remains visible in ElevenLabs request logs; this is accepted behavior.
- The probe verifies reachability and the observed authentication-before-validation path.
  It does not guarantee Speech-to-Text permissions or quota: permission-check ordering has
  not been verified with a valid key lacking `speech_to_text` permission.
- Explain the check's scope in CLI help.

## Verification

- Assert the request includes the key and only the model field, with no audio file or URL.
- Accept the exact missing-source response; reject other errors and unexpected success.
- Preserve missing-key and provider-selection coverage; test transport and timeout failures.
- Run doctor/CLI tests, type checking, and formatting checks.

## Endpoint verification

On 2026-10-08, sending this request to the production API returned:

- Configured key: HTTP 400, `code = invalid_parameters`, with the expected missing-source message.
- Invalid key: HTTP 401, `status = invalid_api_key`.
- No key: HTTP 401, `status = needs_authorization`.

[Create transcript API](https://elevenlabs.io/docs/api-reference/speech-to-text/convert)
