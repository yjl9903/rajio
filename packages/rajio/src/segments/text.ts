const CJK_CHARACTER = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const WORD_TOKEN_CHARACTER = /[\p{Script=Latin}\p{Number}]/u;
const SPACE = /\s/u;
const KEYCAP_MARK = '\u20e3';
const IGNORED_SEPARATOR = /[\p{P}\p{S}\p{M}\p{Cf}]/u;
const SUBTITLE_PROTECTED_TOKEN =
  /\b(?:[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[a-z]{2,}|https?:\/\/[a-z0-9._~:/?#\[\]@!$&()*+,;=%-]+|www\.[a-z0-9._~:/?#\[\]@!$&()*+,;=%-]+|(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[/?#][a-z0-9._~:/?#\[\]@!$&()*+,;=%-]*)?)/giu;
const PROTECTED_TOKEN_TRAILING_PUNCTUATION = /[.。．,，、;；:：!?！？]+$/u;
const PROTECTED_TOKEN_PLACEHOLDER = '\u0000';

export function countSubtitleTextUnits(value: string): number {
  const normalized = value.normalize('NFC');
  let count = 0;
  let index = 0;

  for (const match of normalized.matchAll(SUBTITLE_PROTECTED_TOKEN)) {
    count += countPlainSubtitleTextUnits(normalized.slice(index, match.index));
    count += 1;
    index = match.index + match[0].length;
  }

  return count + countPlainSubtitleTextUnits(normalized.slice(index));
}

export function stripSubtitleProtectedText(value: string): string {
  return value.replace(SUBTITLE_PROTECTED_TOKEN, (token) => {
    const core = protectedTokenCore(token);
    return `${PROTECTED_TOKEN_PLACEHOLDER}${token.slice(core.length)}`;
  });
}

export function replaceOutsideSubtitleProtectedText(
  value: string,
  replace: (text: string, isLast: boolean) => string
): string {
  let output = '';
  let index = 0;
  for (const match of value.matchAll(SUBTITLE_PROTECTED_TOKEN)) {
    output += replace(value.slice(index, match.index), false);
    const core = protectedTokenCore(match[0]);
    output += core;
    index = match.index + core.length;
  }
  return output + replace(value.slice(index), true);
}

function protectedTokenCore(value: string): string {
  return value.replace(PROTECTED_TOKEN_TRAILING_PUNCTUATION, '') || value;
}

function countPlainSubtitleTextUnits(value: string): number {
  let count = 0;
  let inWordToken = false;

  for (const char of value) {
    if (CJK_CHARACTER.test(char)) {
      if (inWordToken) {
        count += 1;
        inWordToken = false;
      }
      count += 1;
      continue;
    }

    if (WORD_TOKEN_CHARACTER.test(char)) {
      inWordToken = true;
      continue;
    }

    if (SPACE.test(char)) {
      if (inWordToken) {
        count += 1;
        inWordToken = false;
      }
      continue;
    }

    if (char === KEYCAP_MARK) {
      inWordToken = false;
      continue;
    }

    if (IGNORED_SEPARATOR.test(char)) {
      continue;
    }

    if (inWordToken) {
      count += 1;
      inWordToken = false;
    }
    count += 1;
  }

  if (inWordToken) {
    count += 1;
  }

  return count;
}
