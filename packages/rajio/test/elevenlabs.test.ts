import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { transcribeWithElevenLabs } from '../src/transcription/elevenlabs.js';
import type { TranscribeInput } from '../src/transcription/types.js';

describe('ElevenLabs request errors', () => {
  let dir: string;
  let input: TranscribeInput;

  beforeEach(async () => {
    vi.useFakeTimers();
    dir = await mkdtemp(path.join(tmpdir(), 'rajio-elevenlabs-test-'));
    const audioPath = path.join(dir, 'audio.wav');
    await writeFile(audioPath, 'test audio');
    input = {
      audioPath,
      mediaPath: audioPath,
      description: { body: '', frontmatter: {} },
      runtime: { elevenlabsApiKey: 'test-key', ffmpegBin: 'ffmpeg', ffprobeBin: 'ffprobe' },
      transcription: { provider: 'elevenlabs', model: 'scribe_v2', segmenter: 'integrated' }
    };
  });

  afterEach(async () => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  });

  it('identifies a fetch failure without losing the transport cause', async () => {
    const cause = Object.assign(new Error('Headers Timeout Error'), {
      code: 'UND_ERR_HEADERS_TIMEOUT'
    });
    const error = new TypeError('fetch failed', { cause });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(error));

    await expect(transcribeWithElevenLabs(input)).rejects.toMatchObject({
      message: 'ElevenLabs fetch failed before receiving HTTP response headers.',
      cause: error
    });
  });

  it('identifies SDK deadline expiry even when fetch rejects with a string', async () => {
    const started = Promise.withResolvers<void>();
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: unknown, options: RequestInit) => {
        started.resolve();
        return new Promise((_resolve, reject) => {
          options.signal!.addEventListener('abort', () => reject(options.signal!.reason), {
            once: true
          });
        });
      })
    );

    const result = expect(transcribeWithElevenLabs(input)).rejects.toMatchObject({
      message:
        'ElevenLabs SDK request timed out after 3600 seconds before receiving HTTP response headers.',
      cause: 'timeout'
    });
    await started.promise;
    await vi.advanceTimersByTimeAsync(3_600_000);
    await result;
  });

  it('reports the received HTTP status when reading the response body fails', async () => {
    const error = new TypeError('terminated', {
      cause: Object.assign(new Error('Body Timeout Error'), { code: 'UND_ERR_BODY_TIMEOUT' })
    });
    const response = new Response(null, { status: 200 });
    vi.spyOn(response, 'text').mockRejectedValue(error);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));

    await expect(transcribeWithElevenLabs(input)).rejects.toMatchObject({
      message: 'ElevenLabs response body read failed after receiving HTTP 200.',
      cause: error
    });
  });

  it('preserves HTTP error status and response body from the API', async () => {
    const body = { detail: { status: 'invalid_parameters', message: 'Invalid audio.' } };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(body), {
          status: 400,
          headers: { 'content-type': 'application/json' }
        })
      )
    );

    await expect(transcribeWithElevenLabs(input)).rejects.toMatchObject({
      statusCode: 400,
      body
    });
  });
});
