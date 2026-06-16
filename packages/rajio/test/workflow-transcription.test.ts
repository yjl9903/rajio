import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { Session } from '../src/index.js';
import { readSegmentsFile } from '../src/segments/index.js';
import { sha256File } from '../src/utils/fs.js';
import {
  runTranscriptRawStage,
  startTranscriptionHeartbeat
} from '../src/workflow/stages/transcription.js';
import {
  mergeTranscriptChunks,
  transcriptionRequestOptionsForModel
} from '../src/workflow/transcription.js';
import { baseSession, fakeFfprobeBin, preparedSession, tempDir } from './helpers.js';

describe('transcript raw stage', () => {
  it('maps supported transcription models to their API request options', () => {
    expect(transcriptionRequestOptionsForModel('whisper-1')).toEqual({
      response_format: 'verbose_json',
      timestamp_granularities: ['segment']
    });
    expect(transcriptionRequestOptionsForModel('gpt-4o-transcribe-diarize')).toEqual({
      response_format: 'diarized_json',
      chunking_strategy: 'auto'
    });
  });

  it('merges whisper verbose JSON segments with chunk offsets and default speaker', () => {
    const segments = mergeTranscriptChunks({
      generatedAt: '2026-06-09T00:00:00.000Z',
      chunks: [
        {
          index: 0,
          audioPath: 'chunk-000.m4a',
          start: 10,
          end: 15,
          model: 'whisper-1',
          response: {
            text: 'こんにちは。次です。',
            segments: [
              { id: 0, start: 0.25, end: 1.5, text: 'こんにちは。' },
              { id: 1, start: 1.5, end: 3, text: '次です。' }
            ]
          }
        }
      ]
    });

    expect(segments.segments).toEqual([
      {
        id: '1-0',
        start: 10.25,
        end: 11.5,
        speaker: 'A',
        ja: 'こんにちは。'
      },
      {
        id: '1-1',
        start: 11.5,
        end: 13,
        speaker: 'A',
        ja: '次です。'
      }
    ]);
  });

  it('requires speaker labels for non-whisper transcript segments', () => {
    expect(() =>
      mergeTranscriptChunks({
        generatedAt: '2026-06-09T00:00:00.000Z',
        chunks: [
          {
            index: 0,
            audioPath: 'chunk-000.m4a',
            start: 10,
            end: 15,
            model: 'gpt-4o-transcribe-diarize',
            response: {
              segments: [{ id: 'a', start: 0, end: 1, text: 'こんにちは' }]
            }
          }
        ]
      })
    ).toThrow('Transcription segment 1 speaker must be a string.');
  });

  it('normalizes diarized JSON segments while preserving speaker labels', () => {
    const segments = mergeTranscriptChunks({
      generatedAt: '2026-06-09T00:00:00.000Z',
      chunks: [
        {
          index: 0,
          audioPath: 'chunk-000.m4a',
          start: 20,
          end: 25,
          response: {
            segments: [
              { id: 'a', start: 0, end: 1, speaker: 'A', text: 'はい。' },
              { id: 'b', start: 1, end: 2.5, speaker: 'B', text: 'そうです。' }
            ]
          }
        }
      ]
    });

    expect(segments.segments).toEqual([
      {
        id: '1-a',
        start: 20,
        end: 21,
        speaker: 'A',
        ja: 'はい。'
      },
      {
        id: '1-b',
        start: 21,
        end: 22.5,
        speaker: 'B',
        ja: 'そうです。'
      }
    ]);
  });

  it('rejects transcription responses without segments', () => {
    expect(() =>
      mergeTranscriptChunks({
        generatedAt: '2026-06-09T00:00:00.000Z',
        chunks: [
          {
            index: 0,
            audioPath: 'chunk-000.m4a',
            start: 10,
            end: 15,
            response: { text: 'こんにちは' }
          }
        ]
      })
    ).toThrow('Transcription response does not contain segments.');
  });

  it.each([
    ['missing speaker', { id: 'a', start: 0, end: 1, text: 'こんにちは' }, 'speaker'],
    ['missing text', { id: 'a', start: 0, end: 1, speaker: 'A' }, 'text'],
    ['string start', { id: 'a', start: '0', end: 1, speaker: 'A', text: 'こんにちは' }, 'start'],
    ['string end', { id: 'a', start: 0, end: '1', speaker: 'A', text: 'こんにちは' }, 'end'],
    ['NaN start', { id: 'a', start: Number.NaN, end: 1, speaker: 'A', text: 'こんにちは' }, 'start']
  ])('rejects malformed provider segment with %s', (_label, segment, field) => {
    expect(() =>
      mergeTranscriptChunks({
        generatedAt: '2026-06-09T00:00:00.000Z',
        chunks: [
          {
            index: 0,
            audioPath: 'chunk-000.m4a',
            start: 10,
            end: 15,
            response: { segments: [segment] }
          }
        ]
      })
    ).toThrow(`Transcription segment 1 ${field} must be`);
  });

  it('preserves provider text without trimming or dropping empty segments', () => {
    const segments = mergeTranscriptChunks({
      generatedAt: '2026-06-09T00:00:00.000Z',
      chunks: [
        {
          index: 0,
          audioPath: 'chunk-000.m4a',
          start: 10,
          end: 15,
          response: {
            segments: [
              { id: 'empty', start: 0, end: 0.1, speaker: 'A', text: '' },
              { id: 'blank', start: 0.1, end: 0.2, speaker: 'A', text: '   ' },
              { id: 'spaced', start: 0.2, end: 1, speaker: 'A', text: ' こんにちは ' }
            ]
          }
        }
      ]
    });

    expect(segments.segments).toEqual([
      {
        id: '1-empty',
        start: 10,
        end: 10.1,
        speaker: 'A',
        ja: ''
      },
      {
        id: '1-blank',
        start: 10.1,
        end: 10.2,
        speaker: 'A',
        ja: '   '
      },
      {
        id: '1-spaced',
        start: 10.2,
        end: 11,
        speaker: 'A',
        ja: ' こんにちは '
      }
    ]);
  });

  it('transcribes chunks concurrently and resumes from completed chunk files', async () => {
    const dir = await preparedSession('transcript_raw', {});
    const ffprobeBin = await fakeFfprobeBin();
    await mkdir(path.join(dir, 'audio/chunks'), { recursive: true });
    for (let index = 0; index < 6; index += 1) {
      await writeFile(
        path.join(dir, `audio/chunks/chunk-${String(index).padStart(3, '0')}.m4a`),
        'audio'
      );
    }
    const chunkHash = await sha256File(path.join(dir, 'audio/chunks/chunk-000.m4a'));
    const chunkSize = 5;

    const session = await Session.loadOrCreate(dir);
    session.state = baseSession('transcript_raw');
    session.state.stages.audio = {
      status: 'done',
      audio: 'audio/extracted.m4a',
      chunks_dir: 'audio/chunks',
      chunk_count: 6,
      chunks: Array.from({ length: 6 }, (_, index) => ({
        audio: `audio/chunks/chunk-${String(index).padStart(3, '0')}.m4a`,
        start: index,
        end: index + 1,
        size: chunkSize,
        sha256: chunkHash
      }))
    };

    let active = 0;
    let maxActive = 0;
    const calls: string[] = [];
    let waiting: Array<() => void> = [];
    const releaseWaiting = () => {
      const ready = waiting;
      waiting = [];
      for (const resolve of ready) {
        resolve();
      }
    };
    const transcribe = async ({ audioPath }: { audioPath: string }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      calls.push(path.basename(audioPath));
      await new Promise<void>((resolve) => {
        waiting.push(resolve);
        if (waiting.length === 5 || calls.length === 6) {
          releaseWaiting();
        }
      });
      active -= 1;
      return {
        segments: [
          {
            id: path.basename(audioPath, '.m4a'),
            start: 0,
            end: 0.5,
            speaker: 'A',
            text: path.basename(audioPath)
          }
        ]
      };
    };

    await runTranscriptRawStage({
      session,
      runtime: { ffmpegBin: 'ffmpeg', ffprobeBin },
      deps: { transcribe }
    });

    expect(maxActive).toBeGreaterThan(1);
    expect(maxActive).toBeLessThanOrEqual(5);
    expect(calls).toHaveLength(6);
    expect(
      await readFile(path.join(dir, 'transcript/raw/chunks/chunk-000.toml'), 'utf8')
    ).toContain('chunk-000.m4a');
    expect(await readFile(path.join(dir, 'transcript/raw/segments.toml'), 'utf8')).toContain(
      'ja = "chunk-005.m4a"'
    );
    expect(await readFile(path.join(dir, 'transcript/raw/segments.toml'), 'utf8')).not.toContain(
      'media ='
    );

    calls.length = 0;
    await runTranscriptRawStage({
      session,
      runtime: { ffmpegBin: 'ffmpeg', ffprobeBin },
      deps: { transcribe }
    });
    expect(calls).toHaveLength(0);
  });

  it('uses recorded audio chunk timeline instead of probed chunk durations', async () => {
    const dir = await preparedSession('transcript_raw', {});
    const ffprobeBin = await fakeFfprobeBin();
    await mkdir(path.join(dir, 'audio/chunks'), { recursive: true });
    await writeFile(path.join(dir, 'audio/chunks/chunk-000.m4a'), 'audio');
    await writeFile(path.join(dir, 'audio/chunks/chunk-001.m4a'), 'audio');
    const chunkHash = await sha256File(path.join(dir, 'audio/chunks/chunk-000.m4a'));

    const session = await Session.loadOrCreate(dir);
    session.state = baseSession('transcript_raw');
    session.state.stages.audio = {
      status: 'done',
      audio: 'audio/extracted.m4a',
      chunks_dir: 'audio/chunks',
      chunk_count: 2,
      chunks: [
        {
          audio: 'audio/chunks/chunk-000.m4a',
          start: 0,
          end: 595,
          size: 5,
          sha256: chunkHash
        },
        {
          audio: 'audio/chunks/chunk-001.m4a',
          start: 595,
          end: 1194,
          size: 5,
          sha256: chunkHash
        }
      ]
    };

    await runTranscriptRawStage({
      session,
      runtime: { ffmpegBin: 'ffmpeg', ffprobeBin },
      deps: {
        transcribe: async ({ audioPath }) => ({
          segments: [
            {
              id: path.basename(audioPath, '.m4a'),
              start: 0.25,
              end: 0.75,
              speaker: 'A',
              text: path.basename(audioPath)
            }
          ]
        })
      }
    });

    const segments = await readSegmentsFile(path.join(dir, 'transcript/raw/segments.toml'));
    expect(segments.segments.map((segment) => segment.start)).toEqual([0.25, 595.25]);
    expect(segments.segments.map((segment) => segment.end)).toEqual([0.75, 595.75]);
  });

  it('rejects missing audio chunk metadata before transcription', async () => {
    const dir = await preparedSession('transcript_raw', {});
    const ffprobeBin = await fakeFfprobeBin();
    await mkdir(path.join(dir, 'audio'), { recursive: true });
    await writeFile(path.join(dir, 'audio/extracted.m4a'), 'audio');

    const session = await Session.loadOrCreate(dir);
    session.state = baseSession('transcript_raw');
    session.state.stages.audio = {
      status: 'done',
      audio: 'audio/extracted.m4a',
      chunk_count: 1
    };

    await expect(
      runTranscriptRawStage({
        session,
        runtime: { ffmpegBin: 'ffmpeg', ffprobeBin },
        deps: {
          transcribe: async () => {
            throw new Error('should not transcribe');
          }
        }
      })
    ).rejects.toThrow('audio stage does not include chunk metadata');
  });

  it('does not resume stale transcription checkpoints after upstream reset', async () => {
    const dir = await preparedSession('transcript_raw', {});
    const ffprobeBin = await fakeFfprobeBin();
    await mkdir(path.join(dir, 'audio'), { recursive: true });
    await mkdir(path.join(dir, 'audio/chunks'), { recursive: true });
    await mkdir(path.join(dir, 'transcript/raw/chunks'), { recursive: true });
    await writeFile(path.join(dir, 'audio/extracted.m4a'), 'new audio');
    await writeFile(path.join(dir, 'audio/chunks/chunk-000.m4a'), 'new audio');
    const chunkHash = await sha256File(path.join(dir, 'audio/chunks/chunk-000.m4a'));
    await writeFile(
      path.join(dir, 'transcript/raw/chunks/chunk-000.toml'),
      [
        'version = 1',
        'status = "done"',
        'chunk_index = 0',
        'audio = "audio/extracted.m4a"',
        'start = 0',
        'end = 1',
        'model = "old"',
        'started_at = "2026-06-05T00:00:00.000Z"',
        'completed_at = "2026-06-05T00:00:00.000Z"',
        '',
        '[[response.segments]]',
        'id = "old"',
        'start = 0',
        'end = 0.5',
        'speaker = "A"',
        'text = "old media"'
      ].join('\n')
    );

    const session = await Session.loadOrCreate(dir);
    session.state = baseSession('transcript_raw');
    session.state.stages.audio = {
      status: 'done',
      audio: 'audio/extracted.m4a',
      chunk_count: 1,
      chunks: [
        {
          audio: 'audio/chunks/chunk-000.m4a',
          start: 0,
          end: 1,
          size: 9,
          sha256: chunkHash
        }
      ]
    };
    let calls = 0;

    await runTranscriptRawStage({
      session,
      runtime: { ffmpegBin: 'ffmpeg', ffprobeBin },
      deps: {
        transcribe: async () => {
          calls += 1;
          return {
            segments: [
              {
                id: 'new',
                start: 0,
                end: 0.5,
                speaker: 'A',
                text: 'new media'
              }
            ]
          };
        }
      },
      resetCheckpoints: true
    });

    expect(calls).toBe(1);
    expect(await readFile(path.join(dir, 'transcript/raw/segments.toml'), 'utf8')).toContain(
      'ja = "new media"'
    );
    expect(await readFile(path.join(dir, 'transcript/raw/segments.toml'), 'utf8')).not.toContain(
      'old media'
    );
  });

  it('writes chunk error logs when transcription fails', async () => {
    const dir = await preparedSession('transcript_raw', {});
    const ffprobeBin = await fakeFfprobeBin();
    await mkdir(path.join(dir, 'audio'), { recursive: true });
    await mkdir(path.join(dir, 'audio/chunks'), { recursive: true });
    await writeFile(path.join(dir, 'audio/extracted.m4a'), 'audio');
    await writeFile(path.join(dir, 'audio/chunks/chunk-000.m4a'), 'audio');
    const chunkHash = await sha256File(path.join(dir, 'audio/chunks/chunk-000.m4a'));

    const session = await Session.loadOrCreate(dir);
    session.state = baseSession('transcript_raw');
    session.state.stages.audio = {
      status: 'done',
      audio: 'audio/extracted.m4a',
      chunk_count: 1,
      chunks: [
        {
          audio: 'audio/chunks/chunk-000.m4a',
          start: 0,
          end: 1,
          size: 5,
          sha256: chunkHash
        }
      ]
    };

    await expect(
      runTranscriptRawStage({
        session,
        runtime: { ffmpegBin: 'ffmpeg', ffprobeBin },
        deps: {
          transcribe: async () => {
            throw new Error('temporary ASR failure');
          }
        }
      })
    ).rejects.toThrow('temporary ASR failure');

    expect(
      await readFile(path.join(dir, 'transcript/raw/chunks/chunk-000.error.log'), 'utf8')
    ).toContain('temporary ASR failure');
    await expect(
      readFile(path.join(dir, 'transcript/raw/chunks/chunk-000.toml'), 'utf8')
    ).rejects.toThrow();
  });

  it('logs transcription heartbeats while a chunk is still running', async () => {
    const dir = await tempDir();
    const logs: string[] = [];
    const heartbeat = startTranscriptionHeartbeat({
      chunk: {
        index: 0,
        audioPath: path.join(dir, 'audio/chunks/chunk-000.m4a'),
        start: 0,
        end: 90
      },
      totalChunks: 2,
      sessionDir: dir,
      intervalMs: 1000,
      logger: {
        info: (message) => {
          logs.push(message);
        }
      }
    });

    await vi.advanceTimersByTimeAsync(1000);
    expect(logs.at(-1)).toContain('chunk 1/2 heartbeat 00:01 00:00-01:30');
    expect(logs.at(-1)).toContain('waiting for provider response');

    heartbeat.stop();
    const logCount = logs.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(logs).toHaveLength(logCount);
  });
});
