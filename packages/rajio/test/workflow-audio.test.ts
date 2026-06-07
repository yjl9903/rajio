import { chmod, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { Session } from '../src/index.js';
import {
  MAX_OPENAI_AUDIO_BYTES,
  parseSilenceDetectOutput,
  planAudioChunks,
  resolveAudioChunkOptions,
  runAudioStage
} from '../src/workflow/stages/audio.js';
import { preparedSession, tempDir } from './helpers.js';

describe('audio chunk planning', () => {
  it('uses nearby silence boundaries instead of fixed timestamps', () => {
    const chunks = planAudioChunks(
      2397,
      [
        { start: 594, end: 596 },
        { start: 1192, end: 1196 },
        { start: 1805, end: 1807 }
      ],
      { targetSeconds: 600, maxSeconds: 1350, minSeconds: 30, boundarySearchSeconds: 90 }
    );

    expect(chunks).toEqual([
      { start: 0, end: 595 },
      { start: 595, end: 1194 },
      { start: 1194, end: 1806 },
      { start: 1806, end: 2397 }
    ]);
    expect(chunks.every((chunk) => chunk.end - chunk.start <= 1350)).toBe(true);
  });

  it('falls back to safe time boundaries when no silence is available', () => {
    const chunks = planAudioChunks(2397, [], {
      targetSeconds: 600,
      maxSeconds: 1350,
      minSeconds: 30,
      boundarySearchSeconds: 90
    });

    expect(chunks).toEqual([
      { start: 0, end: 600 },
      { start: 600, end: 1200 },
      { start: 1200, end: 1800 },
      { start: 1800, end: 2397 }
    ]);
  });

  it('parses ffmpeg silencedetect intervals', () => {
    const silences = parseSilenceDetectOutput(
      [
        '[silencedetect @ 0x1] silence_start: 594',
        '[silencedetect @ 0x1] silence_end: 596 | silence_duration: 2',
        '[silencedetect @ 0x1] silence_start: 1192.5',
        '[silencedetect @ 0x1] silence_end: 1196 | silence_duration: 3.5'
      ].join('\n')
    );

    expect(silences).toEqual([
      { start: 594, end: 596 },
      { start: 1192.5, end: 1196 }
    ]);
  });

  it('validates chunk options against the transcription safety buffer', () => {
    expect(() =>
      resolveAudioChunkOptions({ targetSeconds: 1300, boundarySearchSeconds: 90 })
    ).toThrow('--chunk-target + --chunk-boundary-search');
    expect(resolveAudioChunkOptions({ targetSeconds: 1260, boundarySearchSeconds: 90 })).toEqual({
      targetSeconds: 1260,
      boundarySearchSeconds: 90,
      silenceNoiseDb: -35,
      silenceDurationSeconds: 0.4
    });
  });

  it('writes chunking metadata without old redundant audio fields', async () => {
    const dir = await preparedSession('audio', {});
    const ffmpegBin = await fakeFfmpegBin();
    const ffprobeBin = await fakeFfprobeJsonBin(1);
    const session = await Session.loadOrCreate(dir);

    await runAudioStage({
      session,
      runtime: { ffmpegBin, ffprobeBin },
      chunking: {
        targetSeconds: 120,
        boundarySearchSeconds: 30,
        silenceNoiseDb: -42,
        silenceDurationSeconds: 0.8
      }
    });
    await session.save();

    const sessionToml = await readFile(path.join(dir, 'session.toml'), 'utf8');
    expect(sessionToml).toContain('[stages.audio.chunking]');
    expect(sessionToml).toContain('requested_target_seconds = 120');
    expect(sessionToml).toContain('boundary_search_seconds = 30');
    expect(sessionToml).toContain('silence_noise_db = -42');
    expect(sessionToml).not.toContain('chunk_count =');
    expect(sessionToml).not.toContain('chunk_target_seconds =');
    expect(sessionToml).not.toContain('chunk_boundary =');
  });

  it('rejects generated chunks that exceed the transcription byte limit', async () => {
    const dir = await preparedSession('audio', {});
    const ffmpegBin = await fakeFfmpegBin(MAX_OPENAI_AUDIO_BYTES + 1);
    const ffprobeBin = await fakeFfprobeJsonBin(120);
    const session = await Session.loadOrCreate(dir);

    await expect(
      runAudioStage({
        session,
        runtime: { ffmpegBin, ffprobeBin },
        chunking: { targetSeconds: 120, boundarySearchSeconds: 0 }
      })
    ).rejects.toThrow('exceeds transcription byte limit');
  });
});

async function fakeFfmpegBin(bytes = 5): Promise<string> {
  const dir = await tempDir();
  const filePath = path.join(dir, 'ffmpeg');
  await writeFile(
    filePath,
    [
      '#!/usr/bin/env node',
      'const fs = require("node:fs");',
      'const out = process.argv[process.argv.length - 1];',
      'if (out === "-") process.exit(0);',
      'fs.mkdirSync(require("node:path").dirname(out), { recursive: true });',
      'const fd = fs.openSync(out, "w");',
      `fs.ftruncateSync(fd, ${bytes});`,
      'fs.closeSync(fd);'
    ].join('\n')
  );
  await chmod(filePath, 0o755);
  return filePath;
}

async function fakeFfprobeJsonBin(duration: number): Promise<string> {
  const dir = await tempDir();
  const filePath = path.join(dir, 'ffprobe');
  await writeFile(
    filePath,
    [
      '#!/usr/bin/env node',
      `const duration = ${JSON.stringify(String(duration))};`,
      'if (process.argv.includes("-print_format")) {',
      '  console.log(JSON.stringify({ format: { duration } }));',
      '} else {',
      '  console.log(duration);',
      '}'
    ].join('\n')
  );
  await chmod(filePath, 0o755);
  return filePath;
}
