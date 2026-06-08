import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { runDoctor } from '../src/doctor.js';
import { Session } from '../src/index.js';
import { readRuntimeConfig } from '../src/utils/env.js';
import { TRANSCRIPTION_MODEL } from '../src/workflow/transcription.js';
import type { RuntimeConfig } from '../src/types.js';
import { tempDir } from './helpers.js';

describe('runtime environment', () => {
  it('loads cwd .env and lets session .env override cwd and original environment', async () => {
    const cwd = await tempDir();
    const sessionDir = await tempDir();
    process.env.OPENAI_API_KEY = 'from-process';
    process.env.OPENAI_BASE_URL = 'https://process.example';
    process.env.RAJIO_FFMPEG_BIN = 'process-ffmpeg';
    await writeFile(
      path.join(cwd, '.env'),
      [
        'OPENAI_API_KEY=from-cwd',
        'OPENAI_BASE_URL=https://cwd.example',
        'RAJIO_FFMPEG_BIN=cwd-ffmpeg',
        'RAJIO_FFPROBE_BIN=cwd-ffprobe'
      ].join('\n')
    );
    await writeFile(
      path.join(sessionDir, '.env'),
      ['OPENAI_API_KEY=from-session', 'RAJIO_FFMPEG_BIN=session-ffmpeg'].join('\n')
    );

    expect(await readRuntimeConfig({ cwd, sessionDir })).toEqual({
      openaiApiKey: 'from-session',
      openaiBaseUrl: 'https://cwd.example',
      ffmpegBin: 'session-ffmpeg',
      ffprobeBin: 'cwd-ffprobe'
    });
  });
});

describe('doctor', () => {
  it('runs against a plain directory without creating or discovering a session', async () => {
    const cwd = await tempDir();
    await writeFile(path.join(cwd, 'a.md'), '');
    await writeFile(path.join(cwd, 'b.md'), '');
    process.env.OPENAI_API_KEY = 'from-process';

    const session = await Session.load(cwd);
    const result = await runDoctor(session, {
      cwd,
      deps: {
        execa: vi.fn(async (command: string) => ({
          stdout: `${command} version test`
        })) as never,
        listProviderModels: async () => [TRANSCRIPTION_MODEL],
        createCodex: () => undefined,
        nodeVersion: '24.1.0'
      }
    });

    expect(result.ok).toBe(true);
    expect(checkByName(result, '.env')).toMatchObject({ status: 'warn' });
    await expect(readFile(path.join(cwd, 'session.toml'), 'utf8')).rejects.toThrow();
  });

  it('checks env files, provider connectivity, Codex, ffmpeg, ffprobe, and Node.js', async () => {
    const cwd = await tempDir();
    const sessionDir = path.join(cwd, 'session');
    await mkdir(sessionDir);
    await writeFile(path.join(sessionDir, 'video.mp4'), 'media');
    await writeFile(
      path.join(sessionDir, 'description.md'),
      ['---', 'media: ./video.mp4', 'title: Example', '---', '', 'context'].join('\n')
    );
    await writeFile(
      path.join(cwd, '.env'),
      [
        'OPENAI_API_KEY=from-cwd',
        'OPENAI_BASE_URL=https://cwd.example',
        'RAJIO_FFMPEG_BIN=cwd-ffmpeg',
        'RAJIO_FFPROBE_BIN=cwd-ffprobe'
      ].join('\n')
    );
    await writeFile(
      path.join(sessionDir, '.env'),
      ['OPENAI_API_KEY=from-session', 'RAJIO_FFMPEG_BIN=session-ffmpeg'].join('\n')
    );
    const execaMock = vi.fn(async (command: string) => ({
      stdout: `${command} version test`
    }));
    const seenProviderConfigs: RuntimeConfig[] = [];
    const seenCodexConfigs: RuntimeConfig[] = [];
    const session = await Session.loadOrCreate(sessionDir);

    const result = await runDoctor(session, {
      cwd,
      deps: {
        execa: execaMock as never,
        listProviderModels: async (runtime) => {
          seenProviderConfigs.push(runtime);
          return [TRANSCRIPTION_MODEL];
        },
        createCodex: (runtime) => {
          seenCodexConfigs.push(runtime);
        },
        nodeVersion: '24.1.0'
      }
    });

    expect(result.ok).toBe(true);
    expect(execaMock.mock.calls.map((call) => call[0])).toEqual(['session-ffmpeg', 'cwd-ffprobe']);
    expect(seenProviderConfigs[0]?.openaiApiKey).toBe('from-session');
    expect(seenProviderConfigs[0]?.openaiBaseUrl).toBe('https://cwd.example');
    expect(seenCodexConfigs[0]?.openaiApiKey).toBe('from-session');
    expect(checkByName(result, 'provider')).toMatchObject({ status: 'pass' });
  });

  it('fails early-visible checks when credentials and runtime are missing', async () => {
    const cwd = await tempDir();
    await writeFile(path.join(cwd, 'video.mp4'), 'media');
    await writeFile(
      path.join(cwd, 'description.md'),
      ['---', 'media: ./video.mp4', 'title: Example', '---', '', 'context'].join('\n')
    );
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.RAJIO_FFMPEG_BIN;
    delete process.env.RAJIO_FFPROBE_BIN;
    const session = await Session.loadOrCreate(cwd);

    const result = await runDoctor(session, {
      cwd,
      deps: {
        execa: vi.fn(async () => {
          throw new Error('not found');
        }) as never,
        listProviderModels: async () => {
          throw new Error('must not connect without a key');
        },
        nodeVersion: '23.0.0'
      }
    });

    expect(result.ok).toBe(false);
    expect(checkByName(result, '.env')).toMatchObject({ status: 'warn' });
    expect(checkByName(result, 'OPENAI_API_KEY')).toMatchObject({ status: 'fail' });
    expect(checkByName(result, 'node')).toMatchObject({ status: 'fail' });
    expect(checkByName(result, 'ffmpeg')).toMatchObject({ status: 'fail' });
    expect(checkByName(result, 'provider')).toMatchObject({ status: 'fail' });
    expect(checkByName(result, 'codex')).toMatchObject({ status: 'fail' });
  });
});

function checkByName(result: Awaited<ReturnType<typeof runDoctor>>, name: string) {
  const check = result.checks.find((item) => item.name === name);
  expect(check).toBeDefined();
  return check!;
}
