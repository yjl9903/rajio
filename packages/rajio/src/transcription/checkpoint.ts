import { readFile } from 'node:fs/promises';

import { parse, stringify } from 'smol-toml';

import { writeFileAtomic } from '../utils/fs.js';
import type { TranscriptionConfig } from '../types.js';
import { sameTranscriptionConfig } from './config.js';

export interface TranscriptionCheckpoint {
  version: 1;
  status: 'done';
  input_index: number;
  audio: string;
  start: number;
  end: number;
  provider: TranscriptionConfig['provider'];
  model: TranscriptionConfig['model'];
  segmenter: TranscriptionConfig['segmenter'];
  started_at: string;
  completed_at: string;
  response: unknown;
}

export async function readMatchingCheckpoint(
  filePath: string,
  transcription: TranscriptionConfig
): Promise<TranscriptionCheckpoint | undefined> {
  const value = parse(await readFile(filePath, 'utf8')) as unknown as TranscriptionCheckpoint;
  if (value.status !== 'done' || typeof value.response === 'undefined') {
    throw new Error(`Invalid transcription checkpoint: ${filePath}`);
  }
  if (!sameTranscriptionConfig(value, transcription)) {
    return undefined;
  }
  return value;
}

export async function writeCheckpoint(
  filePath: string,
  value: TranscriptionCheckpoint
): Promise<void> {
  await writeFileAtomic(filePath, stringify(toTomlCompatible(value)));
}

function toTomlCompatible<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
