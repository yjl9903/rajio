import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';

import type { Segment, SegmentWord } from '../types.js';
import type { TranscribeInput } from './types.js';
import { isRecord, segmentWords } from './utils.js';

const ELEVENLABS_TRANSCRIPTION_MODEL = 'scribe_v2';
const ELEVENLABS_TRANSCRIPTION_LANGUAGE = 'ja';

export async function transcribeWithElevenLabs(input: TranscribeInput): Promise<unknown> {
  if (!input.runtime.elevenlabsApiKey) {
    throw new Error('ELEVENLABS_API_KEY is not set.');
  }

  const client = new ElevenLabsClient({ apiKey: input.runtime.elevenlabsApiKey });
  return client.speechToText.convert({
    file: { path: input.audioPath },
    modelId: ELEVENLABS_TRANSCRIPTION_MODEL,
    languageCode: ELEVENLABS_TRANSCRIPTION_LANGUAGE,
    diarize: true,
    timestampsGranularity: 'word'
  });
}

export function normalizeElevenLabsTranscript(
  value: unknown,
  options: { offset?: number; idPrefix?: string } = {}
): Segment[] {
  const input = value as { words?: unknown[] };
  if (!Array.isArray(input.words)) {
    throw new Error('ElevenLabs transcription response does not contain words.');
  }
  const words = input.words.flatMap((word) => normalizeElevenLabsWord(word, options.offset ?? 0));
  return segmentWords(words, options.idPrefix ?? '1');
}

function normalizeElevenLabsWord(value: unknown, offset: number): SegmentWord[] {
  if (!isRecord(value)) {
    return [];
  }
  if (typeof value.text !== 'string') {
    return [];
  }
  const start = Number(value.start);
  const end = Number(value.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return [];
  }

  const speaker =
    typeof value.speakerId === 'string'
      ? value.speakerId
      : typeof value.speaker_id === 'string'
        ? value.speaker_id
        : undefined;
  const type = typeof value.type === 'string' ? value.type : undefined;
  const logprob = Number(value.logprob);
  return [
    {
      text: value.text,
      start: start + offset,
      end: end + offset,
      ...(speaker ? { speaker } : {}),
      ...(Number.isFinite(logprob) ? { confidence: Math.exp(logprob) } : {}),
      ...(type ? { type } : {})
    }
  ];
}
