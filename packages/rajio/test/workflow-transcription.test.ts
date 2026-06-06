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
import { baseSession, fakeFfprobeBin, preparedSession, tempDir } from './helpers.js';

describe('transcript raw stage', () => {
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
      deps: { transcribe },
      force: false
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

    calls.length = 0;
    await runTranscriptRawStage({
      session,
      runtime: { ffmpegBin: 'ffmpeg', ffprobeBin },
      deps: { transcribe },
      force: false
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
      },
      force: false
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
        },
        force: false
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
      force: false,
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
        },
        force: false
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
