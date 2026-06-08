import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { breadc } from 'breadc';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerClipCommands } from '../src/clips/commands.js';
import { registerSegmentCommands } from '../src/segments/commands.js';
import { writeSegmentsFile } from '../src/segments/index.js';
import {
  preparedSession,
  sampleTranscript,
  sampleTranslation,
  tempDir
} from './helpers.js';

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
    await writeFile(patchPath, ['[[edits]]', 'id = "1"', 'zh = "您好"'].join('\n'));

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
      Readable.from([['[[edits]]', 'id = "1"', 'zh = "您好"'].join('\n')])
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

  process.argv = ['node', cliPath, ...argv];
  process.exitCode = undefined;
  try {
    await import(/* @vite-ignore */ `${cliUrl}?cli-target-test=${cliImportCounter++}`);
    await new Promise<void>((resolve) => setImmediate(resolve));
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
