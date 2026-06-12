import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { breadc } from 'breadc';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerClipCommands } from '../src/clips/commands.js';
import { registerSegmentCommands } from '../src/segments/commands.js';
import { writeSegmentsFile } from '../src/segments/index.js';
import { preparedSession, sampleTranscript, sampleTranslation, tempDir } from './helpers.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const cliPath = path.join(repoRoot, 'packages/rajio/src/cli.ts');
const cliUrl = pathToFileURL(cliPath).href;
let cliImportCounter = 0;

describe('cli explicit targets', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists segments with target as the first positional argument', async () => {
    const dir = await preparedSession('transcript_work', {
      transcript_work: {
        status: 'waiting',
        segments: 'transcript/work/segments.toml'
      }
    });
    await mkdir(path.join(dir, 'transcript/work'), { recursive: true });
    await writeSegmentsFile(path.join(dir, 'transcript/work/segments.toml'), sampleTranscript());

    const stdout = mockStdout();
    await createCommandApp().run(['segments', 'list', dir, '--stage', 'transcript', '--json']);

    const output = JSON.parse(stdout.text()) as { segments: Array<{ id: string }> };
    expect(output.segments.map((segment) => segment.id)).toEqual(['1', '2']);
  });

  it('filters segments list by one id', async () => {
    const dir = await preparedSession('transcript_work', {
      transcript_work: {
        status: 'waiting',
        segments: 'transcript/work/segments.toml'
      }
    });
    await mkdir(path.join(dir, 'transcript/work'), { recursive: true });
    await writeSegmentsFile(path.join(dir, 'transcript/work/segments.toml'), sampleTranscript());

    const stdout = mockStdout();
    await createCommandApp().run([
      'segments',
      'list',
      dir,
      '--stage',
      'transcript',
      '--id',
      '2',
      '--json'
    ]);

    const output = JSON.parse(stdout.text()) as { segments: Array<{ id: string }> };
    expect(output.segments.map((segment) => segment.id)).toEqual(['2']);
  });

  it('filters segments list by validation issue code', async () => {
    const dir = await preparedSession('translation_work', {
      translation_work: {
        status: 'waiting',
        segments: 'translation/work/segments.toml'
      }
    });
    await mkdir(path.join(dir, 'translation/work'), { recursive: true });
    await writeSegmentsFile(
      path.join(dir, 'translation/work/segments.toml'),
      {
        version: 1,
        source: { kind: 'translation', generated_at: '2026-06-06T00:00:00.000Z' },
        segments: [
          { id: 'translated', start: 0, end: 1, speaker: 'A', ja: 'はい', zh: '是' },
          { id: 'missing-zh', start: 1.3, end: 2.3, speaker: 'A', ja: '未翻訳' }
        ]
      },
      { validate: false }
    );

    const stdout = mockStdout();
    await createCommandApp().run([
      'segments',
      'list',
      dir,
      '--stage',
      'translation',
      '--issues',
      'empty_zh',
      '--json'
    ]);

    const output = JSON.parse(stdout.text()) as { segments: Array<{ id: string }> };
    expect(output.segments.map((segment) => segment.id)).toEqual(['missing-zh']);
    await expect(
      createCommandApp().run([
        'segments',
        'list',
        dir,
        '--stage',
        'translation',
        '--issues',
        'unknown_code'
      ])
    ).rejects.toThrow('--issues must be a comma-separated list');
  });

  it('splits segments with a custom midpoint gap', async () => {
    const dir = await preparedSession('transcript_work', {
      transcript_work: {
        status: 'waiting',
        segments: 'transcript/work/segments.toml'
      }
    });
    await mkdir(path.join(dir, 'transcript/work'), { recursive: true });
    await writeSegmentsFile(path.join(dir, 'transcript/work/segments.toml'), sampleTranscript());

    const stdout = mockStdout();
    await createCommandApp().run([
      'segments',
      'split',
      dir,
      '1',
      '--stage',
      'transcript',
      '--at',
      '0.6',
      '--gap',
      '0.1',
      '--id1',
      '1.1',
      '--id2',
      '1.2',
      '--ja1',
      'こん',
      '--ja2',
      'にちは',
      '--dry-run',
      '--json'
    ]);

    const output = JSON.parse(stdout.text()) as {
      segments: Array<{ id: string; start: number; end: number }>;
    };
    expect(output.segments).toEqual([
      expect.objectContaining({ id: '1.1', start: 0, end: 0.55 }),
      expect.objectContaining({ id: '1.2', start: 0.65, end: 1.2 })
    ]);
  });

  it('rejects extra segment list ids after --id', async () => {
    const dir = await preparedSession('transcript_work', {
      transcript_work: {
        status: 'waiting',
        segments: 'transcript/work/segments.toml'
      }
    });
    await mkdir(path.join(dir, 'transcript/work'), { recursive: true });
    await writeSegmentsFile(path.join(dir, 'transcript/work/segments.toml'), sampleTranscript());

    await expect(
      createCommandApp().run(['segments', 'list', dir, '--stage', 'transcript', '--id', '1', '2'])
    ).rejects.toThrow('Unexpected argument: 2');
  });

  it('applies a patch with target before patch path', async () => {
    const dir = await preparedTranslationSession();
    const patchPath = path.join(dir, 'patch.toml');
    await writeFile(
      patchPath,
      ['[[operations]]', 'op = "edit"', 'segment_id = "1"', 'zh = "您好"'].join('\n')
    );

    const stdout = mockStdout();
    await createCommandApp().run([
      'segments',
      'apply',
      dir,
      patchPath,
      '--stage',
      'translation',
      '--dry-run',
      '--json'
    ]);

    expect(JSON.parse(stdout.text())).toEqual({
      stats: { edits: 1, splits: 0, merges: 0, deletes: 0, total: 1 }
    });
    expect(await readFile(path.join(dir, 'translation/work/segments.toml'), 'utf8')).not.toContain(
      '您好'
    );
  });

  it('reads a patch from stdin when no patch path is provided', async () => {
    const dir = await preparedTranslationSession();
    const restoreStdin = replaceStdin(
      Readable.from([
        ['[[operations]]', 'op = "edit"', 'segment_id = "1"', 'zh = "您好"'].join('\n')
      ])
    );
    const stdout = mockStdout();

    try {
      await createCommandApp().run([
        'segments',
        'apply',
        dir,
        '--stage',
        'translation',
        '--dry-run',
        '--json'
      ]);
    } finally {
      restoreStdin();
    }

    expect(JSON.parse(stdout.text())).toEqual({
      stats: { edits: 1, splits: 0, merges: 0, deletes: 0, total: 1 }
    });
  });

  it('lists and shows clips with target before clip id', async () => {
    const dir = await preparedSession('transcript_work', {});
    await writeClipFixture(dir);

    const listStdout = mockStdout();
    await createCommandApp().run(['clips', 'list', dir, '--json']);
    expect(JSON.parse(listStdout.text())).toEqual({
      clips: [
        {
          id: 'clip-120000-180000',
          label: 'noisy-overlap',
          start: 120,
          end: 180,
          duration: 60,
          status: 'done',
          segments: 2
        }
      ]
    });

    const showStdout = mockStdout();
    await createCommandApp().run(['clips', 'show', dir, 'clip-120000-180000', '--json']);
    const output = JSON.parse(showStdout.text()) as { segments: Array<{ id: string }> };
    expect(output.segments.map((segment) => segment.id)).toEqual(['1', '2']);
  });

  it('requires target on utility commands', async () => {
    vi.useRealTimers();
    for (const command of ['check', 'doctor', 'clean']) {
      const result = await runCliSideEffect([command]);
      expect(result.exitCode).toBe(1);
    }
  });

  it('cleans generated artifacts without creating a missing session', async () => {
    vi.useRealTimers();
    const dir = await tempDir();
    await mkdir(path.join(dir, 'output'), { recursive: true });
    await writeFile(path.join(dir, 'output/example.zh.srt'), 'subtitle');

    const result = await runCliSideEffect(['clean', dir]);

    expect(result.exitCode).toBeUndefined();
    await expect(readFile(path.join(dir, 'output/example.zh.srt'), 'utf8')).rejects.toThrow();
    await expect(readFile(path.join(dir, 'session.toml'), 'utf8')).rejects.toThrow();
  });

  it('does not create a session when segment commands require an existing manual stage', async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, 'video.mp4'), 'media');
    await writeFile(
      path.join(dir, 'description.md'),
      ['---', 'media: ./video.mp4', 'title: Example', '---', '', 'context'].join('\n')
    );

    await expect(
      createCommandApp().run(['segments', 'list', dir, '--stage', 'transcript'])
    ).rejects.toThrow('transcript_work does not have a work segments path.');
    await expect(readFile(path.join(dir, 'session.toml'), 'utf8')).rejects.toThrow();
  });

  it('rejects unknown segment and clip options before session resolution', async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, 'a.md'), 'a');
    await writeFile(path.join(dir, 'b.md'), 'b');
    const cwd = process.cwd();
    process.chdir(dir);

    try {
      await expect(
        createCommandApp().run([
          'segments',
          'list',
          '--unknown-target',
          dir,
          '--stage',
          'transcript'
        ])
      ).rejects.toThrow('Unknown option: --unknown-target');
      await expect(
        createCommandApp().run(['clips', 'list', '--unknown-target', dir])
      ).rejects.toThrow('Unknown option: --unknown-target');
    } finally {
      process.chdir(cwd);
    }
  });

  it('rejects removed check level all', async () => {
    const result = await runCliSideEffect([
      'check',
      '/tmp/rajio-missing-session',
      '--level',
      'all'
    ]);

    expect(result.exitCode).toBe(1);
  });

  it('rejects Chinese language filtering for transcript check', async () => {
    const dir = await preparedSession('transcript_work', {
      transcript_work: {
        status: 'waiting',
        segments: 'transcript/work/segments.toml'
      }
    });
    await mkdir(path.join(dir, 'transcript/work'), { recursive: true });
    await writeSegmentsFile(path.join(dir, 'transcript/work/segments.toml'), sampleTranscript());

    const result = await runCliSideEffect([
      'check',
      dir,
      '--stage',
      'transcript',
      '--language',
      'zh'
    ]);

    expect(result.exitCode).toBe(1);
  });
});

function createCommandApp(): ReturnType<typeof breadc> {
  const app = breadc('rajio-test');
  registerSegmentCommands(app);
  registerClipCommands(app);
  return app;
}

async function runCliSideEffect(argv: string[]): Promise<{
  exitCode: string | number | undefined;
  stderr: string;
}> {
  const originalArgv = process.argv;
  const originalExitCode = process.exitCode;
  let stderr = '';
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  }) as typeof process.stderr.write);
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderr += `${args.join(' ')}\n`;
  });

  process.argv = ['node', cliPath, ...argv];
  process.exitCode = undefined;
  try {
    await import(/* @vite-ignore */ `${cliUrl}?cli-target-test=${cliImportCounter++}`);
    return { exitCode: process.exitCode, stderr };
  } finally {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
  }
}

async function preparedTranslationSession(): Promise<string> {
  const dir = await preparedSession('translation_work', {
    translation_work: {
      status: 'waiting',
      segments: 'translation/work/segments.toml'
    }
  });
  await mkdir(path.join(dir, 'translation/work'), { recursive: true });
  await writeSegmentsFile(path.join(dir, 'translation/work/segments.toml'), sampleTranslation(), {
    requireZh: true
  });
  return dir;
}

async function writeClipFixture(dir: string): Promise<void> {
  const clipDir = path.join(dir, 'clips/clip-120000-180000');
  await mkdir(clipDir, { recursive: true });
  await writeFile(
    path.join(clipDir, 'clip.toml'),
    [
      'id = "clip-120000-180000"',
      'label = "noisy-overlap"',
      'start = 120',
      'end = 180',
      'segments = "segments.toml"'
    ].join('\n')
  );
  await writeSegmentsFile(path.join(clipDir, 'segments.toml'), sampleTranscript());
}

function mockStdout(): { text: () => string } {
  let output = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    output += chunk.toString();
    return true;
  }) as typeof process.stdout.write);
  return { text: () => output };
}

function replaceStdin(stream: Readable): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'stdin');
  Object.defineProperty(process, 'stdin', { configurable: true, value: stream });
  return () => {
    if (descriptor) {
      Object.defineProperty(process, 'stdin', descriptor);
    }
  };
}
