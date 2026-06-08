import { createReadStream } from 'node:fs';

import OpenAI from 'openai';

import type { DescriptionInfo, RuntimeConfig, Segment, SegmentsFile } from '../types.js';

export type SupportedTranscriptionModel = 'whisper-1' | 'gpt-4o-transcribe-diarize';
export type TranscriptionLanguage = 'ja';

export const TRANSCRIPTION_MODEL: SupportedTranscriptionModel = 'whisper-1';
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
      normalizeTranscriptSegments(chunk.response, chunk.end - chunk.start)
        .filter((segment) => segment.ja.trim())
        .map((segment, index) => ({
          ...segment,
          id: `${chunk.index + 1}-${segment.id || `s${index + 1}`}`,
          start: segment.start + chunk.start,
          end: segment.end + chunk.start
        }))
    )
  };
}

export function normalizeTranscriptSegments(value: unknown, duration?: number): Segment[] {
  const input = value as {
    text?: string;
    segments?: Array<{
      id?: string | number;
      start: number;
      end: number;
      speaker?: string;
      text?: string;
    }>;
  };
  if (!Array.isArray(input.segments)) {
    const text = input.text?.trim();
    if (!text) {
      throw new Error('Transcription response does not contain text or segments.');
    }
    return [
      {
        id: 's1',
        start: 0,
        end: duration ?? 0,
        speaker: 'A',
        ja: text
      }
    ];
  }

  return input.segments.map((segment, index) => ({
    id: String(segment.id ?? `s${index + 1}`),
    start: Number(segment.start),
    end: Number(segment.end),
    speaker: segment.speaker || 'A',
    ja: segment.text?.trim() ?? ''
  }));
}

function createClient(runtime: RuntimeConfig): OpenAI {
  return new OpenAI({
    apiKey: runtime.openaiApiKey,
    baseURL: runtime.openaiBaseUrl
  });
}
