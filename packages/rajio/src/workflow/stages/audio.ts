import { copyFile, mkdir, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

import { execa } from 'execa';

import { sha256File, toSessionRelative, writeJson } from '../../utils/fs.js';
import type { RuntimeConfig } from '../../types.js';
import type { Session } from '../../session/index.js';

const MAX_OPENAI_AUDIO_BYTES = 24 * 1024 * 1024;
const MAX_OPENAI_TRANSCRIPTION_SECONDS = 1350;
const DEFAULT_CHUNK_SECONDS = 600;
const DEFAULT_CHUNK_BOUNDARY_SEARCH_SECONDS = 90;
const MIN_CHUNK_SECONDS = 5;
const SILENCE_DETECT_NOISE = '-35dB';
const SILENCE_DETECT_DURATION = 0.4;

export interface AudioChunk {
  start: number;
  end: number;
}

interface AudioChunkFile extends AudioChunk {
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
}): Promise<void> {
  const { session, runtime } = input;
  await mkdir(session.artifact('audio', 'chunks'), { recursive: true });
  const metadataPath = session.artifact('audio', 'metadata.json');
  const audioPath = session.artifact('audio', 'extracted.m4a');
  const chunksDir = session.artifact('audio', 'chunks');

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

  await execa(runtime.ffmpegBin, [
    '-y',
    '-i',
    session.mediaPath,
    '-vn',
    '-acodec',
    'aac',
    '-ac',
    '1',
    audioPath
  ]);
  const chunks = await createAudioChunksIfNeeded(runtime, audioPath, chunksDir);

  const mediaHash = await sha256File(session.mediaPath);
  session.setMediaHash(mediaHash);
  session.updateStage('audio', {
    metadata: toSessionRelative(session.dir, metadataPath),
    audio: toSessionRelative(session.dir, audioPath),
    chunks_dir: 'audio/chunks',
    chunk_count: chunks.length,
    chunks: chunks.map((chunk) => ({
      audio: toSessionRelative(session.dir, chunk.audioPath),
      start: chunk.start,
      end: chunk.end,
      size: chunk.size,
      sha256: chunk.sha256
    })),
    chunk_max_seconds: MAX_OPENAI_TRANSCRIPTION_SECONDS,
    chunk_target_seconds: DEFAULT_CHUNK_SECONDS,
    chunk_boundary: chunks.length > 1 ? 'near_silence_or_time' : 'none',
    media_sha256: mediaHash
  });
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

async function createAudioChunksIfNeeded(
  runtime: RuntimeConfig,
  audioPath: string,
  chunksDir: string
): Promise<AudioChunkFile[]> {
  await mkdir(chunksDir, { recursive: true });
  await clearDirectoryFiles(chunksDir);
  const size = (await stat(audioPath)).size;
  const duration = await probeAudioDuration(runtime.ffprobeBin, audioPath);
  if (size <= MAX_OPENAI_AUDIO_BYTES && duration <= MAX_OPENAI_TRANSCRIPTION_SECONDS) {
    const singleChunkPath = path.join(chunksDir, 'chunk-000.m4a');
    await copyFile(audioPath, singleChunkPath);
    return [await createChunkMetadata(singleChunkPath, 0, duration)];
  }

  if (duration <= 0) {
    await segmentAudioByTime(runtime.ffmpegBin, audioPath, chunksDir, DEFAULT_CHUNK_SECONDS);
    return collectAudioChunkFiles(runtime.ffprobeBin, await assertChunkedAudio(chunksDir));
  }

  const estimatedTargetSeconds = estimateChunkSecondsForSize(size, duration);
  const silences = await detectSilences(runtime.ffmpegBin, audioPath);
  const plan = planAudioChunks(duration, silences, {
    targetSeconds: estimatedTargetSeconds,
    maxSeconds: MAX_OPENAI_TRANSCRIPTION_SECONDS,
    minSeconds: MIN_CHUNK_SECONDS,
    boundarySearchSeconds: DEFAULT_CHUNK_BOUNDARY_SEARCH_SECONDS
  });
  const chunks: AudioChunkFile[] = [];
  for (const [index, chunk] of plan.entries()) {
    const outputPath = path.join(chunksDir, `chunk-${pad(index, 3)}.m4a`);
    await extractAudioChunk(runtime.ffmpegBin, audioPath, outputPath, chunk);
    chunks.push(await createChunkMetadata(outputPath, chunk.start, chunk.end));
  }
  await assertChunkedAudio(chunksDir);
  return chunks;
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

function estimateChunkSecondsForSize(size: number, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0 || size <= MAX_OPENAI_AUDIO_BYTES) {
    return DEFAULT_CHUNK_SECONDS;
  }
  const estimated = Math.floor((duration * MAX_OPENAI_AUDIO_BYTES * 0.9) / size);
  return clamp(estimated, MIN_CHUNK_SECONDS, DEFAULT_CHUNK_SECONDS);
}

async function detectSilences(ffmpegBin: string, audioPath: string): Promise<SilenceInterval[]> {
  const result = await execa(
    ffmpegBin,
    [
      '-hide_banner',
      '-i',
      audioPath,
      '-af',
      `silencedetect=noise=${SILENCE_DETECT_NOISE}:d=${SILENCE_DETECT_DURATION}`,
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function formatSeconds(value: number): string {
  return value.toFixed(3);
}

function pad(value: number, length: number): string {
  return String(value).padStart(length, '0');
}
