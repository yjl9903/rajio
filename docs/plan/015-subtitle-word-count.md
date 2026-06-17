# Subtitle Word Count

Subtitle line length and reading speed checks use a shared subtitle text unit count instead of raw
non-space character count.

Rules:

- CJK text, including Han, Hiragana, Katakana, and Hangul, counts one unit per character.
- Latin letters and numbers count as one token for each whitespace-separated run.
- Email addresses, `http(s)://` URLs, `www.` URLs, and bare domains such as `example.com` count
  as one token, including URL paths, queries, and fragments.
- Punctuation and symbols do not count and do not break Latin/number tokens.
- Whitespace does not count and separates Latin/number tokens.
- Other non-space, non-punctuation, non-symbol characters count one unit per character.
- Subtitle punctuation QA ignores punctuation inside email addresses and URLs.

Examples:

- `Hello world` counts as 2.
- `GPT-5` counts as 1.
- `v1.2.3` counts as 1.
- `foo@example.com` counts as 1.
- `https://example.com/a.b` counts as 1.
- `OpenAI 2026` counts as 2.
- `这是 OpenAI 2026 测试` counts as 6.

The CLI continues to label these values as `chars` in validation messages and check summaries for
output compatibility, but the values now follow the subtitle text unit rules above.
