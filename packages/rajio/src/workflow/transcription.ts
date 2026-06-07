import { createReadStream } from 'node:fs';

import OpenAI from 'openai';

import type { DescriptionInfo, RuntimeConfig, Segment, SegmentsFile } from '../types.js';

export const TRANSCRIPTION_MODEL = 'gpt-4o-transcribe-diarize';

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
    response_format: 'diarized_json',
    language: 'ja',
    chunking_strategy: 'auto'
  });
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
      normalizeTranscriptSegments(chunk.response)
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

export function normalizeTranscriptSegments(value: unknown): Segment[] {
  const input = value as {
    segments?: Array<{
      id?: string | number;
      start: number;
      end: number;
      speaker?: string;
      text?: string;
    }>;
  };
  if (!Array.isArray(input.segments)) {
    throw new Error('Diarized transcription response does not contain segments.');
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
