import { createFileRoute } from '@tanstack/react-router';
import { createFromSource } from 'fumadocs-core/search/server';
import { source } from '../../source';

const search = createFromSource(source, {
  tokenizer: {
    language: 'cjk',
    normalizationCache: new Map(),
    tokenize(raw) {
      return [...new Set([...latinTokens(raw), ...cjkTokens(raw)])];
    }
  }
});

export const Route = createFileRoute('/api/search')({
  server: {
    handlers: {
      GET: ({ request }: { request: Request }) => search.GET(request)
    }
  }
});

function latinTokens(raw: string) {
  return raw.toLowerCase().match(/[a-z0-9_'-]+/g) ?? [];
}

function cjkTokens(raw: string) {
  const tokens: string[] = [];

  for (const match of raw.matchAll(
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu
  )) {
    const chars = Array.from(match[0]);
    for (let index = 0; index < chars.length - 1; index += 1) {
      tokens.push(`${chars[index]}${chars[index + 1]}`);
    }
  }

  return tokens;
}
