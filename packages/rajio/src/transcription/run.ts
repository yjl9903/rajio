import { unlink } from 'node:fs/promises';

import type { Session } from '../session/index.js';
import type { RuntimeConfig, StageRunnerDeps, TranscriptionConfig } from '../types.js';
import {
  fromSessionRelative,
  pathExists,
  toSessionRelative,
  writeFileAtomic
} from '../utils/fs.js';
import { readMatchingCheckpoint, writeCheckpoint } from './checkpoint.js';
import type { TranscriptInputResult } from './types.js';

export const TRANSCRIPTION_HEARTBEAT_INTERVAL_MS = 30_000;

interface TranscriptionHeartbeatLogger {
  info(message: string): void;
}

interface TranscriptionLogger extends TranscriptionHeartbeatLogger {
  success(message: string): void;
  error(message: string): void;
}

export interface CheckpointedTranscriptionInput {
  index: number;
  totalInputs: number;
  audioPath: string;
  checkpointAudio: string;
  checkpointBaseDir: string;
  start: number;
  end: number;
}

export async function transcribeCheckpointedInput(input: {
  session: Session;
  runtime: RuntimeConfig;
  transcription: TranscriptionConfig;
  item: CheckpointedTranscriptionInput;
  checkpointPath: string;
  errorPath: string;
  label: string;
  transcribe: NonNullable<StageRunnerDeps['transcribe']>;
  logger: TranscriptionLogger;
}): Promise<TranscriptInputResult> {
  const { item } = input;
  const checkpoint = (await pathExists(input.checkpointPath))
    ? await readMatchingCheckpoint(input.checkpointPath, input.transcription)
    : undefined;
  if (
    checkpoint &&
    checkpoint.input_index === item.index &&
    checkpoint.audio === item.checkpointAudio &&
    checkpoint.start === item.start &&
    checkpoint.end === item.end
  ) {
    input.logger.info(
      `${input.label} ${item.index + 1} resume ${formatTimeRange(
        checkpoint.start,
        checkpoint.end
      )} from ${toSessionRelative(input.session.dir, input.checkpointPath)}.`
    );
    return {
      index: checkpoint.input_index,
      audioPath: fromSessionRelative(item.checkpointBaseDir, checkpoint.audio),
      start: checkpoint.start,
      end: checkpoint.end,
      response: checkpoint.response
    };
  }

  const startedAt = new Date().toISOString();
  input.logger.info(
    `${input.label} ${item.index + 1}/${item.totalInputs} start ${formatTimeRange(
      item.start,
      item.end
    )} (${toSessionRelative(input.session.dir, item.audioPath)}).`
  );
  try {
    const heartbeat = startTranscriptionHeartbeat({
      input: item,
      totalInputs: item.totalInputs,
      sessionDir: input.session.dir,
      logger: input.logger
    });
    let response: unknown;
    try {
      response = await input.transcribe({
        audioPath: item.audioPath,
        mediaPath: input.session.mediaPath,
        description: input.session.description,
        runtime: input.runtime,
        transcription: input.transcription
      });
    } finally {
      heartbeat.stop();
    }
    const completedAt = new Date().toISOString();
    await writeCheckpoint(input.checkpointPath, {
      version: 1,
      status: 'done',
      input_index: item.index,
      audio: item.checkpointAudio,
      start: item.start,
      end: item.end,
      provider: input.transcription.provider,
      model: input.transcription.model,
      segmenter: input.transcription.segmenter,
      started_at: startedAt,
      completed_at: completedAt,
      response
    });
    await unlink(input.errorPath).catch(() => undefined);
    input.logger.success(
      `${input.label} ${item.index + 1} done ${formatTimeRange(
        item.start,
        item.end
      )}; wrote ${toSessionRelative(input.session.dir, input.checkpointPath)}.`
    );
    return {
      index: item.index,
      audioPath: item.audioPath,
      start: item.start,
      end: item.end,
      response
    };
  } catch (error) {
    await writeFileAtomic(input.errorPath, `${new Date().toISOString()}\n${formatError(error)}\n`);
    input.logger.error(
      `${input.label} ${item.index + 1} failed ${formatTimeRange(
        item.start,
        item.end
      )}; wrote ${toSessionRelative(input.session.dir, input.errorPath)}.`
    );
    throw error;
  }
}

export function startTranscriptionHeartbeat(input: {
  input: Pick<CheckpointedTranscriptionInput, 'index' | 'audioPath' | 'start' | 'end'>;
  totalInputs: number;
  sessionDir: string;
  logger: TranscriptionHeartbeatLogger;
  intervalMs?: number;
}): { stop: () => void } {
  const startedAt = Date.now();

  const timer = setInterval(() => {
    const elapsed = formatSeconds((Date.now() - startedAt) / 1000);
    input.logger.info(
      `input ${input.input.index + 1}/${input.totalInputs} heartbeat ${elapsed} ${formatTimeRange(
        input.input.start,
        input.input.end
      )} (${toSessionRelative(input.sessionDir, input.input.audioPath)}); waiting for provider response.`
    );
  }, input.intervalMs ?? TRANSCRIPTION_HEARTBEAT_INTERVAL_MS);
  timer.unref?.();

  return {
    stop: () => {
      clearInterval(timer);
    }
  };
}

export function formatBytes(bytes: number): string {
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

export function formatTimeRange(start: number, end: number): string {
  return `${formatSeconds(start)}-${formatSeconds(end)}`;
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
