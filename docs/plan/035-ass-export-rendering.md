# ASS export rendering

## Decision

Correct ASS output directly, without preserving the historical oversized layout or
destructive escaping. Existing session and segment formats do not change.

## Implementation

- Set `PlayResX` and `PlayResY` from the video stream dimensions in the audio stage's
  saved ffprobe metadata. Exclude cover art, thumbnails, and still-image streams; swap
  width and height for 90/270-degree display rotation, including legacy rotate tags.
  Pure audio or sessions without usable recorded video dimensions use 1920×1080.
- Scale the 1080p layout's font, outline, shadow, and margins by
  `min(width / 1920, height / 1080)`, so both landscape and portrait frames contain the
  layout. Preserve fractional font/effect sizes and round margins to whole coordinates.
- Treat segment text as plain text. Follow FFmpeg's ASS text conversion: insert U+2060
  WORD JOINER after literal backslashes unless already present, and encode each opening
  brace as `\{{}`. Keep closing braces. Perform these replacements before converting
  CRLF, LF, and CR newlines to `\N`; the bilingual separator remains a real ASS line break.
- Preserve title punctuation and backslashes. Replace title newlines with spaces because
  the Script Info header does not interpret dialogue-text escapes.
- Literal opening braces display correctly in libass. Standard ASS has no portable brace
  escape: legacy VSFilter may display a backslash instead. The empty block prevents it
  from hiding subsequent text. This follows the existing FFmpeg compromise rather than
  silently deleting punctuation or substituting different visible characters.
- Existing output files are regenerated through the normal export reset workflow.
- Validation and both subtitle formats recognize CRLF, LF, and CR consistently. SRT
  normalizes them to LF; ASS uses hard line breaks. NUL in either subtitle language is
  rejected as a fatal schema error before commit/export.
- Limit sanitized filename stems to 120 UTF-8 bytes, iterating whole code points. This
  leaves room under the 255-byte filesystem limit for extensions and atomic-write suffixes.
  No compatibility mode or further escaping framework is added.

References:

- [FFmpeg ASS text conversion](https://ffmpeg.org/doxygen/8.1/ass_8c_source.html)
- [libass literal curly bracket extension](https://github.com/libass/libass/wiki/Libass%27-ASS-Extensions#literal-curly-brackets)

## Verification

- Focused export tests cover resolution, literal braces and override-like text, literal
  backslash sequences, existing word joiners, newline forms, header isolation, validation
  consistency, NUL rejection, and multilingual filename byte limits.
- Rendered representative text with FFmpeg/libass 0.17.3: literal braces, backslashes,
  override-like text, and actual newlines display as intended, with no canvas fallback.
- Export-stage tests cover 720p/4K landscape, portrait, display-matrix and legacy-tag
  rotation, cover-art exclusion, and audio-only/missing-metadata fallback.
- `pnpm --filter rajio test --run`: all 297 tests passed across 14 files.
- `pnpm --filter rajio typecheck`, Prettier checks, and `git diff --check`: passed.
