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
import { extractAudioRange, resolveAudioChunkOptions } from '../audio/index.js';
import { mergeElevenLabsInputs, transcribeWithElevenLabs } from '../transcription/elevenlabs.js';
import type { TranscriptInputResult } from '../transcription/types.js';
import { normalizeTranscriptionConfig } from '../transcription/config.js';
import { formatBytes, formatTimeRange, transcribeCheckpointedInput } from '../transcription/run.js';
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
  if (input.chunking) {
    resolveAudioChunkOptions(input.chunking);
  }
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
      strategy: 'single_file',
      start: input.start,
      end: input.end,
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
  const inputs = await transcribeClipInputs({
    session: input.session,
    runtime: input.runtime,
    transcription,
    clipDir,
    clip,
    transcribe: input.deps?.transcribe ?? transcribeWithElevenLabs,
    logger
  });
  const segments = mergeElevenLabsInputs({
    inputs,
    generatedAt: new Date().toISOString()
  });
  await writeFileAtomic(path.join(clipDir, clip.segments), stringify(segments));
  clip.updated_at = new Date().toISOString();
  await writeClipFile(clipPath, clip);
  logger.success(
    `clip ${clip.id} wrote ${toSessionRelative(input.session.dir, path.join(clipDir, clip.segments))}.`
  );
  return clip;
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

async function transcribeClipInputs(input: {
  session: Session;
  runtime: RuntimeConfig;
  transcription: TranscriptionConfig;
  clipDir: string;
  clip: ClipFile;
  transcribe: NonNullable<StageRunnerDeps['transcribe']>;
  logger: ClipLogger;
}): Promise<TranscriptInputResult[]> {
  const results: TranscriptInputResult[] = [];
  for (const [index, chunk] of input.clip.chunks.entries()) {
    results.push(
      await transcribeClipInput({
        ...input,
        chunk,
        index,
        totalInputs: input.clip.chunks.length
      })
    );
  }
  return results.sort((a, b) => a.index - b.index);
}

function sameClipTranscription(clip: ClipFile, transcription: TranscriptionConfig): boolean {
  return (
    (clip.provider ?? 'elevenlabs') === transcription.provider &&
    clip.model === transcription.model &&
    (clip.segmenter ?? 'integrated') === transcription.segmenter
  );
}

async function transcribeClipInput(input: {
  session: Session;
  runtime: RuntimeConfig;
  transcription: TranscriptionConfig;
  clipDir: string;
  clip: ClipFile;
  chunk: ClipChunkMetadata;
  index: number;
  totalInputs: number;
  transcribe: NonNullable<StageRunnerDeps['transcribe']>;
  logger: ClipLogger;
}): Promise<TranscriptInputResult> {
  const checkpointPath = fromSessionRelative(input.clipDir, input.chunk.checkpoint);
  const errorPath = checkpointPath.replace(/\.toml$/, '.error.log');
  const audioPath = fromSessionRelative(input.clipDir, input.chunk.audio);
  await validateClipAudio(audioPath, input.chunk);
  return transcribeCheckpointedInput({
    session: input.session,
    runtime: input.runtime,
    transcription: input.transcription,
    item: {
      index: input.index,
      totalInputs: input.totalInputs,
      audioPath,
      checkpointAudio: input.chunk.audio,
      checkpointBaseDir: input.clipDir,
      start: input.chunk.absolute_start,
      end: input.chunk.absolute_end
    },
    checkpointPath,
    errorPath,
    label: `clip ${input.clip.id} input`,
    transcribe: input.transcribe,
    logger: input.logger
  });
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
