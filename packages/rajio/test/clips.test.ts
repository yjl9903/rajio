import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { Session } from '../src/index.js';
import { readSegmentsFile } from '../src/segments/index.js';
import { formatClipList } from '../src/clips/output.js';
import { listClips } from '../src/clips/list.js';
import { transcribeClip } from '../src/clips/transcribe.js';
import { preparedSession, tempDir } from './helpers.js';

const transcription = {
  provider: 'elevenlabs',
  model: 'scribe_v2',
  segmenter: 'integrated'
} as const;

describe('clips', () => {
  it('transcribes a clip, writes sidecar artifacts, and resumes checkpoints', async () => {
    const dir = await preparedSession('transcript_work', {});
    const session = await Session.loadOrCreate(dir);
    const ffmpegBin = await fakeFfmpegBin();
    const ffprobeBin = await fakeFfprobeBin(60);
    const calls: string[] = [];

    await transcribeClip({
      session,
      runtime: { ffmpegBin, ffprobeBin },
      start: 120,
      end: 180,
      label: 'noisy-overlap',
      deps: {
        transcribe: async ({ audioPath }) => {
          calls.push(path.basename(audioPath));
          return {
            words: [
              {
                text: '聞き取り直し',
                start: 1,
                end: 2,
                speaker_id: 'speaker_0',
                type: 'word'
              }
            ]
          };
        }
      }
    });

    expect(calls).toEqual(['source.m4a']);
    const clipDir = path.join(dir, 'clips/clip-120000-180000');
    const clipToml = await readFile(path.join(clipDir, 'clip.toml'), 'utf8');
    expect(clipToml).toContain('label = "noisy-overlap"');
    expect(clipToml).toContain('provider = "elevenlabs"');
    expect(clipToml).toContain('strategy = "single_file"');
    expect(await readFile(path.join(clipDir, 'checkpoints/input-000.toml'), 'utf8')).toContain(
      'start = 120'
    );
    const segments = await readSegmentsFile(path.join(clipDir, 'segments.toml'));
    expect(segments.segments[0]).toMatchObject({
      start: 121,
      end: 122,
      ja: '聞き取り直し'
    });

    calls.length = 0;
    await transcribeClip({
      session,
      runtime: { ffmpegBin, ffprobeBin },
      start: 120,
      end: 180,
      deps: {
        transcribe: async () => {
          throw new Error('should resume');
        }
      }
    });
    expect(calls).toEqual([]);

    await writeFile(path.join(clipDir, 'source.m4a'), 'changed audio');
    await expect(
      transcribeClip({
        session,
        runtime: { ffmpegBin, ffprobeBin },
        start: 120,
        end: 180,
        deps: {
          transcribe: async () => {
            throw new Error('should validate before resume');
          }
        }
      })
    ).rejects.toThrow('clip audio size mismatch');
    await writeFile(path.join(clipDir, 'source.m4a'), 'audio');

    await rm(path.join(clipDir, 'source.m4a'));
    await expect(
      transcribeClip({
        session,
        runtime: { ffmpegBin, ffprobeBin },
        start: 120,
        end: 180,
        deps: {
          transcribe: async () => {
            throw new Error('should validate before resume');
          }
        }
      })
    ).rejects.toThrow('clip audio is missing: source.m4a.');
    await writeFile(path.join(clipDir, 'source.m4a'), 'audio');

    await writeFile(path.join(dir, 'video.mp4'), 'changed media');
    await expect(
      transcribeClip({
        session,
        runtime: { ffmpegBin, ffprobeBin },
        start: 120,
        end: 180,
        deps: {
          transcribe: async () => {
            throw new Error('should not use stale clip');
          }
        }
      })
    ).rejects.toThrow('different source media');
  });

  it('does not resume clip checkpoints for a different input', async () => {
    const dir = await preparedSession('transcript_work', {});
    const session = await Session.loadOrCreate(dir);
    const ffmpegBin = await fakeFfmpegBin();
    const ffprobeBin = await fakeFfprobeBin(60);

    await transcribeClip({
      session,
      runtime: { ffmpegBin, ffprobeBin },
      start: 50,
      end: 60,
      deps: {
        transcribe: async () => ({
          words: [{ text: 'old', start: 0, end: 1, speaker_id: 'speaker_0', type: 'word' }]
        })
      }
    });

    const checkpointPath = path.join(dir, 'clips/clip-50000-60000/checkpoints/input-000.toml');
    await writeFile(
      checkpointPath,
      (await readFile(checkpointPath, 'utf8')).replace(
        'audio = "source.m4a"',
        'audio = "other.m4a"'
      )
    );

    let calls = 0;
    await transcribeClip({
      session,
      runtime: { ffmpegBin, ffprobeBin },
      start: 50,
      end: 60,
      deps: {
        transcribe: async () => {
          calls += 1;
          return {
            words: [{ text: 'new', start: 0, end: 1, speaker_id: 'speaker_0', type: 'word' }]
          };
        }
      }
    });

    expect(calls).toBe(1);
    expect(
      await readFile(path.join(dir, 'clips/clip-50000-60000/segments.toml'), 'utf8')
    ).toContain('ja = "new"');
  });

  it('lists clips with compact status columns', async () => {
    const dir = await preparedSession('transcript_work', {});
    const session = await Session.loadOrCreate(dir);
    const ffmpegBin = await fakeFfmpegBin();
    const ffprobeBin = await fakeFfprobeBin(60);

    await transcribeClip({
      session,
      runtime: { ffmpegBin, ffprobeBin },
      start: 10,
      end: 20,
      label: 'check',
      deps: {
        transcribe: async () => ({
          words: [{ text: 'はい', start: 0, end: 1, speaker_id: 'speaker_0', type: 'word' }]
        })
      }
    });

    const rows = await listClips(session);
    expect(rows).toEqual([
      {
        id: 'clip-10000-20000',
        label: 'check',
        start: 10,
        end: 20,
        duration: 10,
        status: 'done',
        segments: 1
      }
    ]);
    expect(formatClipList(rows, 'csv')).toBe(
      [
        'id,label,start,end,duration,status,segments',
        'clip-10000-20000,check,10,20,10,done,1'
      ].join('\n')
    );
    expect(formatClipList(rows, 'json')).toContain('"status":"done"');
    expect(formatClipList(rows, 'json')).not.toContain('\n');
    expect(formatClipList(rows, 'json', { pretty: true })).toContain('\n  "clips"');
  });

  it('rejects reusing clips created with a different transcription config', async () => {
    const dir = await preparedSession('transcript_work', {});
    const session = await Session.loadOrCreate(dir);
    const ffmpegBin = await fakeFfmpegBin();
    const ffprobeBin = await fakeFfprobeBin(60);

    await transcribeClip({
      session,
      runtime: { ffmpegBin, ffprobeBin },
      start: 30,
      end: 40,
      deps: {
        transcribe: async () => ({
          words: [{ text: 'はい', start: 0, end: 1, speaker_id: 'speaker_0', type: 'word' }]
        })
      }
    });

    const clipPath = path.join(dir, 'clips/clip-30000-40000/clip.toml');
    await writeFile(
      clipPath,
      (await readFile(clipPath, 'utf8')).replace('model = "scribe_v2"', 'model = "old"')
    );

    await expect(
      transcribeClip({
        session,
        runtime: { ffmpegBin, ffprobeBin },
        start: 30,
        end: 40,
        deps: {
          transcribe: async () => {
            throw new Error('should reject before upload');
          }
        }
      })
    ).rejects.toThrow('different transcription config');
  });

  it('marks clips with checkpoints but no segments as partial', async () => {
    const dir = await preparedSession('transcript_work', {});
    await mkdir(path.join(dir, 'clips/clip-1000-2000/chunks'), { recursive: true });
    await mkdir(path.join(dir, 'clips/clip-1000-2000/checkpoints'), { recursive: true });
    await writeFile(
      path.join(dir, 'clips/clip-1000-2000/clip.toml'),
      [
        'id = "clip-1000-2000"',
        'source_media = "video.mp4"',
        'source_media_sha256 = "hash"',
        'source_audio = "source.m4a"',
        'segments = "segments.toml"',
        'created_at = "2026-06-06T00:00:00.000Z"',
        'updated_at = "2026-06-06T00:00:00.000Z"',
        'provider = "elevenlabs"',
        'model = "scribe_v2"',
        'segmenter = "integrated"',
        'strategy = "single_file"',
        'start = 1',
        'end = 2',
        '',
        '[[chunks]]',
        'audio = "source.m4a"',
        'checkpoint = "checkpoints/input-000.toml"',
        'start = 0',
        'end = 1',
        'absolute_start = 1',
        'absolute_end = 2',
        'size = 5',
        'sha256 = "hash"'
      ].join('\n')
    );
    await writeFile(
      path.join(dir, 'clips/clip-1000-2000/checkpoints/input-000.toml'),
      'status = "done"'
    );

    const rows = await listClips(await Session.loadOrCreate(dir));
    expect(rows[0]?.status).toBe('partial');
    expect(rows[0]?.segments).toBe('');
  });
});

async function fakeFfmpegBin(): Promise<string> {
  const dir = await tempDir();
  const filePath = path.join(dir, 'ffmpeg');
  await writeFile(
    filePath,
    [
      '#!/usr/bin/env node',
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      'const out = process.argv[process.argv.length - 1];',
      'fs.mkdirSync(path.dirname(out), { recursive: true });',
      'fs.writeFileSync(out, "audio");'
    ].join('\n')
  );
  await chmod(filePath, 0o755);
  return filePath;
}

async function fakeFfprobeBin(duration: number): Promise<string> {
  const dir = await tempDir();
  const filePath = path.join(dir, 'ffprobe');
  await writeFile(filePath, ['#!/usr/bin/env node', `console.log(${duration});`].join('\n'));
  await chmod(filePath, 0o755);
  return filePath;
}
