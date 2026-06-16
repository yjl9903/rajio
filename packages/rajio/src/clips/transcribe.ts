import { mkdir, readFile, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

import { parse, stringify } from 'smol-toml';

import type { Session } from '../session/index.js';
import type { AudioChunkOptions, RuntimeConfig, StageRunnerDeps } from '../types.js';
import {
  createAudioChunksIfNeeded,
  extractAudioRange,
  resolveAudioChunkOptions
} from '../workflow/stages/audio.js';
import { startTranscriptionHeartbeat } from '../workflow/stages/transcription.js';
import {
  TRANSCRIPTION_MODEL,
  mergeTranscriptChunks,
  transcribeWithOpenAI
} from '../workflow/transcription.js';
import type { TranscriptChunkResult } from '../workflow/transcription.js';
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

const clipLogger = taggedLogger('clips');

interface ClipTranscribeInput {
  session: Session;
  runtime: RuntimeConfig;
  start: number;
  end: number;
  label?: string;
  chunking?: AudioChunkOptions;
  deps?: StageRunnerDeps;
}

interface ClipChunkFile {
  version: 1;
  status: 'done';
  chunk_index: number;
  audio: string;
  start: number;
  end: number;
  absolute_start: number;
  absolute_end: number;
  model: string;
  started_at: string;
  completed_at: string;
  response: unknown;
}

export async function transcribeClip(input: ClipTranscribeInput): Promise<ClipFile> {
  validateClipRange(input.start, input.end);
  const options = resolveAudioChunkOptions(input.chunking);
  const clipDir = await resolveClipDir(input.session, input.start, input.end, options);
  const clipPath = path.join(clipDir, 'clip.toml');
  const sourceAudioPath = path.join(clipDir, 'source.m4a');
  const chunksDir = path.join(clipDir, 'chunks');
  await mkdir(chunksDir, { recursive: true });

  let clip = (await pathExists(clipPath)) ? await readClipFile(clipPath) : undefined;
  const sourceMediaHash = await sha256File(input.session.mediaPath);
  if (!clip || clip.chunks.length === 0) {
    await extractAudioRange(input.runtime.ffmpegBin, input.session.mediaPath, sourceAudioPath, {
      start: input.start,
      end: input.end
    });
    const chunkResult = await createAudioChunksIfNeeded(
      input.runtime,
      sourceAudioPath,
      chunksDir,
      options
    );
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
      model: TRANSCRIPTION_MODEL,
      start: input.start,
      end: input.end,
      chunking: chunkResult.chunking,
      chunks: chunkResult.chunks.map((chunk, index) =>
        toClipChunkMetadata(clipDir, chunk, index, input.start)
      )
    };
    await writeClipFile(clipPath, clip);
  } else {
    if (clip.source_media_sha256 !== sourceMediaHash) {
      throw new Error(
        `clip ${clip.id} was created from a different source media. Delete the clip or choose a different range.`
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
    runtime: input.runtime,
    clipDir,
    clip
  });
  const chunks = await transcribeClipChunks({
    session: input.session,
    runtime: input.runtime,
    clipDir,
    clip,
    transcribe: input.deps?.transcribe ?? transcribeWithOpenAI
  });
  const segments = mergeTranscriptChunks({
    chunks,
    generatedAt: new Date().toISOString()
  });
  await writeFileAtomic(path.join(clipDir, clip.segments), stringify(segments));
  clip.updated_at = new Date().toISOString();
  await writeClipFile(clipPath, clip);
  clipLogger.success(
    `clip ${clip.id} wrote ${toSessionRelative(input.session.dir, path.join(clipDir, clip.segments))}.`
  );
  return clip;
}

async function resolveClipDir(
  session: Session,
  start: number,
  end: number,
  options: ReturnType<typeof resolveAudioChunkOptions>
): Promise<string> {
  const clipsDir = session.artifact('clips');
  await mkdir(clipsDir, { recursive: true });
  const baseId = `clip-${formatMilliseconds(start)}-${formatMilliseconds(end)}`;
  const baseDir = path.join(clipsDir, baseId);
  const baseClipPath = path.join(baseDir, 'clip.toml');
  if (!(await pathExists(baseClipPath))) {
    return baseDir;
  }
  const existing = await readClipFile(baseClipPath);
  if (
    existing.start === start &&
    existing.end === end &&
    existing.chunking.requested_target_seconds === options.targetSeconds &&
    existing.chunking.boundary_search_seconds === options.boundarySearchSeconds &&
    existing.chunking.silence_noise_db === options.silenceNoiseDb &&
    existing.chunking.silence_duration_seconds === options.silenceDurationSeconds
  ) {
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

function toClipChunkMetadata(
  clipDir: string,
  chunk: { audioPath: string; start: number; end: number; size: number; sha256: string },
  index: number,
  clipStart: number
): ClipChunkMetadata {
  return {
    audio: toSessionRelative(clipDir, chunk.audioPath),
    checkpoint: `chunks/chunk-${String(index).padStart(3, '0')}.toml`,
    start: chunk.start,
    end: chunk.end,
    absolute_start: clipStart + chunk.start,
    absolute_end: clipStart + chunk.end,
    size: chunk.size,
    sha256: chunk.sha256
  };
}

async function transcribeClipChunks(input: {
  session: Session;
  runtime: RuntimeConfig;
  clipDir: string;
  clip: ClipFile;
  transcribe: NonNullable<StageRunnerDeps['transcribe']>;
}): Promise<TranscriptChunkResult[]> {
  const results: TranscriptChunkResult[] = [];
  for (const [index, chunk] of input.clip.chunks.entries()) {
    results.push(
      await transcribeClipChunk({
        ...input,
        chunk,
        index,
        totalChunks: input.clip.chunks.length
      })
    );
  }
  return results.sort((a, b) => a.index - b.index);
}

async function transcribeClipChunk(input: {
  session: Session;
  runtime: RuntimeConfig;
  clipDir: string;
  clip: ClipFile;
  chunk: ClipChunkMetadata;
  index: number;
  totalChunks: number;
  transcribe: NonNullable<StageRunnerDeps['transcribe']>;
}): Promise<TranscriptChunkResult> {
  const checkpointPath = fromSessionRelative(input.clipDir, input.chunk.checkpoint);
  const errorPath = checkpointPath.replace(/\.toml$/, '.error.log');
  if (await pathExists(checkpointPath)) {
    const checkpoint = await readClipChunkFile(checkpointPath);
    clipLogger.info(
      `clip ${input.clip.id} chunk ${input.index + 1} resume ${formatTimeRange(
        checkpoint.absolute_start,
        checkpoint.absolute_end
      )} from ${toSessionRelative(input.session.dir, checkpointPath)}.`
    );
    return {
      index: checkpoint.chunk_index,
      audioPath: fromSessionRelative(input.clipDir, checkpoint.audio),
      start: checkpoint.absolute_start,
      end: checkpoint.absolute_end,
      model: checkpoint.model,
      response: checkpoint.response
    };
  }

  const audioPath = fromSessionRelative(input.clipDir, input.chunk.audio);
  await validateClipChunkAudio(audioPath, input.chunk);
  const startedAt = new Date().toISOString();
  clipLogger.info(
    `clip ${input.clip.id} chunk ${input.index + 1}/${input.totalChunks} start ${formatTimeRange(
      input.chunk.absolute_start,
      input.chunk.absolute_end
    )} (${toSessionRelative(input.session.dir, audioPath)}).`
  );
  try {
    const heartbeat = startTranscriptionHeartbeat({
      chunk: {
        index: input.index,
        audioPath,
        start: input.chunk.absolute_start,
        end: input.chunk.absolute_end
      },
      totalChunks: input.totalChunks,
      sessionDir: input.session.dir,
      logger: clipLogger
    });
    let response: unknown;
    try {
      response = await input.transcribe({
        audioPath,
        mediaPath: input.session.mediaPath,
        description: input.session.description,
        runtime: input.runtime
      });
    } finally {
      heartbeat.stop();
    }
    const completedAt = new Date().toISOString();
    await writeClipChunkFile(checkpointPath, {
      version: 1,
      status: 'done',
      chunk_index: input.index,
      audio: input.chunk.audio,
      start: input.chunk.start,
      end: input.chunk.end,
      absolute_start: input.chunk.absolute_start,
      absolute_end: input.chunk.absolute_end,
      model: TRANSCRIPTION_MODEL,
      started_at: startedAt,
      completed_at: completedAt,
      response: toTomlCompatible(response)
    });
    await unlink(errorPath).catch(() => undefined);
    clipLogger.success(
      `clip ${input.clip.id} chunk ${input.index + 1} done ${formatTimeRange(
        input.chunk.absolute_start,
        input.chunk.absolute_end
      )}; wrote ${toSessionRelative(input.session.dir, checkpointPath)}.`
    );
    return {
      index: input.index,
      audioPath,
      start: input.chunk.absolute_start,
      end: input.chunk.absolute_end,
      model: TRANSCRIPTION_MODEL,
      response
    };
  } catch (error) {
    await writeFileAtomic(errorPath, `${new Date().toISOString()}\n${formatError(error)}\n`);
    clipLogger.error(
      `clip ${input.clip.id} chunk ${input.index + 1} failed ${formatTimeRange(
        input.chunk.absolute_start,
        input.chunk.absolute_end
      )}; wrote ${toSessionRelative(input.session.dir, errorPath)}.`
    );
    throw error;
  }
}

async function validateClipChunkAudio(audioPath: string, chunk: ClipChunkMetadata): Promise<void> {
  if (!(await pathExists(audioPath))) {
    throw new Error(`clip chunk audio is missing: ${chunk.audio}.`);
  }
  const size = (await stat(audioPath)).size;
  if (size !== chunk.size) {
    throw new Error(`clip chunk size mismatch: ${chunk.audio}.`);
  }
  const hash = await sha256File(audioPath);
  if (hash !== chunk.sha256) {
    throw new Error(`clip chunk hash mismatch: ${chunk.audio}.`);
  }
}

async function printClipUploadNotice(input: {
  session: Session;
  runtime: RuntimeConfig;
  clipDir: string;
  clip: ClipFile;
}): Promise<void> {
  clipLogger.info(`transcribing clip: ${input.clip.id}.`);
  clipLogger.info(
    `clip range: ${formatTimeRange(input.clip.start, input.clip.end)} (${formatRawRange(
      input.clip.start,
      input.clip.end
    )}s).`
  );
  clipLogger.info('rajio will upload audio to an external transcription API.');
  clipLogger.info(`provider: ${formatProvider(input.runtime)}`);
  clipLogger.info(`model: ${TRANSCRIPTION_MODEL}`);
  clipLogger.info('chunk concurrency: 1');
  for (const [index, chunk] of input.clip.chunks.entries()) {
    const audioPath = fromSessionRelative(input.clipDir, chunk.audio);
    const size = (await stat(audioPath)).size;
    clipLogger.info(
      `upload chunk ${index + 1}/${input.clip.chunks.length}: ${formatTimeRange(
        chunk.absolute_start,
        chunk.absolute_end
      )} ${toSessionRelative(input.session.dir, audioPath)} (${formatBytes(size)})`
    );
  }
}

async function readClipChunkFile(filePath: string): Promise<ClipChunkFile> {
  const value = parse(await readFile(filePath, 'utf8')) as unknown as ClipChunkFile;
  if (value.status !== 'done' || typeof value.response === 'undefined') {
    throw new Error(`Invalid clip chunk checkpoint: ${filePath}`);
  }
  return value;
}

async function writeClipFile(filePath: string, clip: ClipFile): Promise<void> {
  await writeFileAtomic(filePath, stringify(clip));
}

async function writeClipChunkFile(filePath: string, value: ClipChunkFile): Promise<void> {
  await writeFileAtomic(filePath, stringify(value));
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

function toTomlCompatible(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function formatProvider(runtime: RuntimeConfig): string {
  return runtime.openaiBaseUrl
    ? `OpenAI-compatible (${runtime.openaiBaseUrl})`
    : 'OpenAI (default API endpoint)';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = units[0];
  for (const candidate of units) {
    unit = candidate;
    if (value < 1024 || candidate === units[units.length - 1]) {
      break;
    }
    value /= 1024;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

function formatTimeRange(start: number, end: number): string {
  return `${formatSeconds(start)}-${formatSeconds(end)}`;
}

function formatRawRange(start: number, end: number): string {
  return `${formatRawSeconds(start)}-${formatRawSeconds(end)}`;
}

function formatRawSeconds(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

function formatSeconds(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const s = total % 60;
  const totalMinutes = Math.floor(total / 60);
  const m = totalMinutes % 60;
  const h = Math.floor(totalMinutes / 60);
  return h > 0 ? `${h}:${pad(m, 2)}:${pad(s, 2)}` : `${String(m).padStart(2, '0')}:${pad(s, 2)}`;
}

function pad(value: number, length: number): string {
  return String(value).padStart(length, '0');
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.message}\n${error.stack ?? ''}`.trim();
  }
  return String(error);
}
