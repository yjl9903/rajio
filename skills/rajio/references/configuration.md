# Rajio Configuration Reference

Load this reference only when changing transcription configuration, debugging provider
access, interpreting chunk/checkpoint artifacts, or explaining `rajio doctor` provider checks.

## Environment

Rajio loads `.env` from the command cwd, then from the resolved session directory. Later
files override earlier values:

```text
session .env > cwd .env > process environment
```

| Name                 | Used for                                            |
| -------------------- | --------------------------------------------------- |
| `ELEVENLABS_API_KEY` | ElevenLabs transcription provider.                  |
| `OPENAI_API_KEY`     | OpenAI-compatible ASR provider and manual AI/Codex. |
| `OPENAI_BASE_URL`    | Optional OpenAI-compatible API base URL.            |
| `FFMPEG_PATH`        | Optional `ffmpeg` binary override.                  |
| `FFPROBE_PATH`       | Optional `ffprobe` binary override.                 |

## Transcription Config

Default transcription config is ElevenLabs:

```toml
[transcription]
provider = "elevenlabs"
model = "scribe_v2"
segmenter = "integrated"
```

OpenAI-compatible ASR config:

```toml
[transcription]
provider = "openai"
model = "whisper-1"
segmenter = "integrated"
```

CLI override:

```bash
rajio /path/to/session --transcription-provider openai
```

Do not use manual AI/API calls as a bulk machine-translation service for whole subtitle
ranges. This restriction does not forbid using the configured ASR provider for transcription.

## Audio Strategy

Rajio has two audio strategies:

- `single_file`: transcription receives `audio/extracted.m4a` or clip `source.m4a`.
- `silence_or_time`: rajio writes local audio chunks and sends each chunk as an input.

Current provider behavior:

| Provider     | Model       | Strategy          | Main audio artifacts                        |
| ------------ | ----------- | ----------------- | ------------------------------------------- |
| `elevenlabs` | `scribe_v2` | `single_file`     | `audio/extracted.m4a`; no `audio/chunks/`.  |
| `openai`     | `whisper-1` | `silence_or_time` | `audio/extracted.m4a` plus `audio/chunks/`. |

Chunk options such as `--chunk-target` are still accepted for both providers. They only
produce local chunk artifacts for providers using `silence_or_time`.

## Checkpoints And Clips

Raw transcription checkpoints live under:

```text
transcript/raw/checkpoints/input-*.toml
transcript/raw/checkpoints/input-*.error.log
```

Clip transcription writes sidecar artifacts under `clips/<clip-id>/`:

```text
clips/<clip-id>/
  clip.toml
  source.m4a
  chunks/                 # only when the selected provider uses local chunking
  checkpoints/
    input-*.toml
    input-*.error.log
  segments.toml
```

`clips show` reads only the clip `segments.toml`; clip output never updates the main
transcript automatically.

## Doctor

`rajio doctor <target>` loads the target session config and checks the selected
transcription provider:

- ElevenLabs transcription requires `ELEVENLABS_API_KEY` and uses a no-upload
  Speech-to-Text probe.
- OpenAI-compatible transcription requires `OPENAI_API_KEY` and checks the configured
  OpenAI-compatible API.
- If OpenAI is not the transcription provider, missing `OPENAI_API_KEY` is a warning for
  manual AI/Codex readiness, not a transcription failure.

It also checks CLI version/update status, `.env` loading, ffmpeg, ffprobe, Node.js, and
Codex readiness where relevant.
