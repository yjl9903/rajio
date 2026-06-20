import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { Session } from '../src/index.js';
import { readSegmentsFile, writeSegmentsFile } from '../src/segments/index.js';
import { runTranscriptRawStage } from '../src/workflow/stages/transcription.js';
import {
  mergeElevenLabsInputs,
  normalizeElevenLabsTranscript
} from '../src/transcription/elevenlabs.js';
import { resolveWorkflowTranscriptionConfig } from '../src/transcription/config.js';
import { startTranscriptionHeartbeat } from '../src/transcription/run.js';
import { sha256File } from '../src/utils/fs.js';
import { baseSession, fakeFfprobeBin, preparedSession, tempDir } from './helpers.js';

const transcription = {
  provider: 'elevenlabs',
  model: 'scribe_v2',
  segmenter: 'integrated'
} as const;

describe('transcript raw stage', () => {
  it('maps ElevenLabs words to raw segments with global times', () => {
    const segments = normalizeElevenLabsTranscript(
      {
        words: [
          {
            text: 'こんにちは',
            start: 0.25,
            end: 0.75,
            speakerId: 'speaker_0',
            type: 'word',
            logprob: Math.log(0.8)
          },
          { text: ' ', start: 0.75, end: 0.8, speakerId: 'speaker_0', type: 'spacing' },
          { text: '。', start: 0.8, end: 0.9, speakerId: 'speaker_0', type: 'word' },
          { text: '(拍手)', start: 1, end: 1.2, speakerId: 'speaker_0', type: 'audio_event' },
          { text: 'はい', start: 2, end: 2.4, speakerId: 'speaker_1', type: 'word' }
        ]
      },
      { offset: 10, idPrefix: '1' }
    );

    expect(segments).toEqual([
      {
        id: '1-s1',
        start: 10.25,
        end: 11.2,
        speaker: 'speaker_0',
        ja: 'こんにちは。',
        words: [
          {
            text: 'こんにちは',
            start: 10.25,
            end: 10.75,
            speaker: 'speaker_0',
            confidence: 0.8,
            type: 'word'
          },
          {
            text: ' ',
            start: 10.75,
            end: 10.8,
            speaker: 'speaker_0',
            type: 'spacing'
          },
          {
            text: '。',
            start: 10.8,
            end: 10.9,
            speaker: 'speaker_0',
            type: 'word'
          },
          {
            text: '(拍手)',
            start: 11,
            end: 11.2,
            speaker: 'speaker_0',
            type: 'audio_event'
          }
        ]
      },
      {
        id: '1-s2',
        start: 12,
        end: 12.4,
        speaker: 'speaker_1',
        ja: 'はい',
        words: [
          {
            text: 'はい',
            start: 12,
            end: 12.4,
            speaker: 'speaker_1',
            type: 'word'
          }
        ]
      }
    ]);
  });

  it('merges single transcription inputs', () => {
    const file = mergeElevenLabsInputs({
      generatedAt: '2026-06-09T00:00:00.000Z',
      inputs: [
        {
          index: 0,
          audioPath: 'audio/extracted.m4a',
          start: 5,
          end: 10,
          transcription,
          response: {
            words: [{ text: 'はい', start: 0, end: 0.5, speaker_id: 'speaker_0', type: 'word' }]
          }
        }
      ]
    });

    expect(file.segments[0]).toMatchObject({
      id: '1-s1',
      start: 5,
      end: 5.5,
      speaker: 'speaker_0',
      ja: 'はい'
    });
  });

  it('resolves session transcription config and guards CLI changes', () => {
    const state = baseSession('audio');
    const initial = resolveWorkflowTranscriptionConfig({
      state,
      description: { body: '', frontmatter: { transcription: { provider: 'elevenlabs' } } },
      target: '/tmp/session'
    });
    expect(initial).toEqual(transcription);

    state.transcription = transcription;
    expect(
      resolveWorkflowTranscriptionConfig({
        state,
        description: { body: '', frontmatter: { transcription: { model: 'ignored' } } },
        cli: { model: 'scribe_v2' },
        target: '/tmp/session'
      })
    ).toEqual(transcription);

    expect(() =>
      resolveWorkflowTranscriptionConfig({
        state,
        description: { body: '', frontmatter: {} },
        cli: { model: 'unsupported' },
        target: '/tmp/session'
      })
    ).toThrow('Transcription model "unsupported" is not supported.');
  });

  it('transcribes one extracted audio input and resumes matching checkpoints', async () => {
    const dir = await preparedSession('transcript_raw', {});
    await mkdir(path.join(dir, 'audio'), { recursive: true });
    await writeFile(path.join(dir, 'audio/extracted.m4a'), 'audio');
    const session = await Session.loadOrCreate(dir);
    session.state = baseSession('transcript_raw');
    session.state.transcription = transcription;
    session.state.stages.audio = {
      status: 'done',
      audio: 'audio/extracted.m4a',
      strategy: 'single_file',
      duration: 2
    };
    let calls = 0;

    await runTranscriptRawStage({
      session,
      runtime: { ffmpegBin: 'ffmpeg', ffprobeBin: await fakeFfprobeBin() },
      transcription,
      deps: {
        transcribe: async ({ audioPath }) => {
          calls += 1;
          return {
            words: [
              {
                text: path.basename(audioPath),
                start: 0,
                end: 0.5,
                speaker_id: 'speaker_0',
                type: 'word'
              }
            ]
          };
        }
      }
    });

    expect(calls).toBe(1);
    expect(
      await readFile(path.join(dir, 'transcript/raw/checkpoints/input-000.toml'), 'utf8')
    ).toContain('provider = "elevenlabs"');
    expect(await readFile(path.join(dir, 'transcript/raw/segments.toml'), 'utf8')).toContain(
      'ja = "extracted.m4a"'
    );

    await runTranscriptRawStage({
      session,
      runtime: { ffmpegBin: 'ffmpeg', ffprobeBin: await fakeFfprobeBin() },
      transcription,
      deps: {
        transcribe: async () => {
          throw new Error('should resume');
        }
      }
    });
    expect(calls).toBe(1);
  });

  it('keeps extracted audio as raw input while transcribing chunks', async () => {
    const dir = await preparedSession('transcript_raw', {});
    await mkdir(path.join(dir, 'audio/chunks'), { recursive: true });
    await writeFile(path.join(dir, 'audio/extracted.m4a'), 'full-audio');
    await writeFile(path.join(dir, 'audio/chunks/chunk-000.m4a'), 'chunk-audio');
    const chunkPath = path.join(dir, 'audio/chunks/chunk-000.m4a');
    const session = await Session.loadOrCreate(dir);
    session.state = baseSession('transcript_raw');
    session.state.transcription = transcription;
    session.state.stages.audio = {
      status: 'done',
      audio: 'audio/extracted.m4a',
      strategy: 'silence_or_time',
      chunks: [
        {
          audio: 'audio/chunks/chunk-000.m4a',
          start: 10,
          end: 12,
          size: 11,
          sha256: await sha256File(chunkPath)
        }
      ]
    };
    let calls = 0;

    await runTranscriptRawStage({
      session,
      runtime: { ffmpegBin: 'ffmpeg', ffprobeBin: await fakeFfprobeBin() },
      transcription,
      deps: {
        transcribe: async ({ audioPath }) => {
          calls += 1;
          return {
            words: [
              {
                text: path.basename(audioPath),
                start: 0,
                end: 0.5,
                speaker_id: 'speaker_0',
                type: 'word'
              }
            ]
          };
        }
      }
    });

    expect(calls).toBe(1);
    expect(session.stage('transcript_raw').input_audio).toBe('audio/extracted.m4a');
    expect(
      await readFile(path.join(dir, 'transcript/raw/checkpoints/input-000.toml'), 'utf8')
    ).toContain('audio = "audio/chunks/chunk-000.m4a"');
    expect(await readFile(path.join(dir, 'transcript/raw/segments.toml'), 'utf8')).toContain(
      'start = 10'
    );

    await runTranscriptRawStage({
      session,
      runtime: { ffmpegBin: 'ffmpeg', ffprobeBin: await fakeFfprobeBin() },
      transcription,
      deps: {
        transcribe: async () => {
          throw new Error('should resume');
        }
      }
    });
    expect(calls).toBe(1);
  });

  it('does not resume mismatched checkpoints', async () => {
    const dir = await preparedSession('transcript_raw', {});
    await mkdir(path.join(dir, 'audio'), { recursive: true });
    await mkdir(path.join(dir, 'transcript/raw/checkpoints'), { recursive: true });
    await writeFile(path.join(dir, 'audio/extracted.m4a'), 'audio');
    await writeRawCheckpointFixture(dir, { model: 'old' });

    const session = await Session.loadOrCreate(dir);
    session.state = baseSession('transcript_raw');
    session.state.transcription = transcription;
    session.state.stages.audio = {
      status: 'done',
      audio: 'audio/extracted.m4a',
      strategy: 'single_file',
      duration: 1
    };

    await runTranscriptRawStage({
      session,
      runtime: { ffmpegBin: 'ffmpeg', ffprobeBin: await fakeFfprobeBin() },
      transcription,
      deps: {
        transcribe: async () => ({
          words: [{ text: 'new', start: 0, end: 0.5, speaker_id: 'speaker_0', type: 'word' }]
        })
      }
    });

    expect(await readFile(path.join(dir, 'transcript/raw/segments.toml'), 'utf8')).toContain(
      'ja = "new"'
    );
  });

  it('does not resume checkpoints for a different input', async () => {
    const dir = await preparedSession('transcript_raw', {});
    await mkdir(path.join(dir, 'audio'), { recursive: true });
    await mkdir(path.join(dir, 'transcript/raw/checkpoints'), { recursive: true });
    await writeFile(path.join(dir, 'audio/extracted.m4a'), 'audio');
    await writeRawCheckpointFixture(dir, { audio: 'audio/other.m4a' });

    const session = await Session.loadOrCreate(dir);
    session.state = baseSession('transcript_raw');
    session.state.transcription = transcription;
    session.state.stages.audio = {
      status: 'done',
      audio: 'audio/extracted.m4a',
      strategy: 'single_file',
      duration: 1
    };

    let calls = 0;
    await runTranscriptRawStage({
      session,
      runtime: { ffmpegBin: 'ffmpeg', ffprobeBin: await fakeFfprobeBin() },
      transcription,
      deps: {
        transcribe: async () => {
          calls += 1;
          return {
            words: [{ text: 'new', start: 0, end: 0.5, speaker_id: 'speaker_0', type: 'word' }]
          };
        }
      }
    });

    expect(calls).toBe(1);
    expect(await readFile(path.join(dir, 'transcript/raw/segments.toml'), 'utf8')).toContain(
      'ja = "new"'
    );
  });

  it('writes input error logs when transcription fails', async () => {
    const dir = await preparedSession('transcript_raw', {});
    await mkdir(path.join(dir, 'audio'), { recursive: true });
    await writeFile(path.join(dir, 'audio/extracted.m4a'), 'audio');
    const session = await Session.loadOrCreate(dir);
    session.state = baseSession('transcript_raw');
    session.state.transcription = transcription;
    session.state.stages.audio = {
      status: 'done',
      audio: 'audio/extracted.m4a',
      strategy: 'single_file',
      duration: 1
    };

    await expect(
      runTranscriptRawStage({
        session,
        runtime: { ffmpegBin: 'ffmpeg', ffprobeBin: await fakeFfprobeBin() },
        transcription,
        deps: {
          transcribe: async () => {
            throw new Error('temporary ASR failure');
          }
        }
      })
    ).rejects.toThrow('temporary ASR failure');

    expect(
      await readFile(path.join(dir, 'transcript/raw/checkpoints/input-000.error.log'), 'utf8')
    ).toContain('temporary ASR failure');
  });

  it('rejects single-file audio hash mismatches before transcription', async () => {
    const dir = await preparedSession('transcript_raw', {});
    await mkdir(path.join(dir, 'audio'), { recursive: true });
    await writeFile(path.join(dir, 'audio/extracted.m4a'), 'audio');
    const session = await Session.loadOrCreate(dir);
    session.state = baseSession('transcript_raw');
    session.state.transcription = transcription;
    session.state.stages.audio = {
      status: 'done',
      audio: 'audio/extracted.m4a',
      audio_size: 5,
      audio_sha256: 'not-the-current-hash',
      strategy: 'single_file',
      duration: 1
    };

    await expect(
      runTranscriptRawStage({
        session,
        runtime: { ffmpegBin: 'ffmpeg', ffprobeBin: await fakeFfprobeBin() },
        transcription,
        deps: {
          transcribe: async () => {
            throw new Error('should not upload');
          }
        }
      })
    ).rejects.toThrow('audio file hash mismatch: audio/extracted.m4a.');
  });

  it('drops raw words when creating transcript work', async () => {
    const dir = await preparedSession('transcript_work', {
      transcript_raw: {
        status: 'done',
        segments: 'transcript/raw/segments.toml'
      }
    });
    await writeSegmentsFile(path.join(dir, 'transcript/raw/segments.toml'), {
      version: 1,
      source: { kind: 'transcript', generated_at: '2026-06-06T00:00:00.000Z' },
      segments: [
        {
          id: '1',
          start: 0,
          end: 1,
          speaker: 'speaker_0',
          ja: ' はい ',
          words: [{ text: 'はい', start: 0, end: 1, speaker: 'speaker_0', type: 'word' }]
        }
      ]
    });
    const session = await Session.loadOrCreate(dir);
    const { setupManualStage } = await import('../src/workflow/stages/manual.js');
    await setupManualStage({ session, stage: 'transcript_work' });

    const work = await readSegmentsFile(path.join(dir, 'transcript/work/segments.toml'));
    expect(work.segments[0]).toEqual({
      id: '1',
      start: 0,
      end: 1,
      speaker: 'speaker_0',
      ja: 'はい'
    });
  });

  it('logs transcription heartbeats while an input is still running', async () => {
    const dir = await tempDir();
    const logs: string[] = [];
    const heartbeat = startTranscriptionHeartbeat({
      input: {
        index: 0,
        audioPath: path.join(dir, 'audio/extracted.m4a'),
        start: 0,
        end: 90
      },
      totalInputs: 2,
      sessionDir: dir,
      intervalMs: 1000,
      logger: {
        info: (message) => {
          logs.push(message);
        }
      }
    });

    await vi.advanceTimersByTimeAsync(1000);
    expect(logs.at(-1)).toContain('input 1/2 heartbeat 00:01 00:00-01:30');
    expect(logs.at(-1)).toContain('waiting for provider response');

    heartbeat.stop();
    const logCount = logs.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(logs).toHaveLength(logCount);
  });
});

async function writeRawCheckpointFixture(
  dir: string,
  overrides: { audio?: string; model?: string } = {}
): Promise<void> {
  await writeFile(
    path.join(dir, 'transcript/raw/checkpoints/input-000.toml'),
    [
      'version = 1',
      'status = "done"',
      'input_index = 0',
      `audio = "${overrides.audio ?? 'audio/extracted.m4a'}"`,
      'start = 0',
      'end = 1',
      'provider = "elevenlabs"',
      `model = "${overrides.model ?? 'scribe_v2'}"`,
      'segmenter = "integrated"',
      'started_at = "2026-06-05T00:00:00.000Z"',
      'completed_at = "2026-06-05T00:00:00.000Z"',
      '',
      '[[response.words]]',
      'text = "old"',
      'start = 0',
      'end = 0.5',
      'speaker_id = "speaker_0"',
      'type = "word"'
    ].join('\n')
  );
}
