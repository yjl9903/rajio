import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { parse } from 'smol-toml';

import { readSegmentsFile } from '../segments/index.js';
import { fromSessionRelative, pathExists } from '../utils/fs.js';
import type { Session } from '../session/index.js';
import type { ClipFile, ClipListRow, ClipStatus } from './types.js';

export async function listClips(session: Session): Promise<ClipListRow[]> {
  const clipsDir = session.artifact('clips');
  if (!(await pathExists(clipsDir))) {
    return [];
  }
  const entries = await readdir(clipsDir, { withFileTypes: true });
  const rows: ClipListRow[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const clipPath = path.join(clipsDir, entry.name, 'clip.toml');
    if (!(await pathExists(clipPath))) {
      continue;
    }
    const clip = await readClipFile(clipPath);
    const clipDir = path.dirname(clipPath);
    rows.push({
      id: clip.id,
      label: clip.label ?? '',
      start: clip.start,
      end: clip.end,
      duration: Math.max(0, clip.end - clip.start),
      status: await resolveClipStatus(clipDir, clip),
      segments: await countClipSegments(clipDir, clip)
    });
  }
  return rows.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
}

export async function readClipFile(filePath: string): Promise<ClipFile> {
  return parse(await readFile(filePath, 'utf8')) as unknown as ClipFile;
}

async function countClipSegments(clipDir: string, clip: ClipFile): Promise<number | ''> {
  const segmentsPath = fromSessionRelative(clipDir, clip.segments);
  if (!(await pathExists(segmentsPath))) {
    return '';
  }
  try {
    return (await readSegmentsFile(segmentsPath)).segments.length;
  } catch {
    return '';
  }
}

async function resolveClipStatus(clipDir: string, clip: ClipFile): Promise<ClipStatus> {
  const segmentsPath = fromSessionRelative(clipDir, clip.segments);
  if (await pathExists(segmentsPath)) {
    try {
      await readSegmentsFile(segmentsPath);
      return 'done';
    } catch {
      return 'missing';
    }
  }

  let hasCheckpoint = false;
  let hasError = false;
  for (const chunk of clip.chunks ?? []) {
    if (await pathExists(fromSessionRelative(clipDir, chunk.checkpoint))) {
      hasCheckpoint = true;
    }
    const errorPath = fromSessionRelative(
      clipDir,
      chunk.checkpoint.replace(/\.toml$/, '.error.log')
    );
    if (await pathExists(errorPath)) {
      hasError = true;
    }
  }

  if (hasError) {
    return 'failed';
  }
  if (hasCheckpoint) {
    return 'partial';
  }
  return 'missing';
}
