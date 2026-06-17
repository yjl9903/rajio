import { createReadStream } from 'node:fs';

import OpenAI from 'openai';

import type { DescriptionInfo, RuntimeConfig, Segment, SegmentsFile } from '../types.js';

export type SupportedTranscriptionModel = 'whisper-1' | 'gpt-4o-transcribe-diarize';
export type TranscriptionLanguage = 'ja';

export const TRANSCRIPTION_MODEL: SupportedTranscriptionModel = 'gpt-4o-transcribe-diarize';
export const TRANSCRIPTION_LANGUAGE: TranscriptionLanguage = 'ja';

export type TranscriptionRequestOptions =
  | {
      response_format: 'verbose_json';
      timestamp_granularities: ['segment'];
    }
  | {
      response_format: 'diarized_json';
      chunking_strategy: 'auto';
    };

export interface TranscribeInput {
  audioPath: string;
  mediaPath: string;
  description: DescriptionInfo;
  runtime: RuntimeConfig;
}

export interface TranscriptChunkResult {
  index: number;
  audioPath: string;
  start: number;
  end: number;
  model?: string;
  response: unknown;
}

export async function transcribeWithOpenAI(input: TranscribeInput): Promise<unknown> {
  const client = createClient(input.runtime);
  return client.audio.transcriptions.create({
    file: createReadStream(input.audioPath),
    model: TRANSCRIPTION_MODEL,
    language: TRANSCRIPTION_LANGUAGE,
    ...transcriptionRequestOptionsForModel(TRANSCRIPTION_MODEL)
  });
}

export function transcriptionRequestOptionsForModel(
  model: SupportedTranscriptionModel
): TranscriptionRequestOptions {
  switch (model) {
    case 'whisper-1':
      return {
        response_format: 'verbose_json',
        timestamp_granularities: ['segment']
      };
    case 'gpt-4o-transcribe-diarize':
      return {
        response_format: 'diarized_json',
        chunking_strategy: 'auto'
      };
  }
}

export function mergeTranscriptChunks(input: {
  chunks: TranscriptChunkResult[];
  generatedAt: string;
}): SegmentsFile {
  return {
    version: 1,
    source: {
      kind: 'transcript',
      generated_at: input.generatedAt
    },
    segments: input.chunks.flatMap((chunk) =>
      normalizeTranscriptSegments(chunk.response, {
        defaultSpeaker: chunk.model === 'whisper-1'
      }).map((segment, index) => ({
        ...segment,
        id: `${chunk.index + 1}-${segment.id || `s${index + 1}`}`,
        start: segment.start + chunk.start,
        end: segment.end + chunk.start
      }))
    )
  };
}

export function normalizeTranscriptSegments(
  value: unknown,
  options: { defaultSpeaker?: boolean } = {}
): Segment[] {
  const input = value as {
    text?: string;
    segments?: unknown[];
  };
  if (!Array.isArray(input.segments)) {
    throw new Error('Transcription response does not contain segments.');
  }

  return input.segments.map((segment, index) =>
    normalizeTranscriptSegment(segment, index, options)
  );
}

function normalizeTranscriptSegment(
  value: unknown,
  index: number,
  options: { defaultSpeaker?: boolean }
): Segment {
  const label = `Transcription segment ${index + 1}`;
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const { id, start, end, speaker, text } = value;
  if (id !== undefined && typeof id !== 'string' && typeof id !== 'number') {
    throw new Error(`${label} id must be a string or number.`);
  }
  if (typeof start !== 'number' || !Number.isFinite(start)) {
    throw new Error(`${label} start must be a finite number.`);
  }
  if (typeof end !== 'number' || !Number.isFinite(end)) {
    throw new Error(`${label} end must be a finite number.`);
  }
  if (speaker === undefined && !options.defaultSpeaker) {
    throw new Error(`${label} speaker must be a string.`);
  }
  if (speaker !== undefined && typeof speaker !== 'string') {
    throw new Error(`${label} speaker must be a string.`);
  }
  if (typeof text !== 'string') {
    throw new Error(`${label} text must be a string.`);
  }
  return {
    id: String(id ?? `s${index + 1}`),
    start,
    end,
    // Hack for legacy whisper-1 verbose_json: timestamped segments do not carry
    // diarization labels, but the internal Segment shape requires a speaker.
    // Diarized providers must still return speaker explicitly.
    speaker: speaker ?? 'A',
    ja: text
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function createClient(runtime: RuntimeConfig): OpenAI {
  return new OpenAI({
    apiKey: runtime.openaiApiKey,
    baseURL: runtime.openaiBaseUrl
  });
}
