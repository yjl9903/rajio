import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import { Agent, Dispatcher1Wrapper } from 'undici';

import type { Segment, SegmentWord } from '../types.js';
import type { TranscribeInput } from './types.js';
import { isRecord, segmentWords } from './utils.js';

const ELEVENLABS_TRANSCRIPTION_MODEL = 'scribe_v2';
const ELEVENLABS_TRANSCRIPTION_LANGUAGE = 'ja';
const TRANSCRIPTION_TIMEOUT_SECONDS = 3600;
// Let the SDK's request deadline fire before the transport's inactivity timeouts.
const TRANSPORT_TIMEOUT_MS = (TRANSCRIPTION_TIMEOUT_SECONDS + 60) * 1000;

export async function transcribeWithElevenLabs(input: TranscribeInput): Promise<unknown> {
  if (!input.runtime.elevenlabsApiKey) {
    throw new Error('ELEVENLABS_API_KEY is not set.');
  }

  // Node's built-in fetch can still use the legacy dispatcher handler contract.
  const dispatcher = new Dispatcher1Wrapper(
    new Agent({
      headersTimeout: TRANSPORT_TIMEOUT_MS,
      bodyTimeout: TRANSPORT_TIMEOUT_MS
    })
  );
  let transportError: unknown;
  const client = new ElevenLabsClient({
    apiKey: input.runtime.elevenlabsApiKey,
    fetch: async (url, init) => {
      transportError = undefined;
      try {
        const options: RequestInit = {
          ...init,
          // The wrapper bridges Undici 8 to the older dispatcher type in Node's fetch typings.
          dispatcher: dispatcher as unknown as RequestInit['dispatcher']
        };
        const response = await fetch(url, options);
        // The SDK reads JSON via text() and otherwise discards transport error causes.
        const readText = response.text.bind(response);
        return Object.assign(response, {
          text: async () => {
            try {
              return await readText();
            } catch (error) {
              transportError = new Error(
                `ElevenLabs response body read failed after receiving HTTP ${response.status}.`,
                { cause: error }
              );
              throw error;
            }
          }
        });
      } catch (error) {
        transportError = new Error(
          init?.signal?.aborted && init.signal.reason === 'timeout'
            ? `ElevenLabs SDK request timed out after ${TRANSCRIPTION_TIMEOUT_SECONDS} seconds before receiving HTTP response headers.`
            : 'ElevenLabs fetch failed before receiving HTTP response headers.',
          { cause: error }
        );
        throw error;
      }
    }
  });
  try {
    return await client.speechToText.convert(
      {
        file: { path: input.audioPath },
        modelId: ELEVENLABS_TRANSCRIPTION_MODEL,
        languageCode: ELEVENLABS_TRANSCRIPTION_LANGUAGE,
        diarize: true,
        timestampsGranularity: 'word'
      },
      { timeoutInSeconds: TRANSCRIPTION_TIMEOUT_SECONDS }
    );
  } catch (error) {
    throw transportError ?? error;
  } finally {
    await dispatcher.destroy();
  }
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
