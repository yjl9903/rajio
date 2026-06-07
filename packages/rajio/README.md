# Rajio ラジオ

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/yjl9903/rajio)
[![version](https://img.shields.io/npm/v/rajio?label=Rajio)](https://www.npmjs.com/package/rajio)
[![CI](https://github.com/yjl9903/rajio/actions/workflows/ci.yml/badge.svg)](https://github.com/yjl9903/rajio/actions/workflows/ci.yml)

Japanese Seiyuu (声優) Radio Translator Agent Skill.

Rajio helps your AI agent turn local Japanese Seiyuu radio files into Chinese subtitles.

- Prepare a session with local media and episode metadata
- Extract and chunk audio for transcription
- Transcribe Japanese speech into timestamped segments
- Proofread and polish the Japanese transcript
- Translate and polish Simplified Chinese subtitles
- Export Japanese SRT, Chinese SRT, and bilingual ASS files

## Example

See [examples/【高画質・完全版】春日さくらと乾夏寧の夏もさくらを咲かせたい 第49回](examples/%E3%80%90%E9%AB%98%E7%94%BB%E8%B3%AA%E3%83%BB%E5%AE%8C%E5%85%A8%E7%89%88%E3%80%91%E6%98%A5%E6%97%A5%E3%81%95%E3%81%8F%E3%82%89%E3%81%A8%E4%B9%BE%E5%A4%8F%E5%AF%A7%E3%81%AE%E5%A4%8F%E3%82%82%E3%81%95%E3%81%8F%E3%82%89%E3%82%92%E5%92%B2%E3%81%8B%E3%81%9B%E3%81%9F%E3%81%84%20%E7%AC%AC49%E5%9B%9E/) for a rajio work session example.

Translated video: [BV1S6EH6FEZN](https://www.bilibili.com/video/BV1S6EH6FEZN).

```srt
1
00:00:01,554 --> 00:00:02,804
春日樱与

2
00:00:03,004 --> 00:00:04,154
乾夏宁的

3
00:00:04,304 --> 00:00:06,204
也想让夏天绽放樱花

4
00:00:18,854 --> 00:00:21,154
大家开花了吗

...
```

## Usage

Copy this to your agent:

```text
Download and use the rajio skill from https://github.com/yjl9903/rajio/blob/main/skills/rajio/SKILL.md
```

Then give your agent a local media file and any notes you have.

Requirements:

- Install the latest Node.js.
- Make sure `ffmpeg` and `ffprobe` can be found in your environment.
- Set `OPENAI_API_KEY` and, if needed, `OPENAI_BASE_URL` for a provider that supports `gpt-4o-transcribe-diarize`.

## CLI

The package exposes a local CLI for your agent to call:

```bash
npm i -g rajio

rajio --help
```

## License

AGPL-3.0 License © 2026 [OneKuma](https://github.com/yjl9903)
