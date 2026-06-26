import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { isElevenLabsProbeSuccessError, runDoctor, type DoctorDeps } from '../src/doctor.js';
import { Session } from '../src/index.js';
import { rajioVersion } from '../src/package.js';
import { readRuntimeConfig } from '../src/utils/env.js';
import type { RuntimeConfig } from '../src/types.js';
import { tempDir } from './helpers.js';

describe('runtime environment', () => {
  it('loads cwd .env and lets session .env override cwd and original environment', async () => {
    const cwd = await tempDir();
    const sessionDir = await tempDir();
    process.env.OPENAI_API_KEY = 'from-process';
    process.env.OPENAI_BASE_URL = 'https://process.example';
    process.env.FFMPEG_PATH = 'process-ffmpeg';
    await writeFile(
      path.join(cwd, '.env'),
      [
        'OPENAI_API_KEY=from-cwd',
        'OPENAI_BASE_URL=https://cwd.example',
        'ELEVENLABS_API_KEY=from-cwd-elevenlabs',
        'FFMPEG_PATH=cwd-ffmpeg',
        'FFPROBE_PATH=cwd-ffprobe'
      ].join('\n')
    );
    await writeFile(
      path.join(sessionDir, '.env'),
      [
        'OPENAI_API_KEY=from-session',
        'ELEVENLABS_API_KEY=from-session-elevenlabs',
        'FFMPEG_PATH=session-ffmpeg'
      ].join('\n')
    );

    expect(await readRuntimeConfig({ cwd, sessionDir })).toEqual({
      openaiApiKey: 'from-session',
      openaiBaseUrl: 'https://cwd.example',
      elevenlabsApiKey: 'from-session-elevenlabs',
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
    process.env.ELEVENLABS_API_KEY = 'from-process-elevenlabs';

    const session = await Session.load(cwd);
    const result = await runDoctor(session, {
      cwd,
      deps: doctorDeps()
    });

    expect(result.ok).toBe(true);
    expect(result.checks.some((check) => check.message.startsWith('Loaded '))).toBe(false);
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
        'ELEVENLABS_API_KEY=from-cwd-elevenlabs',
        'FFMPEG_PATH=cwd-ffmpeg',
        'FFPROBE_PATH=cwd-ffprobe'
      ].join('\n')
    );
    await writeFile(
      path.join(sessionDir, '.env'),
      [
        'OPENAI_API_KEY=from-session',
        'ELEVENLABS_API_KEY=from-session-elevenlabs',
        'FFMPEG_PATH=session-ffmpeg'
      ].join('\n')
    );
    const execaMock = vi.fn(async (command: string) => ({
      stdout: `${command} version test`
    }));
    const seenCodexConfigs: RuntimeConfig[] = [];
    const seenElevenLabsConfigs: RuntimeConfig[] = [];
    const session = await Session.loadOrCreate(sessionDir);

    const result = await runDoctor(session, {
      cwd,
      deps: doctorDeps({
        execa: execaMock as never,
        checkElevenLabs: async (runtime) => {
          seenElevenLabsConfigs.push(runtime);
        },
        createCodex: (runtime) => {
          seenCodexConfigs.push(runtime);
        }
      })
    });

    expect(result.ok).toBe(true);
    expect(result.checks.map((check) => check.name)).toEqual([
      'rajio',
      'node',
      '.env',
      '.env',
      '.env',
      'transcription',
      'openai',
      'ffmpeg',
      'ffprobe',
      'codex'
    ]);
    expect(execaMock.mock.calls.map((call) => call[0])).toEqual(['session-ffmpeg', 'cwd-ffprobe']);
    expect(seenCodexConfigs[0]?.openaiApiKey).toBe('from-session');
    expect(seenElevenLabsConfigs[0]?.elevenlabsApiKey).toBe('from-session-elevenlabs');
    expect(checkByName(result, 'rajio')).toEqual({
      name: 'rajio',
      status: 'pass',
      message: `v${rajioVersion} is up to date`
    });
    expect(result.checks.filter((check) => check.name === '.env')).toEqual([
      { name: '.env', status: 'pass', message: `Loaded ${path.join(cwd, '.env')}` },
      { name: '.env', status: 'pass', message: `Loaded ${path.join(sessionDir, '.env')}` },
      { name: '.env', status: 'pass', message: 'OPENAI_BASE_URL uses https://cwd.example' }
    ]);
    expect(checkByName(result, 'openai')).toEqual({
      name: 'openai',
      status: 'pass',
      message: 'OpenAI API is reachable'
    });
    expect(checkByName(result, 'transcription')).toEqual({
      name: 'transcription',
      status: 'pass',
      message: 'ElevenLabs Speech-to-Text API is reachable'
    });
    expect(checkByName(result, 'ffmpeg')).toMatchObject({
      status: 'pass',
      message: 'session-ffmpeg version test'
    });
    expect(checkByName(result, 'ffprobe')).toMatchObject({
      status: 'pass',
      message: 'cwd-ffprobe version test'
    });
    expect(checkByName(result, 'codex')).toEqual({
      name: 'codex',
      status: 'pass',
      message: '@openai/codex-sdk is installed and initialized'
    });
  });

  it('fails early-visible checks when credentials and runtime are missing', async () => {
    const cwd = await tempDir();
    await writeFile(path.join(cwd, 'video.mp4'), 'media');
    await writeFile(
      path.join(cwd, 'description.md'),
      ['---', 'media: ./video.mp4', 'title: Example', '---', '', 'context'].join('\n')
    );
    delete process.env.OPENAI_API_KEY;
    delete process.env.ELEVENLABS_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.FFMPEG_PATH;
    delete process.env.FFPROBE_PATH;
    const session = await Session.loadOrCreate(cwd);

    const result = await runDoctor(session, {
      cwd,
      deps: doctorDeps({
        execa: vi.fn(async () => {
          throw new Error('not found');
        }) as never,
        nodeVersion: '23.0.0'
      })
    });

    expect(result.ok).toBe(false);
    expect(result.checks.some((check) => check.message.startsWith('Loaded '))).toBe(false);
    expect(
      checkByMessage(result, 'OPENAI_API_KEY is not set; manual AI stages will not work')
    ).toMatchObject({ status: 'warn' });
    expect(checkByName(result, 'node')).toMatchObject({ status: 'fail' });
    expect(checkByName(result, 'ffmpeg')).toMatchObject({ status: 'fail' });
    expect(checkByName(result, 'transcription')).toMatchObject({ status: 'fail' });
    expect(checkByName(result, 'codex')).toMatchObject({ status: 'warn' });
  });

  it('fails when OpenAI API connectivity fails', async () => {
    const cwd = await tempDir();
    process.env.OPENAI_API_KEY = 'from-process';
    process.env.ELEVENLABS_API_KEY = 'from-process-elevenlabs';
    const session = await Session.load(cwd);

    const result = await runDoctor(session, {
      cwd,
      deps: doctorDeps({
        checkOpenAI: async () => {
          throw new Error('api down');
        }
      })
    });

    expect(result.ok).toBe(true);
    expect(checkByName(result, 'openai')).toEqual({
      name: 'openai',
      status: 'warn',
      message: 'OpenAI API check failed',
      detail: 'api down'
    });
  });

  it('fails when ElevenLabs API connectivity fails', async () => {
    const cwd = await tempDir();
    process.env.OPENAI_API_KEY = 'from-process';
    process.env.ELEVENLABS_API_KEY = 'from-process-elevenlabs';
    const session = await Session.load(cwd);

    const result = await runDoctor(session, {
      cwd,
      deps: doctorDeps({
        checkElevenLabs: async () => {
          throw new Error('provider down');
        }
      })
    });

    expect(result.ok).toBe(false);
    expect(checkByName(result, 'transcription')).toEqual({
      name: 'transcription',
      status: 'fail',
      message: 'ElevenLabs API check failed',
      detail: 'provider down'
    });
  });

  it('checks OpenAI transcription provider without ElevenLabs credentials', async () => {
    const cwd = await tempDir();
    process.env.OPENAI_API_KEY = 'from-process';
    delete process.env.ELEVENLABS_API_KEY;
    const session = await Session.load(cwd);
    session.state.transcription = {
      provider: 'openai',
      model: 'whisper-1',
      segmenter: 'integrated'
    };

    const result = await runDoctor(session, {
      cwd,
      deps: doctorDeps()
    });

    expect(result.ok).toBe(true);
    expect(checkByName(result, 'transcription')).toEqual({
      name: 'transcription',
      status: 'pass',
      message: 'OpenAI transcription API is reachable'
    });
  });

  it('accepts ElevenLabs invalid UID as a successful no-upload probe', () => {
    expect(isElevenLabsProbeSuccessError({ statusCode: 404 })).toBe(true);
    expect(
      isElevenLabsProbeSuccessError({
        statusCode: 400,
        body: {
          detail: {
            status: 'invalid_uid',
            message: 'An invalid ID has been received'
          }
        }
      })
    ).toBe(true);
    expect(
      isElevenLabsProbeSuccessError({
        statusCode: 401,
        body: {
          detail: {
            status: 'missing_permissions'
          }
        }
      })
    ).toBe(false);
  });

  it('warns when Codex SDK initialization fails without failing doctor', async () => {
    const cwd = await tempDir();
    process.env.OPENAI_API_KEY = 'from-process';
    process.env.ELEVENLABS_API_KEY = 'from-process-elevenlabs';
    const session = await Session.load(cwd);

    const result = await runDoctor(session, {
      cwd,
      deps: doctorDeps({
        createCodex: () => {
          throw new Error('sdk unavailable');
        }
      })
    });

    expect(result.ok).toBe(true);
    expect(checkByName(result, 'codex')).toEqual({
      name: 'codex',
      status: 'warn',
      message: 'Codex SDK check failed',
      detail: 'sdk unavailable'
    });
  });

  it('warns when a newer rajio version is available without failing doctor', async () => {
    const cwd = await tempDir();
    process.env.OPENAI_API_KEY = 'from-process';
    process.env.ELEVENLABS_API_KEY = 'from-process-elevenlabs';
    const session = await Session.load(cwd);

    const result = await runDoctor(session, {
      cwd,
      deps: doctorDeps({ getLatestRajioVersion: async () => '999.0.0' })
    });

    expect(result.ok).toBe(true);
    expect(checkByName(result, 'rajio')).toEqual({
      name: 'rajio',
      status: 'warn',
      message: `v${rajioVersion} is outdated; latest is v999.0.0`
    });
  });

  it('warns when rajio update check fails without failing doctor', async () => {
    const cwd = await tempDir();
    process.env.OPENAI_API_KEY = 'from-process';
    process.env.ELEVENLABS_API_KEY = 'from-process-elevenlabs';
    const session = await Session.load(cwd);

    const result = await runDoctor(session, {
      cwd,
      deps: doctorDeps({
        getLatestRajioVersion: async () => {
          throw new Error('network down');
        }
      })
    });

    expect(result.ok).toBe(true);
    expect(checkByName(result, 'rajio')).toEqual({
      name: 'rajio',
      status: 'warn',
      message: `v${rajioVersion}; update check failed`,
      detail: 'network down'
    });
  });
});

function doctorDeps(overrides: DoctorDeps = {}): DoctorDeps {
  return {
    checkElevenLabs: async () => undefined,
    checkOpenAI: async () => undefined,
    execa: vi.fn(async (command: string) => ({
      stdout: `${command} version test`
    })) as never,
    createCodex: () => undefined,
    getLatestRajioVersion: async () => rajioVersion,
    nodeVersion: '24.1.0',
    ...overrides
  };
}

function checkByName(result: Awaited<ReturnType<typeof runDoctor>>, name: string) {
  const check = result.checks.find((item) => item.name === name);
  expect(check).toBeDefined();
  return check!;
}

function checkByMessage(result: Awaited<ReturnType<typeof runDoctor>>, message: string) {
  const check = result.checks.find((item) => item.message === message);
  expect(check).toBeDefined();
  return check!;
}
