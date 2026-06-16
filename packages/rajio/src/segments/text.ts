const CJK_CHARACTER = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const WORD_TOKEN_CHARACTER = /[\p{Script=Latin}\p{Number}]/u;
const SPACE = /\s/u;
const KEYCAP_MARK = '\u20e3';
const IGNORED_SEPARATOR = /[\p{P}\p{S}\p{M}\p{Cf}]/u;

export function countSubtitleTextUnits(value: string): number {
  let count = 0;
  let inWordToken = false;

  for (const char of value.normalize('NFC')) {
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
