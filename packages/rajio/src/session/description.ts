import { readFile } from 'node:fs/promises';

import matter from 'gray-matter';

import type { DescriptionInfo } from '../types.js';

export async function readDescription(filePath: string | undefined): Promise<DescriptionInfo> {
  if (!filePath) {
    return { body: '', frontmatter: {} };
  }

  const parsed = matter(await readFile(filePath, 'utf8'));
  return {
    path: filePath,
    body: parsed.content.trim(),
    frontmatter: normalizeFrontmatter(parsed.data)
  };
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
