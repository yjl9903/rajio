import { createReadStream } from 'node:fs';

import OpenAI from 'openai';

import type { Segment, SegmentWord } from '../types.js';
import type { TranscribeInput } from './types.js';
import { isRecord, segmentWords } from './utils.js';

const OPENAI_TRANSCRIPTION_LANGUAGE = 'ja';

export async function transcribeWithOpenAI(input: TranscribeInput): Promise<unknown> {
  if (!input.runtime.openaiApiKey) {
    throw new Error('OPENAI_API_KEY is not set.');
  }

  const client = new OpenAI({
    apiKey: input.runtime.openaiApiKey,
    baseURL: input.runtime.openaiBaseUrl
  });
  return client.audio.transcriptions.create({
    file: createReadStream(input.audioPath),
    model: input.transcription.model,
    language: OPENAI_TRANSCRIPTION_LANGUAGE,
    response_format: 'verbose_json',
    timestamp_granularities: ['word']
  });
}

export function normalizeOpenAITranscript(
  value: unknown,
  options: { offset?: number; idPrefix?: string } = {}
): Segment[] {
  const input = value as { words?: unknown[]; segments?: unknown[] };
  const offset = options.offset ?? 0;
  if (Array.isArray(input.words) && input.words.length > 0) {
    return segmentWords(
      input.words.flatMap((word) => normalizeOpenAIWord(word, offset)),
      options.idPrefix ?? '1'
    );
  }
  if (Array.isArray(input.segments) && input.segments.length > 0) {
    return input.segments.flatMap((segment, index) =>
      normalizeOpenAISegment(segment, {
        offset,
        id: `${options.idPrefix ?? '1'}-s${index + 1}`
      })
    );
  }
  throw new Error('OpenAI transcription response does not contain words or segments.');
}

function normalizeOpenAIWord(value: unknown, offset: number): SegmentWord[] {
  if (!isRecord(value)) {
    return [];
  }
  const text =
    typeof value.word === 'string'
      ? value.word
      : typeof value.text === 'string'
        ? value.text
        : undefined;
  const start = Number(value.start);
  const end = Number(value.end);
  if (!text || !Number.isFinite(start) || !Number.isFinite(end)) {
    return [];
  }
  return [{ text, start: start + offset, end: end + offset, speaker: 'speaker_0', type: 'word' }];
}

function normalizeOpenAISegment(
  value: unknown,
  options: { offset: number; id: string }
): Segment[] {
  if (!isRecord(value) || typeof value.text !== 'string') {
    return [];
  }
  const start = Number(value.start);
  const end = Number(value.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return [];
  }
  return [
    {
      id: options.id,
      start: start + options.offset,
      end: end + options.offset,
      speaker: 'speaker_0',
      ja: value.text.trim()
    }
  ];
}
