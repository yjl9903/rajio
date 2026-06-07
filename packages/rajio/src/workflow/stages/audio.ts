import { copyFile, mkdir, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

import { execa } from 'execa';

import { pathExists, sha256File, toSessionRelative, writeJson } from '../../utils/fs.js';
import type {
  AudioChunkingMetadata,
  AudioChunkOptions,
  ResolvedAudioChunkOptions,
  RuntimeConfig
} from '../../types.js';
import type { Session } from '../../session/index.js';

export const MAX_OPENAI_AUDIO_BYTES = 24 * 1024 * 1024;
export const MAX_OPENAI_TRANSCRIPTION_SECONDS = 1350;
export const DEFAULT_CHUNK_SECONDS = 600;
export const DEFAULT_CHUNK_BOUNDARY_SEARCH_SECONDS = 90;
export const DEFAULT_CHUNK_SILENCE_NOISE_DB = -35;
export const DEFAULT_CHUNK_SILENCE_DURATION_SECONDS = 0.4;
export const MIN_CHUNK_TARGET_SECONDS = 60;
export const MAX_CHUNK_BOUNDARY_SEARCH_SECONDS = 300;
const MIN_CHUNK_SECONDS = 5;

export interface AudioChunk {
  start: number;
  end: number;
}

export interface AudioChunkFile extends AudioChunk {
  audioPath: string;
  size: number;
  sha256: string;
}

export interface SilenceInterval {
  start: number;
  end: number;
}

export async function runAudioStage(input: {
  session: Session;
  runtime: RuntimeConfig;
  chunking?: AudioChunkOptions;
}): Promise<void> {
  const { session, runtime } = input;
  const chunkOptions = resolveAudioChunkOptions(input.chunking);
  await mkdir(session.artifact('audio', 'chunks'), { recursive: true });
  const metadataPath = session.artifact('audio', 'metadata.json');
  const audioPath = session.artifact('audio', 'extracted.m4a');
  const chunksDir = session.artifact('audio', 'chunks');
  const mediaHash = await sha256File(session.mediaPath);

  const probe = await execa(runtime.ffprobeBin, [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    session.mediaPath
  ]);
  await writeJson(metadataPath, JSON.parse(probe.stdout));

  const expectedMediaHash =
    typeof session.state.input.media_sha256 === 'string'
      ? session.state.input.media_sha256
      : typeof session.stage('audio').media_sha256 === 'string'
        ? session.stage('audio').media_sha256
        : undefined;
  if (!(expectedMediaHash === mediaHash && (await pathExists(audioPath)))) {
    await extractAudioFile(runtime.ffmpegBin, session.mediaPath, audioPath);
  }
  const result = await createAudioChunksIfNeeded(runtime, audioPath, chunksDir, chunkOptions);

  session.setMediaHash(mediaHash);
  session.updateStage('audio', {
    metadata: toSessionRelative(session.dir, metadataPath),
    audio: toSessionRelative(session.dir, audioPath),
    chunks_dir: 'audio/chunks',
    chunks: result.chunks.map((chunk) => ({
      audio: toSessionRelative(session.dir, chunk.audioPath),
      start: chunk.start,
      end: chunk.end,
      size: chunk.size,
      sha256: chunk.sha256
    })),
    chunking: result.chunking,
    media_sha256: mediaHash
  });
}

export function resolveAudioChunkOptions(
  options: AudioChunkOptions = {}
): ResolvedAudioChunkOptions {
  const targetSeconds = options.targetSeconds ?? DEFAULT_CHUNK_SECONDS;
  const boundarySearchSeconds =
    options.boundarySearchSeconds ?? DEFAULT_CHUNK_BOUNDARY_SEARCH_SECONDS;
  const silenceNoiseDb = options.silenceNoiseDb ?? DEFAULT_CHUNK_SILENCE_NOISE_DB;
  const silenceDurationSeconds =
    options.silenceDurationSeconds ?? DEFAULT_CHUNK_SILENCE_DURATION_SECONDS;

  if (!Number.isFinite(targetSeconds) || targetSeconds < MIN_CHUNK_TARGET_SECONDS) {
    throw new Error(`--chunk-target must be at least ${MIN_CHUNK_TARGET_SECONDS} seconds.`);
  }
  if (!Number.isFinite(boundarySearchSeconds) || boundarySearchSeconds < 0) {
    throw new Error('--chunk-boundary-search must be a non-negative number.');
  }
  if (boundarySearchSeconds > MAX_CHUNK_BOUNDARY_SEARCH_SECONDS) {
    throw new Error(
      `--chunk-boundary-search must be at most ${MAX_CHUNK_BOUNDARY_SEARCH_SECONDS} seconds.`
    );
  }
  if (targetSeconds + boundarySearchSeconds > MAX_OPENAI_TRANSCRIPTION_SECONDS) {
    throw new Error(
      `--chunk-target + --chunk-boundary-search must be at most ${MAX_OPENAI_TRANSCRIPTION_SECONDS} seconds.`
    );
  }
  if (!Number.isFinite(silenceNoiseDb)) {
    throw new Error('--chunk-silence-noise must be a finite number.');
  }
  if (!Number.isFinite(silenceDurationSeconds) || silenceDurationSeconds < 0) {
    throw new Error('--chunk-silence-duration must be a non-negative number.');
  }

  return {
    targetSeconds,
    boundarySearchSeconds,
    silenceNoiseDb,
    silenceDurationSeconds
  };
}

export function audioChunkingMetadata(input: {
  options: ResolvedAudioChunkOptions;
  effectiveTargetSeconds: number;
}): AudioChunkingMetadata {
  return {
    strategy: 'silence_or_time',
    requested_target_seconds: input.options.targetSeconds,
    effective_target_seconds: input.effectiveTargetSeconds,
    boundary_search_seconds: input.options.boundarySearchSeconds,
    silence_noise_db: input.options.silenceNoiseDb,
    silence_duration_seconds: input.options.silenceDurationSeconds,
    max_seconds: MAX_OPENAI_TRANSCRIPTION_SECONDS,
    max_bytes: MAX_OPENAI_AUDIO_BYTES
  };
}

export async function listAudioChunks(chunksDir: string): Promise<string[]> {
  const entries = await readdir(chunksDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.m4a'))
    .map((entry) => path.join(chunksDir, entry.name))
    .sort((a, b) => a.localeCompare(b));
}

export async function probeAudioDuration(ffprobeBin: string, audioPath: string): Promise<number> {
  const result = await execa(ffprobeBin, [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    audioPath
  ]);
  const duration = Number(result.stdout.trim());
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

export async function createAudioChunksIfNeeded(
  runtime: RuntimeConfig,
  audioPath: string,
  chunksDir: string,
  options: ResolvedAudioChunkOptions
): Promise<{ chunks: AudioChunkFile[]; chunking: AudioChunkingMetadata }> {
  await mkdir(chunksDir, { recursive: true });
  await clearDirectoryFiles(chunksDir);
  const size = (await stat(audioPath)).size;
  const duration = await probeAudioDuration(runtime.ffprobeBin, audioPath);
  const effectiveTargetSeconds = estimateChunkSecondsForSize(size, duration, options.targetSeconds);
  const chunking = audioChunkingMetadata({ options, effectiveTargetSeconds });
  if (duration <= 0) {
    await segmentAudioByTime(runtime.ffmpegBin, audioPath, chunksDir, effectiveTargetSeconds);
    const chunks = await collectAudioChunkFiles(
      runtime.ffprobeBin,
      await assertChunkedAudio(chunksDir)
    );
    validateAudioChunkFiles(chunks, undefined);
    return { chunks, chunking };
  }

  if (size <= MAX_OPENAI_AUDIO_BYTES && duration <= MAX_OPENAI_TRANSCRIPTION_SECONDS) {
    const singleChunkPath = path.join(chunksDir, 'chunk-000.m4a');
    await copyFile(audioPath, singleChunkPath);
    const chunks = [await createChunkMetadata(singleChunkPath, 0, duration)];
    validateAudioChunkFiles(chunks, duration);
    return { chunks, chunking };
  }

  const silences = await detectSilences(runtime.ffmpegBin, audioPath, options);
  const plan = planAudioChunks(duration, silences, {
    targetSeconds: effectiveTargetSeconds,
    maxSeconds: MAX_OPENAI_TRANSCRIPTION_SECONDS,
    minSeconds: MIN_CHUNK_SECONDS,
    boundarySearchSeconds: options.boundarySearchSeconds
  });
  const chunks: AudioChunkFile[] = [];
  for (const [index, chunk] of plan.entries()) {
    const outputPath = path.join(chunksDir, `chunk-${pad(index, 3)}.m4a`);
    await extractAudioChunk(runtime.ffmpegBin, audioPath, outputPath, chunk);
    chunks.push(await createChunkMetadata(outputPath, chunk.start, chunk.end));
  }
  await assertChunkedAudio(chunksDir);
  validateAudioChunkFiles(chunks, duration);
  return { chunks, chunking };
}

async function assertChunkedAudio(chunksDir: string): Promise<string[]> {
  const chunks = await listAudioChunks(chunksDir);
  if (chunks.length === 0) {
    throw new Error('ffmpeg chunking produced no audio chunks.');
  }
  return chunks;
}

async function collectAudioChunkFiles(
  ffprobeBin: string,
  audioPaths: string[]
): Promise<AudioChunkFile[]> {
  const chunks: AudioChunkFile[] = [];
  let start = 0;
  for (const audioPath of audioPaths) {
    const duration = await probeAudioDuration(ffprobeBin, audioPath);
    const end = start + duration;
    chunks.push(await createChunkMetadata(audioPath, start, end));
    start = end;
  }
  return chunks;
}

export function planAudioChunks(
  duration: number,
  silences: SilenceInterval[],
  options: {
    targetSeconds?: number;
    maxSeconds?: number;
    minSeconds?: number;
    boundarySearchSeconds?: number;
  } = {}
): AudioChunk[] {
  if (!Number.isFinite(duration) || duration <= 0) {
    return [{ start: 0, end: 0 }];
  }

  const targetSeconds = options.targetSeconds ?? DEFAULT_CHUNK_SECONDS;
  const maxSeconds = options.maxSeconds ?? MAX_OPENAI_TRANSCRIPTION_SECONDS;
  const minSeconds = options.minSeconds ?? MIN_CHUNK_SECONDS;
  const boundarySearchSeconds =
    options.boundarySearchSeconds ?? DEFAULT_CHUNK_BOUNDARY_SEARCH_SECONDS;
  const chunks: AudioChunk[] = [];
  let start = 0;

  while (duration - start > targetSeconds + minSeconds) {
    const target = start + targetSeconds;
    const fallback = Math.min(target, start + maxSeconds, duration);
    const boundary = chooseSilenceBoundary({
      start,
      target,
      duration,
      silences,
      maxSeconds,
      minSeconds,
      boundarySearchSeconds
    });
    const end = boundary ?? fallback;
    chunks.push({ start, end });
    start = end;
  }

  chunks.push({ start, end: duration });
  return chunks;
}

export function parseSilenceDetectOutput(output: string): SilenceInterval[] {
  const silences: SilenceInterval[] = [];
  let currentStart: number | undefined;
  for (const line of output.split(/\r?\n/)) {
    const startMatch = /silence_start:\s*([0-9.]+)/.exec(line);
    if (startMatch) {
      currentStart = Number(startMatch[1]);
      continue;
    }

    const endMatch = /silence_end:\s*([0-9.]+)/.exec(line);
    if (endMatch && currentStart !== undefined) {
      const end = Number(endMatch[1]);
      if (Number.isFinite(currentStart) && Number.isFinite(end) && end > currentStart) {
        silences.push({ start: currentStart, end });
      }
      currentStart = undefined;
    }
  }
  return silences;
}

function chooseSilenceBoundary(input: {
  start: number;
  target: number;
  duration: number;
  silences: SilenceInterval[];
  maxSeconds: number;
  minSeconds: number;
  boundarySearchSeconds: number;
}): number | undefined {
  const lower = Math.max(
    input.start + input.minSeconds,
    input.target - input.boundarySearchSeconds
  );
  const upper = Math.min(
    input.start + input.maxSeconds,
    input.duration - input.minSeconds,
    input.target + input.boundarySearchSeconds
  );
  if (upper <= lower) {
    return undefined;
  }

  let best: { boundary: number; distance: number } | undefined;
  for (const silence of input.silences) {
    const boundary = (silence.start + silence.end) / 2;
    if (boundary < lower || boundary > upper) {
      continue;
    }
    const distance = Math.abs(boundary - input.target);
    if (!best || distance < best.distance) {
      best = { boundary, distance };
    }
  }
  return best?.boundary;
}

async function createChunkMetadata(
  audioPath: string,
  start: number,
  end: number
): Promise<AudioChunkFile> {
  return {
    audioPath,
    start,
    end,
    size: (await stat(audioPath)).size,
    sha256: await sha256File(audioPath)
  };
}

function estimateChunkSecondsForSize(
  size: number,
  duration: number,
  requestedTarget: number
): number {
  if (!Number.isFinite(duration) || duration <= 0 || size <= MAX_OPENAI_AUDIO_BYTES) {
    return requestedTarget;
  }
  const estimated = Math.floor((duration * MAX_OPENAI_AUDIO_BYTES * 0.9) / size);
  return clamp(estimated, MIN_CHUNK_SECONDS, requestedTarget);
}

async function detectSilences(
  ffmpegBin: string,
  audioPath: string,
  options: ResolvedAudioChunkOptions
): Promise<SilenceInterval[]> {
  const result = await execa(
    ffmpegBin,
    [
      '-hide_banner',
      '-i',
      audioPath,
      '-af',
      `silencedetect=noise=${options.silenceNoiseDb}dB:d=${options.silenceDurationSeconds}`,
      '-f',
      'null',
      '-'
    ],
    { reject: false }
  );
  if (result.exitCode !== 0) {
    return [];
  }
  return parseSilenceDetectOutput(`${result.stdout}\n${result.stderr}`);
}

export async function extractAudioFile(
  ffmpegBin: string,
  mediaPath: string,
  outputPath: string
): Promise<void> {
  await execa(ffmpegBin, ['-y', '-i', mediaPath, '-vn', '-acodec', 'aac', '-ac', '1', outputPath]);
}

export async function extractAudioRange(
  ffmpegBin: string,
  mediaPath: string,
  outputPath: string,
  chunk: AudioChunk
): Promise<void> {
  await extractAudioChunk(ffmpegBin, mediaPath, outputPath, chunk);
}

async function segmentAudioByTime(
  ffmpegBin: string,
  audioPath: string,
  chunksDir: string,
  seconds: number
): Promise<void> {
  await execa(ffmpegBin, [
    '-y',
    '-i',
    audioPath,
    '-f',
    'segment',
    '-segment_time',
    String(seconds),
    '-reset_timestamps',
    '1',
    '-c',
    'copy',
    path.join(chunksDir, 'chunk-%03d.m4a')
  ]);
}

async function extractAudioChunk(
  ffmpegBin: string,
  audioPath: string,
  outputPath: string,
  chunk: AudioChunk
): Promise<void> {
  await execa(ffmpegBin, [
    '-y',
    '-ss',
    formatSeconds(chunk.start),
    '-t',
    formatSeconds(Math.max(0, chunk.end - chunk.start)),
    '-i',
    audioPath,
    '-vn',
    '-acodec',
    'aac',
    '-ac',
    '1',
    outputPath
  ]);
}

async function clearDirectoryFiles(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isFile()) {
      await unlink(path.join(dir, entry.name));
    }
  }
}

function validateAudioChunkFiles(chunks: AudioChunkFile[], duration: number | undefined): void {
  if (chunks.length === 0) {
    throw new Error('audio chunking produced no chunks.');
  }
  let expectedStart = 0;
  const epsilon = 0.05;
  for (const [index, chunk] of chunks.entries()) {
    if (chunk.size <= 0) {
      throw new Error(`audio chunk ${index + 1} is empty.`);
    }
    if (chunk.size > MAX_OPENAI_AUDIO_BYTES) {
      throw new Error(`audio chunk ${index + 1} exceeds transcription byte limit.`);
    }
    if (chunk.end <= chunk.start) {
      throw new Error(`audio chunk ${index + 1} has invalid time range.`);
    }
    if (chunk.end - chunk.start > MAX_OPENAI_TRANSCRIPTION_SECONDS + epsilon) {
      throw new Error(`audio chunk ${index + 1} exceeds transcription duration limit.`);
    }
    if (Math.abs(chunk.start - expectedStart) > epsilon) {
      throw new Error(`audio chunk ${index + 1} does not continue the previous chunk.`);
    }
    expectedStart = chunk.end;
  }
  if (duration !== undefined && Math.abs(expectedStart - duration) > epsilon) {
    throw new Error('audio chunks do not cover the full audio duration.');
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function formatSeconds(value: number): string {
  return value.toFixed(3);
}

function pad(value: number, length: number): string {
  return String(value).padStart(length, '0');
}
