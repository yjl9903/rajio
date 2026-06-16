import { mkdir, readdir, readFile, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

import { parse, stringify } from 'smol-toml';

import {
  fromSessionRelative,
  pathExists,
  sha256File,
  toSessionRelative,
  writeFileAtomic
} from '../../utils/fs.js';
import { newQueue } from '../../utils/queue.js';
import {
  TRANSCRIPTION_MODEL,
  mergeTranscriptChunks,
  transcribeWithOpenAI
} from '../transcription.js';
import type { RuntimeConfig, SessionAudioChunk, StageRunnerDeps } from '../../types.js';
import type { Session } from '../../session/index.js';
import { taggedLogger } from '../../utils/logger.js';
import type { TranscriptChunkResult } from '../transcription.js';
import { MAX_OPENAI_TRANSCRIPTION_SECONDS } from './audio.js';

const TRANSCRIPTION_CHUNK_CONCURRENCY = 5;
export const TRANSCRIPTION_HEARTBEAT_INTERVAL_MS = 30_000;
const transcriptionLogger = taggedLogger('transcript_raw');

interface AudioInputChunk {
  index: number;
  audioPath: string;
  start: number;
  end: number;
}

interface RawTranscriptionChunkFile {
  version: 1;
  status: 'done';
  chunk_index: number;
  audio: string;
  start: number;
  end: number;
  model: string;
  started_at: string;
  completed_at: string;
  response: unknown;
}

interface TranscriptionHeartbeatLogger {
  info(message: string): void;
}

export async function runTranscriptRawStage(input: {
  session: Session;
  runtime: RuntimeConfig;
  deps: StageRunnerDeps;
  resetCheckpoints?: boolean;
}): Promise<void> {
  const { session, runtime, deps, resetCheckpoints = false } = input;
  const audio = session.stage('audio').audio;
  if (typeof audio !== 'string') {
    throw new Error('audio stage must produce an audio path before transcription.');
  }
  const audioPath = fromSessionRelative(session.dir, audio);
  const segmentsPath = session.artifact('transcript', 'raw', 'segments.toml');
  const chunkResultsDir = session.artifact('transcript', 'raw', 'chunks');
  const audioInputs = await collectAudioInputChunks(session, audioPath);
  const transcribe = deps.transcribe ?? transcribeWithOpenAI;

  await mkdir(chunkResultsDir, { recursive: true });
  if (resetCheckpoints) {
    await clearTranscriptionCheckpointFiles(chunkResultsDir);
  }
  await printTranscriptionUploadNotice(runtime, audioInputs);
  const chunks = await transcribeChunks({
    session,
    runtime,
    chunkResultsDir,
    audioInputs,
    transcribe
  });
  const segments = mergeTranscriptChunks({
    chunks,
    generatedAt: new Date().toISOString()
  });
  await writeFileAtomic(segmentsPath, stringify(segments));
  session.updateStage('transcript_raw', {
    input_audio: toSessionRelative(session.dir, audioPath),
    chunks_dir: toSessionRelative(session.dir, chunkResultsDir),
    chunk_count: chunks.length,
    chunk_concurrency: TRANSCRIPTION_CHUNK_CONCURRENCY,
    segments: toSessionRelative(session.dir, segmentsPath),
    segments_sha256: await sha256File(segmentsPath)
  });
}

async function collectAudioInputChunks(
  session: Session,
  audioPath: string
): Promise<AudioInputChunk[]> {
  const sessionChunks = session.audioChunks();
  if (sessionChunks.length === 0) {
    throw new Error(
      'audio stage does not include chunk metadata. Run the audio stage to regenerate chunks.'
    );
  }

  const chunks: AudioInputChunk[] = [];
  for (const [index, chunk] of sessionChunks.entries()) {
    const audioChunkPath = fromSessionRelative(session.dir, chunk.audio);
    const metadata = await validateAndNormalizeAudioChunk(audioChunkPath, chunk, audioPath, index);
    chunks.push({
      index,
      audioPath: audioChunkPath,
      start: metadata.start,
      end: metadata.end
    });
  }
  return chunks;
}

async function validateAndNormalizeAudioChunk(
  audioChunkPath: string,
  chunk: SessionAudioChunk,
  audioPath: string,
  index: number
): Promise<{ start: number; end: number }> {
  const exists = await pathExists(audioChunkPath);
  if (!exists) {
    throw new Error(
      `audio chunk file missing: ${chunk.audio} (for audio stage chunk ${index + 1}).`
    );
  }
  if (path.resolve(audioChunkPath) === path.resolve(audioPath)) {
    throw new Error(
      'audio stage chunk list must be explicit and should not point to the extracted audio file.'
    );
  }

  const size = (await stat(audioChunkPath)).size;
  if (size !== chunk.size) {
    throw new Error(`audio chunk size mismatch for ${chunk.audio}.`);
  }

  const hash = await sha256File(audioChunkPath);
  if (hash !== chunk.sha256) {
    throw new Error(`audio chunk hash mismatch for ${chunk.audio}.`);
  }
  if (chunk.end <= chunk.start) {
    throw new Error(`audio chunk time range is invalid for ${chunk.audio}.`);
  }
  if (chunk.end - chunk.start > MAX_OPENAI_TRANSCRIPTION_SECONDS) {
    throw new Error(`audio chunk duration exceeds transcription limit for ${chunk.audio}.`);
  }

  return {
    start: chunk.start,
    end: chunk.end
  };
}

async function transcribeChunks(input: {
  session: Session;
  runtime: RuntimeConfig;
  chunkResultsDir: string;
  audioInputs: AudioInputChunk[];
  transcribe: NonNullable<StageRunnerDeps['transcribe']>;
}): Promise<TranscriptChunkResult[]> {
  const queue = newQueue(TRANSCRIPTION_CHUNK_CONCURRENCY);
  const tasks = input.audioInputs.map((chunk) =>
    queue.add(() =>
      transcribeChunk({
        ...input,
        totalChunks: input.audioInputs.length,
        chunk
      })
    )
  );

  const results = await Promise.allSettled(tasks);
  await queue.done();
  const failed = results.find((result) => result.status === 'rejected');
  if (failed?.status === 'rejected') {
    throw failed.reason;
  }
  return results
    .filter(
      (result): result is PromiseFulfilledResult<TranscriptChunkResult> =>
        result.status === 'fulfilled'
    )
    .map((result) => result.value)
    .sort((a, b) => a.index - b.index);
}

async function transcribeChunk(input: {
  session: Session;
  runtime: RuntimeConfig;
  chunkResultsDir: string;
  chunk: AudioInputChunk;
  totalChunks: number;
  transcribe: NonNullable<StageRunnerDeps['transcribe']>;
}): Promise<TranscriptChunkResult> {
  const chunkPath = chunkResultPath(input.chunkResultsDir, input.chunk.index);
  const errorPath = chunkErrorPath(input.chunkResultsDir, input.chunk.index);
  if (await pathExists(chunkPath)) {
    const chunkFile = await readRawTranscriptionChunkFile(chunkPath);
    transcriptionLogger.info(
      `chunk ${input.chunk.index + 1} resume ${formatTimeRange(
        chunkFile.start,
        chunkFile.end
      )} from ${toSessionRelative(input.session.dir, chunkPath)}.`
    );
    return {
      index: chunkFile.chunk_index,
      audioPath: fromSessionRelative(input.session.dir, chunkFile.audio),
      start: input.chunk.start,
      end: input.chunk.end,
      model: chunkFile.model,
      response: chunkFile.response
    };
  }

  const startedAt = new Date().toISOString();
  transcriptionLogger.info(
    `chunk ${input.chunk.index + 1}/${input.totalChunks} start ${formatTimeRange(
      input.chunk.start,
      input.chunk.end
    )} (${toSessionRelative(input.session.dir, input.chunk.audioPath)}).`
  );
  try {
    const heartbeat = startTranscriptionHeartbeat({
      chunk: input.chunk,
      totalChunks: input.totalChunks,
      sessionDir: input.session.dir,
      logger: transcriptionLogger
    });
    let response: unknown;
    try {
      response = await input.transcribe({
        audioPath: input.chunk.audioPath,
        mediaPath: input.session.mediaPath,
        description: input.session.description,
        runtime: input.runtime
      });
    } finally {
      heartbeat.stop();
    }
    const completedAt = new Date().toISOString();
    await writeRawTranscriptionChunkFile(chunkPath, {
      version: 1,
      status: 'done',
      chunk_index: input.chunk.index,
      audio: toSessionRelative(input.session.dir, input.chunk.audioPath),
      start: input.chunk.start,
      end: input.chunk.end,
      model: TRANSCRIPTION_MODEL,
      started_at: startedAt,
      completed_at: completedAt,
      response: toTomlCompatible(response)
    });
    await unlink(errorPath).catch(() => undefined);
    transcriptionLogger.success(
      `chunk ${input.chunk.index + 1} done ${formatTimeRange(
        input.chunk.start,
        input.chunk.end
      )}; wrote ${toSessionRelative(input.session.dir, chunkPath)}.`
    );
    return {
      index: input.chunk.index,
      audioPath: input.chunk.audioPath,
      start: input.chunk.start,
      end: input.chunk.end,
      model: TRANSCRIPTION_MODEL,
      response
    };
  } catch (error) {
    const message = formatError(error);
    await writeFileAtomic(errorPath, `${new Date().toISOString()}\n${message}\n`);
    transcriptionLogger.error(
      `chunk ${input.chunk.index + 1} failed ${formatTimeRange(
        input.chunk.start,
        input.chunk.end
      )}; wrote ${toSessionRelative(input.session.dir, errorPath)}.`
    );
    throw error;
  }
}

export function startTranscriptionHeartbeat(input: {
  chunk: AudioInputChunk;
  totalChunks: number;
  sessionDir: string;
  logger: TranscriptionHeartbeatLogger;
  intervalMs?: number;
}): { stop: () => void } {
  const startedAt = Date.now();

  const timer = setInterval(() => {
    const elapsed = formatDuration((Date.now() - startedAt) / 1000);
    input.logger.info(
      `chunk ${input.chunk.index + 1}/${input.totalChunks} heartbeat ${elapsed} ${formatTimeRange(
        input.chunk.start,
        input.chunk.end
      )} (${toSessionRelative(input.sessionDir, input.chunk.audioPath)}); waiting for provider response.`
    );
  }, input.intervalMs ?? TRANSCRIPTION_HEARTBEAT_INTERVAL_MS);
  timer.unref?.();

  return {
    stop: () => {
      clearInterval(timer);
    }
  };
}

async function readRawTranscriptionChunkFile(filePath: string): Promise<RawTranscriptionChunkFile> {
  const value = parse(await readFile(filePath, 'utf8')) as unknown as RawTranscriptionChunkFile;
  if (value.status !== 'done' || typeof value.response === 'undefined') {
    throw new Error(`Invalid transcription chunk result: ${filePath}`);
  }
  return value;
}

async function writeRawTranscriptionChunkFile(
  filePath: string,
  value: RawTranscriptionChunkFile
): Promise<void> {
  await writeFileAtomic(filePath, stringify(value));
}

async function clearTranscriptionCheckpointFiles(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isFile() && /^chunk-\d+\.(toml|error\.log)$/.test(entry.name)) {
      await unlink(path.join(dir, entry.name));
    }
  }
}

async function printTranscriptionUploadNotice(
  runtime: RuntimeConfig,
  audioInputs: AudioInputChunk[]
): Promise<void> {
  transcriptionLogger.info('rajio will upload audio to an external transcription API.');
  transcriptionLogger.info(`provider: ${formatProvider(runtime)}`);
  transcriptionLogger.info(`model: ${TRANSCRIPTION_MODEL}`);
  transcriptionLogger.info(`chunk concurrency: ${TRANSCRIPTION_CHUNK_CONCURRENCY}`);
  for (const chunk of audioInputs) {
    const size = (await stat(chunk.audioPath)).size;
    transcriptionLogger.info(
      `upload chunk ${chunk.index + 1}/${audioInputs.length}: ${formatTimeRange(
        chunk.start,
        chunk.end
      )} ${chunk.audioPath} (${formatBytes(size)})`
    );
  }
}

function chunkResultPath(dir: string, index: number): string {
  return path.join(dir, `chunk-${pad(index, 3)}.toml`);
}

function chunkErrorPath(dir: string, index: number): string {
  return path.join(dir, `chunk-${pad(index, 3)}.error.log`);
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

function formatDuration(seconds: number): string {
  return formatSeconds(seconds);
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

function toTomlCompatible(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.message}\n${error.stack ?? ''}`.trim();
  }
  return String(error);
}
