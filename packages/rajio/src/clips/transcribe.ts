import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { stringify } from 'smol-toml';

import type { Session } from '../session/index.js';
import type {
  AudioChunkOptions,
  RuntimeConfig,
  StageRunnerDeps,
  TranscriptionConfig
} from '../types.js';
import {
  createAudioChunksIfNeeded,
  extractAudioRange,
  resolveAudioChunkOptions
} from '../audio/index.js';
import { normalizeTranscriptionConfig, sameTranscriptionConfig } from '../transcription/config.js';
import { providerAudioStrategy, transcribeProviderInputs } from '../transcription/provider.js';
import type { ProviderTranscriptionItem } from '../transcription/provider.js';
import { formatBytes, formatTimeRange } from '../transcription/run.js';
import {
  fromSessionRelative,
  pathExists,
  sha256File,
  toSessionRelative,
  writeFileAtomic
} from '../utils/fs.js';
import { taggedLogger } from '../utils/logger.js';
import type { ClipChunkMetadata, ClipFile } from './types.js';
import { readClipFile } from './list.js';

interface ClipTranscribeInput {
  session: Session;
  runtime: RuntimeConfig;
  transcription?: TranscriptionConfig;
  start: number;
  end: number;
  label?: string;
  chunking?: AudioChunkOptions;
  deps?: StageRunnerDeps;
}

interface ClipLogger {
  info(message: string): void;
  success(message: string): void;
  error(message: string): void;
}

export async function transcribeClip(input: ClipTranscribeInput): Promise<ClipFile> {
  const logger = taggedLogger('clips');
  validateClipRange(input.start, input.end);
  const transcription = normalizeTranscriptionConfig(
    input.transcription ?? input.session.state.transcription
  );
  const chunkOptions = resolveAudioChunkOptions(input.chunking);
  const clipDir = await resolveClipDir(input.session, input.start, input.end);
  const clipPath = path.join(clipDir, 'clip.toml');
  const sourceAudioPath = path.join(clipDir, 'source.m4a');
  const checkpointsDir = path.join(clipDir, 'checkpoints');
  await mkdir(checkpointsDir, { recursive: true });

  let clip = (await pathExists(clipPath)) ? await readClipFile(clipPath) : undefined;
  const sourceMediaHash = await sha256File(input.session.mediaPath);
  if (!clip || clip.chunks.length === 0) {
    await extractAudioRange(input.runtime.ffmpegBin, input.session.mediaPath, sourceAudioPath, {
      start: input.start,
      end: input.end
    });
    const size = (await stat(sourceAudioPath)).size;
    const strategy = providerAudioStrategy(transcription);
    const chunks: Pick<ClipFile, 'strategy' | 'chunking' | 'chunks'> =
      strategy === 'silence_or_time'
        ? await createClipChunks({
            runtime: input.runtime,
            clipDir,
            audioPath: sourceAudioPath,
            sourceStart: input.start,
            options: chunkOptions
          })
        : {
            strategy,
            chunks: [
              {
                audio: 'source.m4a',
                checkpoint: 'checkpoints/input-000.toml',
                start: 0,
                end: input.end - input.start,
                absolute_start: input.start,
                absolute_end: input.end,
                size,
                sha256: await sha256File(sourceAudioPath)
              }
            ]
          };
    const now = new Date().toISOString();
    clip = {
      id: path.basename(clipDir),
      ...(input.label ? { label: input.label } : {}),
      source_media: toSessionRelative(input.session.dir, input.session.mediaPath),
      source_media_sha256: sourceMediaHash,
      source_audio: 'source.m4a',
      segments: 'segments.toml',
      created_at: now,
      updated_at: now,
      provider: transcription.provider,
      model: transcription.model,
      segmenter: transcription.segmenter,
      strategy: chunks.strategy,
      ...(chunks.chunking ? { chunking: chunks.chunking } : {}),
      start: input.start,
      end: input.end,
      chunks: chunks.chunks
    };
    await writeClipFile(clipPath, clip);
  } else {
    if (clip.source_media_sha256 !== sourceMediaHash) {
      throw new Error(
        `clip ${clip.id} was created from a different source media. Delete the clip or choose a different range.`
      );
    }
    if (!sameClipTranscription(clip, transcription)) {
      throw new Error(
        `clip ${clip.id} was created with a different transcription config. Delete the clip or choose a different range.`
      );
    }
    if (input.label) {
      clip.label = input.label;
      clip.updated_at = new Date().toISOString();
      await writeClipFile(clipPath, clip);
    }
  }

  await printClipUploadNotice({
    session: input.session,
    clipDir,
    clip,
    transcription,
    logger
  });
  const items = await transcribeClipItems({
    clipDir,
    clip
  });
  const segments = await transcribeProviderInputs({
    session: input.session,
    runtime: input.runtime,
    transcription,
    items,
    label: `clip ${clip.id} input`,
    deps: input.deps,
    logger
  });
  await writeFileAtomic(path.join(clipDir, clip.segments), stringify(segments));
  clip.updated_at = new Date().toISOString();
  await writeClipFile(clipPath, clip);
  logger.success(
    `clip ${clip.id} wrote ${toSessionRelative(input.session.dir, path.join(clipDir, clip.segments))}.`
  );
  return clip;
}

async function createClipChunks(input: {
  runtime: RuntimeConfig;
  clipDir: string;
  audioPath: string;
  sourceStart: number;
  options: ReturnType<typeof resolveAudioChunkOptions>;
}): Promise<Pick<ClipFile, 'strategy' | 'chunking' | 'chunks'>> {
  const chunksDir = path.join(input.clipDir, 'chunks');
  const { chunks, chunking } = await createAudioChunksIfNeeded(
    input.runtime,
    input.audioPath,
    chunksDir,
    input.options
  );
  return {
    strategy: 'silence_or_time',
    chunking,
    chunks: chunks.map((chunk, index) => ({
      audio: toSessionRelative(input.clipDir, chunk.audioPath),
      checkpoint: `checkpoints/input-${String(index).padStart(3, '0')}.toml`,
      start: chunk.start,
      end: chunk.end,
      absolute_start: input.sourceStart + chunk.start,
      absolute_end: input.sourceStart + chunk.end,
      size: chunk.size,
      sha256: chunk.sha256
    }))
  };
}

async function resolveClipDir(session: Session, start: number, end: number): Promise<string> {
  const clipsDir = session.artifact('clips');
  await mkdir(clipsDir, { recursive: true });
  const baseId = `clip-${formatMilliseconds(start)}-${formatMilliseconds(end)}`;
  const baseDir = path.join(clipsDir, baseId);
  const baseClipPath = path.join(baseDir, 'clip.toml');
  if (!(await pathExists(baseClipPath))) {
    return baseDir;
  }
  const existing = await readClipFile(baseClipPath);
  if (existing.start === start && existing.end === end) {
    return baseDir;
  }
  for (let suffix = 1; suffix < 1000; suffix += 1) {
    const candidate = path.join(clipsDir, `${baseId}-${String(suffix).padStart(2, '0')}`);
    if (!(await pathExists(candidate))) {
      return candidate;
    }
  }
  throw new Error(`Could not allocate a unique clip id for ${baseId}.`);
}

async function transcribeClipItems(input: {
  clipDir: string;
  clip: ClipFile;
}): Promise<ProviderTranscriptionItem[]> {
  const items: ProviderTranscriptionItem[] = [];
  for (const [index, chunk] of input.clip.chunks.entries()) {
    const audioPath = fromSessionRelative(input.clipDir, chunk.audio);
    await validateClipAudio(audioPath, chunk);
    items.push({
      index,
      totalInputs: input.clip.chunks.length,
      audioPath,
      checkpointAudio: chunk.audio,
      checkpointBaseDir: input.clipDir,
      checkpointPath: fromSessionRelative(input.clipDir, chunk.checkpoint),
      errorPath: fromSessionRelative(input.clipDir, chunk.checkpoint).replace(
        /\.toml$/,
        '.error.log'
      ),
      start: chunk.absolute_start,
      end: chunk.absolute_end
    });
  }
  return items;
}

function sameClipTranscription(clip: ClipFile, transcription: TranscriptionConfig): boolean {
  try {
    return sameTranscriptionConfig(normalizeTranscriptionConfig(clip), transcription);
  } catch {
    return false;
  }
}

async function validateClipAudio(audioPath: string, chunk: ClipChunkMetadata): Promise<void> {
  if (!(await pathExists(audioPath))) {
    throw new Error(`clip audio is missing: ${chunk.audio}.`);
  }
  const size = (await stat(audioPath)).size;
  if (size !== chunk.size) {
    throw new Error(`clip audio size mismatch: ${chunk.audio}.`);
  }
  const hash = await sha256File(audioPath);
  if (hash !== chunk.sha256) {
    throw new Error(`clip audio hash mismatch: ${chunk.audio}.`);
  }
}

async function printClipUploadNotice(input: {
  session: Session;
  clipDir: string;
  clip: ClipFile;
  transcription: TranscriptionConfig;
  logger: ClipLogger;
}): Promise<void> {
  input.logger.info(`transcribing clip: ${input.clip.id}.`);
  input.logger.info(
    `clip range: ${formatTimeRange(input.clip.start, input.clip.end)} (${formatRawRange(
      input.clip.start,
      input.clip.end
    )}s).`
  );
  input.logger.info('rajio will upload audio to an external transcription API.');
  input.logger.info(`transcription: ${input.transcription.provider}/${input.transcription.model}`);
  for (const [index, chunk] of input.clip.chunks.entries()) {
    const audioPath = fromSessionRelative(input.clipDir, chunk.audio);
    if (!(await pathExists(audioPath))) {
      throw new Error(`clip audio is missing: ${chunk.audio}.`);
    }
    const size = (await stat(audioPath)).size;
    input.logger.info(
      `upload input ${index + 1}/${input.clip.chunks.length}: ${formatTimeRange(
        chunk.absolute_start,
        chunk.absolute_end
      )} ${toSessionRelative(input.session.dir, audioPath)} (${formatBytes(size)})`
    );
  }
}

async function writeClipFile(filePath: string, clip: ClipFile): Promise<void> {
  await writeFileAtomic(filePath, stringify(clip));
}

function validateClipRange(start: number, end: number): void {
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw new Error('--start and --end must be finite numbers.');
  }
  if (start < 0) {
    throw new Error('--start must be non-negative.');
  }
  if (end <= start) {
    throw new Error('--end must be greater than --start.');
  }
}

function formatMilliseconds(value: number): string {
  return String(Math.round(value * 1000));
}

function formatRawRange(start: number, end: number): string {
  return `${formatRawSeconds(start)}-${formatRawSeconds(end)}`;
}

function formatRawSeconds(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}
