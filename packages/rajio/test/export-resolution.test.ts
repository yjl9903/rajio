import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { Session } from '../src/session/index.js';
import { runExportStage } from '../src/workflow/stages/export.js';
import { preparedCompleteSession } from './helpers.js';

describe('ASS video resolution', () => {
  it.each([
    {
      name: '720p landscape',
      stream: { width: 1280, height: 720 },
      width: 1280,
      height: 720,
      fontSize: '28'
    },
    {
      name: '4K landscape',
      stream: { width: 3840, height: 2160 },
      width: 3840,
      height: 2160,
      fontSize: '84'
    },
    {
      name: 'portrait',
      stream: { width: 1080, height: 1920 },
      width: 1080,
      height: 1920,
      fontSize: '23.63'
    },
    {
      name: 'rotated phone video',
      stream: {
        width: 1920,
        height: 1080,
        side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }]
      },
      width: 1080,
      height: 1920,
      fontSize: '23.63'
    },
    {
      name: 'legacy rotation tag',
      stream: { width: 1920, height: 1080, tags: { rotate: '270' } },
      width: 1080,
      height: 1920,
      fontSize: '23.63'
    }
  ])('uses stored metadata for $name', async ({ stream, width, height, fontSize }) => {
    const dir = await preparedCompleteSession();
    try {
      await mkdir(path.join(dir, 'audio'), { recursive: true });
      await writeFile(
        path.join(dir, 'audio/metadata.json'),
        JSON.stringify({
          streams: [
            { codec_type: 'video', width: 600, height: 600, disposition: { attached_pic: 1 } },
            { codec_type: 'audio' },
            { codec_type: 'video', ...stream }
          ]
        })
      );
      const session = await Session.loadOrCreate(dir);
      session.updateStage('audio', { metadata: 'audio/metadata.json' });

      await runExportStage(session);

      const ass = await readFile(path.join(dir, 'output/Example.ja-zh.ass'), 'utf8');
      expect(ass).toContain(`PlayResX: ${width}\nPlayResY: ${height}\n`);
      expect(ass).toContain(`Style: Default,Arial,${fontSize},`);
      const style = ass
        .split('\n')
        .find((line) => line.startsWith('Style:'))!
        .split(',');
      const scale = Math.min(width / 1920, height / 1080);
      expect(style.slice(19, 22).map(Number)).toEqual([
        Math.round(40 * scale),
        Math.round(40 * scale),
        Math.round(32 * scale)
      ]);
      expect(ass).toContain('こんにちは\\N你好');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each(['audio-only', 'missing metadata'])('uses a fallback canvas for %s', async (kind) => {
    const dir = await preparedCompleteSession();
    try {
      const session = await Session.loadOrCreate(dir);
      session.updateStage('audio', { metadata: 'audio/metadata.json' });
      if (kind === 'audio-only') {
        await mkdir(path.join(dir, 'audio'), { recursive: true });
        await writeFile(
          path.join(dir, 'audio/metadata.json'),
          JSON.stringify({ streams: [{ codec_type: 'audio' }] })
        );
      }

      await runExportStage(session);

      const ass = await readFile(path.join(dir, 'output/Example.ja-zh.ass'), 'utf8');
      expect(ass).toContain('PlayResX: 1920\nPlayResY: 1080\n');
      expect(ass).toContain('Style: Default,Arial,42,');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
