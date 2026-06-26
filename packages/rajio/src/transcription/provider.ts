import type { Session } from '../session/index.js';
import type {
  RuntimeConfig,
  Segment,
  SegmentsFile,
  StageRunnerDeps,
  TranscriptionConfig
} from '../types.js';
import { transcribeWithElevenLabs, normalizeElevenLabsTranscript } from './elevenlabs.js';
import { normalizeOpenAITranscript, transcribeWithOpenAI } from './openai.js';
import { transcribeCheckpointedInput } from './run.js';
import type { CheckpointedTranscriptionInput } from './run.js';
import type { TranscribeInput, TranscriptInputResult } from './types.js';
import { buildTranscriptFile } from './utils.js';

export interface ProviderTranscriptionItem extends CheckpointedTranscriptionInput {
  checkpointPath: string;
  errorPath: string;
}

type ProviderNormalize = (
  value: unknown,
  options: { offset?: number; idPrefix?: string }
) => Segment[];

interface TranscriptionLogger {
  info(message: string): void;
  success(message: string): void;
  error(message: string): void;
}

export async function transcribeProviderInputs(input: {
  session: Session;
  runtime: RuntimeConfig;
  transcription: TranscriptionConfig;
  items: ProviderTranscriptionItem[];
  label: string;
  deps?: StageRunnerDeps;
  logger: TranscriptionLogger;
  generatedAt?: string;
}): Promise<SegmentsFile> {
  const transcribe = input.deps?.transcribe ?? providerTranscribe(input.transcription);
  const results: TranscriptInputResult[] = [];
  for (const item of input.items) {
    results.push(
      await transcribeCheckpointedInput({
        session: input.session,
        runtime: input.runtime,
        transcription: input.transcription,
        item,
        checkpointPath: item.checkpointPath,
        errorPath: item.errorPath,
        label: input.label,
        transcribe,
        logger: input.logger
      })
    );
  }

  return buildTranscriptFile({
    inputs: results.sort((a, b) => a.index - b.index),
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    normalize: providerNormalize(input.transcription)
  });
}

export function providerAudioStrategy(
  transcription: TranscriptionConfig
): 'single_file' | 'silence_or_time' {
  return transcription.provider === 'openai' ? 'silence_or_time' : 'single_file';
}

function providerTranscribe(
  transcription: TranscriptionConfig
): (input: TranscribeInput) => Promise<unknown> {
  return transcription.provider === 'openai' ? transcribeWithOpenAI : transcribeWithElevenLabs;
}

function providerNormalize(transcription: TranscriptionConfig): ProviderNormalize {
  return transcription.provider === 'openai'
    ? normalizeOpenAITranscript
    : normalizeElevenLabsTranscript;
}
