import { readFile } from 'node:fs/promises';

import { parse } from 'yaml';

import type { DescriptionInfo } from '../types.js';

export async function readDescription(filePath: string | undefined): Promise<DescriptionInfo> {
  if (!filePath) {
    return { body: '', frontmatter: {} };
  }

  const parsed = parseMarkdownDescription(await readFile(filePath, 'utf8'), filePath);
  return {
    path: filePath,
    body: parsed.content.trim(),
    frontmatter: normalizeFrontmatter(parsed.data)
  };
}

function parseMarkdownDescription(
  source: string,
  filePath: string
): { content: string; data: Record<string, unknown> } {
  const text = source.replace(/^\uFEFF/, '');
  const opening = /^---[ \t]*\r?\n/.exec(text);
  if (!opening) {
    return { content: text, data: {} };
  }

  let cursor = opening[0].length;
  while (cursor < text.length) {
    const lineEnd = text.indexOf('\n', cursor);
    const nextCursor = lineEnd === -1 ? text.length : lineEnd + 1;
    const line = text.slice(cursor, lineEnd === -1 ? text.length : lineEnd).replace(/\r$/, '');
    if (/^---[ \t]*$/.test(line)) {
      const rawData = text.slice(opening[0].length, cursor);
      return { content: text.slice(nextCursor), data: parseFrontmatter(rawData, filePath) };
    }
    cursor = nextCursor;
  }

  throw new Error(`Missing closing frontmatter delimiter in ${filePath}`);
}

function parseFrontmatter(source: string, filePath: string): Record<string, unknown> {
  try {
    const data: unknown = source.trim() ? parse(source) : {};
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return {};
    }

    const prototype = Object.getPrototypeOf(data);
    return prototype === Object.prototype || prototype === null
      ? (data as Record<string, unknown>)
      : {};
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid frontmatter in ${filePath}: ${message}`);
  }
}

function normalizeFrontmatter(data: Record<string, unknown>): DescriptionInfo['frontmatter'] {
  const frontmatter: DescriptionInfo['frontmatter'] = { ...data };
  for (const key of ['media', 'title', 'url', 'published_at'] as const) {
    const value = data[key];
    if (value instanceof Date) {
      frontmatter[key] = value.toISOString().slice(0, 10);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      frontmatter[key] = String(value);
    } else if (typeof value !== 'string' && value !== undefined) {
      delete frontmatter[key];
    }
  }
  return frontmatter;
}
