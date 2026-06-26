import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

import { stringify } from 'smol-toml';

import {
  fromSessionRelative,
  pathExists,
  sha256File,
  toSessionRelative,
  writeFileAtomic
} from '../../utils/fs.js';
import { transcribeProviderInputs } from '../../transcription/provider.js';
import type { ProviderTranscriptionItem } from '../../transcription/provider.js';
import { formatBytes, formatTimeRange } from '../../transcription/run.js';
import type {
  RuntimeConfig,
  SessionAudioChunk,
  StageRunnerDeps,
  TranscriptionConfig
} from '../../types.js';
import type { Session } from '../../session/index.js';
import { taggedLogger } from '../../utils/logger.js';
import { MAX_CHUNKED_TRANSCRIPTION_SECONDS } from '../../audio/index.js';

interface AudioTranscriptionInput {
  index: number;
  audioPath: string;
  start: number;
  end: number;
}

interface TranscriptionLogger {
  info(message: string): void;
  success(message: string): void;
  error(message: string): void;
}

export async function runTranscriptRawStage(input: {
  session: Session;
  runtime: RuntimeConfig;
  deps: StageRunnerDeps;
  transcription: TranscriptionConfig;
  resetCheckpoints?: boolean;
}): Promise<void> {
  const { session, runtime, deps, transcription, resetCheckpoints = false } = input;
  const segmentsPath = session.artifact('transcript', 'raw', 'segments.toml');
  const checkpointsDir = session.artifact('transcript', 'raw', 'checkpoints');
  const audioInputs = await collectAudioInputs(session);
  const logger = taggedLogger('transcript_raw');

  await mkdir(checkpointsDir, { recursive: true });
  if (resetCheckpoints) {
    await clearTranscriptionCheckpointFiles(checkpointsDir);
  }
  await printTranscriptionUploadNotice(transcription, audioInputs, logger);
  const segments = await transcribeProviderInputs({
    session,
    runtime,
    transcription,
    items: audioInputs.map((audioInput) =>
      providerTranscriptionItem(session, checkpointsDir, audioInput, audioInputs.length)
    ),
    label: 'input',
    deps,
    logger
  });
  await writeFileAtomic(segmentsPath, stringify(segments));
  const inputAudio = session.stage('audio').audio;
  if (typeof inputAudio !== 'string') {
    throw new Error('audio stage must produce an audio path before transcription.');
  }
  session.updateStage('transcript_raw', {
    input_audio: inputAudio,
    checkpoints_dir: toSessionRelative(session.dir, checkpointsDir),
    input_count: audioInputs.length,
    segments: toSessionRelative(session.dir, segmentsPath),
    segments_sha256: await sha256File(segmentsPath)
  });
}

async function collectAudioInputs(session: Session): Promise<AudioTranscriptionInput[]> {
  const audioStage = session.stage('audio');
  const audio = audioStage.audio;
  if (typeof audio !== 'string') {
    throw new Error('audio stage must produce an audio path before transcription.');
  }
  const audioPath = fromSessionRelative(session.dir, audio);
  if (audioStage.strategy !== 'single_file') {
    return collectAudioChunkInputs(session, audioPath);
  }
  const expectedSize = Number(audioStage.audio_size);
  if (Number.isFinite(expectedSize) && (await stat(audioPath)).size !== expectedSize) {
    throw new Error(`audio file size mismatch: ${audio}.`);
  }
  if (typeof audioStage.audio_sha256 === 'string') {
    const actualHash = await sha256File(audioPath);
    if (actualHash !== audioStage.audio_sha256) {
      throw new Error(`audio file hash mismatch: ${audio}.`);
    }
  }
  const duration = Number(audioStage.duration);
  return [
    {
      index: 0,
      audioPath,
      start: 0,
      end: Number.isFinite(duration) ? duration : 0
    }
  ];
}

async function collectAudioChunkInputs(
  session: Session,
  audioPath: string
): Promise<AudioTranscriptionInput[]> {
  const sessionChunks = session.audioChunks();
  if (sessionChunks.length === 0) {
    throw new Error(
      'audio stage does not include chunk metadata. Run the audio stage to regenerate chunks.'
    );
  }

  const chunks: AudioTranscriptionInput[] = [];
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
  if (chunk.end - chunk.start > MAX_CHUNKED_TRANSCRIPTION_SECONDS) {
    throw new Error(`audio chunk duration exceeds transcription limit for ${chunk.audio}.`);
  }

  return {
    start: chunk.start,
    end: chunk.end
  };
}

function providerTranscriptionItem(
  session: Session,
  checkpointsDir: string,
  audioInput: AudioTranscriptionInput,
  totalInputs: number
): ProviderTranscriptionItem {
  return {
    index: audioInput.index,
    totalInputs,
    audioPath: audioInput.audioPath,
    checkpointAudio: toSessionRelative(session.dir, audioInput.audioPath),
    checkpointBaseDir: session.dir,
    checkpointPath: inputCheckpointPath(checkpointsDir, audioInput.index),
    errorPath: inputErrorPath(checkpointsDir, audioInput.index),
    start: audioInput.start,
    end: audioInput.end
  };
}

async function clearTranscriptionCheckpointFiles(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isFile() && /^input-\d+\.(toml|error\.log)$/.test(entry.name)) {
      await unlink(path.join(dir, entry.name));
    }
  }
}

async function printTranscriptionUploadNotice(
  transcription: TranscriptionConfig,
  audioInputs: AudioTranscriptionInput[],
  logger: TranscriptionLogger
): Promise<void> {
  logger.info('rajio will upload audio to an external transcription API.');
  logger.info(`transcription: ${transcription.provider}/${transcription.model}`);
  for (const input of audioInputs) {
    const size = (await stat(input.audioPath)).size;
    logger.info(
      `upload input ${input.index + 1}/${audioInputs.length}: ${formatTimeRange(
        input.start,
        input.end
      )} ${input.audioPath} (${formatBytes(size)})`
    );
  }
}

function inputCheckpointPath(dir: string, index: number): string {
  return path.join(dir, `input-${String(index).padStart(3, '0')}.toml`);
}

function inputErrorPath(dir: string, index: number): string {
  return path.join(dir, `input-${String(index).padStart(3, '0')}.error.log`);
}
