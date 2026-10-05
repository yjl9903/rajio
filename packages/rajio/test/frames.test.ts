import * as fs from 'node:fs/promises';
import path from 'node:path';
import { breadc } from 'breadc';
import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { formatFrameResult, registerFrameCommands } from '../src/frames/commands.js';
import { extractFrames, resolveFrameRequest } from '../src/frames/extract.js';
import { Session } from '../src/session/index.js';
import { preparedSession, tempDir } from './helpers.js';

vi.mock('execa', () => ({ execa: vi.fn() }));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

const metadata = { streams: [{ codec_type: 'video' }], format: { duration: '4' } };
const run = vi.mocked(execa);

beforeEach(() => {
  run.mockReset();
  run.mockImplementation((async (_bin: string, args: string[]) => {
    if (args.includes('-show_streams')) return { stdout: JSON.stringify(metadata) };
    await fs.writeFile(args.at(-1)!, 'PNG fixture');
    return { stdout: '', stderr: '' };
  }) as unknown as typeof execa);
});
afterEach(() => vi.restoreAllMocks());

function app() {
  const app = breadc('rajio-test');
  registerFrameCommands(app);
  return app;
}

async function media() {
  const dir = await tempDir();
  const file = path.join(dir, 'video.mp4');
  await fs.writeFile(file, 'video fixture');
  return { dir, file };
}

describe('frame requests', () => {
  it('preserves point order, deduplicates, and samples subinterval midpoints', () => {
    expect(resolveFrameRequest({ at: [2, 0, 2, 1.23] })).toEqual({ times: [2, 0, 1.23] });
    expect(resolveFrameRequest({ start: 120, end: 150, count: 6 })).toEqual({
      times: [122.5, 127.5, 132.5, 137.5, 142.5, 147.5],
      end: 150
    });
    expect(resolveFrameRequest({ start: 0, end: 4, count: 1 }).times).toEqual([2]);
  });

  it.each([
    {},
    { at: [] },
    { at: [-1] },
    { at: [Infinity] },
    { at: [NaN] },
    { at: [1], start: 0 },
    { at: [1], end: 2 },
    { at: [1], count: 2 },
    { start: 0, end: 1 },
    { start: -1, end: 1, count: 1 },
    { start: 1, end: 1, count: 1 },
    { start: 0, end: Infinity, count: 1 },
    { start: 0, end: 4, count: 0 },
    { start: 0, end: 4, count: 25 },
    { start: 0, end: 4, count: 1.5 },
    { at: Array.from({ length: 25 }, (_, i) => i) }
  ])('rejects invalid requests %j', (options) => {
    expect(() => resolveFrameRequest(options)).toThrow();
  });

  it.each(['', ' ', '1,', ',1', '1,,2', '0x10', '1e2', 'NaN', 'Infinity', '-1', '00:01'])(
    'rejects non-decimal --at %j before probing',
    async (at) => {
      await expect(app().run(['frames', '/missing', '--at', at])).rejects.toThrow();
      expect(run).not.toHaveBeenCalled();
    }
  );

  it('rejects unsupported flags and passthrough arguments', async () => {
    for (const args of [
      ['--output-dir', '/tmp'],
      ['--media', '/tmp/video'],
      ['--', 'extra']
    ]) {
      await expect(app().run(['frames', '/missing', '--at', '0', ...args])).rejects.toThrow();
    }
    expect(run).not.toHaveBeenCalled();
  });
});

describe('frame extraction', () => {
  it('uses unique fixed batches beside direct media, ignoring adjacent session files', async () => {
    const { dir, file } = await media();
    await fs.writeFile(path.join(dir, 'session.toml'), 'invalid session');
    const first = await extractFrames(file, { times: [1.23, 0] });
    const second = await extractFrames(file, { times: [0] });
    expect(path.dirname(first.output_dir)).toBe(path.join(dir, 'frames'));
    expect(first.output_dir).not.toBe(second.output_dir);
    expect(first.frames).toEqual(
      [1.23, 0].map((time, i) => ({
        time,
        path: path.join(first.output_dir, `frame-00${i + 1}.png`)
      }))
    );
    expect(await fs.readFile(path.join(dir, 'session.toml'), 'utf8')).toBe('invalid session');
    expect(run).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['-ss', '1.23', '-map', '0:V:0', '-fps_mode', 'passthrough'])
    );
  });

  it('does not create a standalone session and supports decimal submicrosecond requests', async () => {
    const { dir, file } = await media();
    await extractFrames(file, { times: [0.0000001] });
    expect(await fs.readdir(dir)).toEqual(['frames', 'video.mp4']);
    expect(run).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['-ss', '0.0000001'])
    );
  });

  it('loads session media without changing saved state, hashes or workflow stages', async () => {
    const dir = await preparedSession('translation_work', {});
    const session = await Session.load(dir);
    session.state.input.media_sha256 = 'stale-hash';
    const external = await media();
    session.state.input.media = external.file;
    await session.save();
    const before = await fs.readFile(session.path, 'utf8');
    for (const target of [dir, session.path]) {
      const result = await extractFrames(target, { times: [0] });
      expect(path.dirname(result.output_dir)).toBe(path.join(dir, 'frames'));
      expect(run).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(['-i', external.file])
      );
    }
    expect(await fs.readFile(session.path, 'utf8')).toBe(before);
    await session.clean();
    expect(await fs.readdir(path.join(dir, 'frames'))).toHaveLength(2);
  });

  it('requires an existing compatible session; rejects descriptions and missing input', async () => {
    const { dir, file } = await media();
    await expect(extractFrames(dir, { times: [0] })).rejects.toThrow('existing session.toml');
    await fs.writeFile(path.join(dir, 'description.md'), 'notes');
    await expect(extractFrames(path.join(dir, 'description.md'), { times: [0] })).rejects.toThrow(
      'frames accepts'
    );
    const session = await Session.loadOrCreate(file);
    await fs.writeFile(
      session.path,
      (await fs.readFile(session.path, 'utf8')).replace(
        /rajio_version = "[^"]+"/,
        'rajio_version = "old"'
      )
    );
    await expect(extractFrames(dir, { times: [0] })).rejects.toThrow('version');
    await expect(extractFrames(path.join(dir, 'missing.mp4'), { times: [0] })).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });

  it.each(
    [
      [],
      [{ codec_type: 'audio' }],
      [{ codec_type: 'video', disposition: { attached_pic: 1 } }],
      [{ codec_type: 'video', disposition: { timed_thumbnails: 1 } }]
    ].map((streams) => ({ streams }))
  )('rejects missing video before creating a batch: %j', async ({ streams }) => {
    const { dir, file } = await media();
    run.mockResolvedValueOnce({ stdout: JSON.stringify({ streams }) } as never);
    await expect(extractFrames(file, { times: [0] })).rejects.toThrow('No usable video');
    expect(await fs.readdir(dir)).toEqual(['video.mp4']);
  });

  it('rejects known out-of-range times and endpoints before creating a batch', async () => {
    const { dir, file } = await media();
    await expect(extractFrames(file, { times: [4] })).rejects.toThrow('Requested time 4');
    await expect(extractFrames(file, { times: [2.5], end: 5 })).rejects.toThrow('--end');
    expect(await fs.readdir(dir)).toEqual(['video.mp4']);
  });

  it('allows unknown duration instead of treating it as zero', async () => {
    const { file } = await media();
    run.mockResolvedValueOnce({ stdout: JSON.stringify({ streams: metadata.streams }) } as never);
    expect((await extractFrames(file, { times: [100] })).frames[0].time).toBe(100);
  });

  it.each(['missing', 'empty', 'error'])(
    'removes only the failed batch when a later frame is %s',
    async (failure) => {
      const { dir, file } = await media();
      const previous = await extractFrames(file, { times: [0] });
      run.mockResolvedValueOnce({ stdout: JSON.stringify(metadata) } as never);
      run.mockImplementationOnce((async (_bin: string, args: string[]) => {
        await fs.writeFile(args.at(-1)!, 'first frame');
        return { stdout: '' };
      }) as unknown as typeof execa);
      run.mockImplementationOnce((async (_bin: string, args: string[]) => {
        if (failure === 'error') throw new Error('decode failed');
        if (failure === 'empty') await fs.writeFile(args.at(-1)!, '');
        return { stdout: '' };
      }) as unknown as typeof execa);
      const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
      await expect(app().run(['frames', file, '--at', '0,3.99', '--json'])).rejects.toThrow(
        'requested time 3.99'
      );
      expect(stdout).not.toHaveBeenCalled();
      expect(await fs.readdir(path.join(dir, 'frames'))).toEqual([
        path.basename(previous.output_dir)
      ]);
      expect((await fs.stat(previous.frames[0].path)).size).toBeGreaterThan(0);
    }
  );

  it('reports original failure and an unsuccessful cleanup with its path', async () => {
    const { file } = await media();
    run.mockResolvedValueOnce({ stdout: JSON.stringify(metadata) } as never);
    run.mockRejectedValueOnce(new Error('decode failure'));
    vi.mocked(fs.rm).mockRejectedValueOnce(new Error('permission denied'));
    await expect(extractFrames(file, { times: [1.5] })).rejects.toThrow(
      /requested time 1.5[\s\S]*decode failure[\s\S]*Could not remove batch directory .*capture-.*permission denied/
    );
  });

  it('reports missing tools without a success result', async () => {
    const { file } = await media();
    run.mockRejectedValueOnce(new Error('spawn ffprobe ENOENT'));
    await expect(extractFrames(file, { times: [0] })).rejects.toThrow('Could not probe media');
    run.mockResolvedValueOnce({ stdout: JSON.stringify(metadata) } as never);
    run.mockRejectedValueOnce(new Error('spawn ffmpeg ENOENT'));
    await expect(extractFrames(file, { times: [0] })).rejects.toThrow('requested time 0');
  });

  it('fails when the fixed output directory cannot be created, without falling back', async () => {
    const { dir, file } = await media();
    await fs.writeFile(path.join(dir, 'frames'), 'occupied');
    await expect(extractFrames(file, { times: [0] })).rejects.toThrow();
    expect(run).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(path.join(dir, 'frames'), 'utf8')).toBe('occupied');
  });

  it('loads binary overrides from the media parent .env without requiring credentials', async () => {
    const { dir, file } = await media();
    await fs.writeFile(
      path.join(dir, '.env'),
      'FFMPEG_PATH=/custom/ffmpeg\nFFPROBE_PATH=/custom/ffprobe\n'
    );
    const result = await extractFrames(file, { times: [0] });
    expect(result.frames).toHaveLength(1);
    expect(run.mock.calls.map((call) => call[0])).toEqual(['/custom/ffprobe', '/custom/ffmpeg']);
  });
});

describe('frame output', () => {
  const result = {
    output_dir: '/work/frames/capture-test',
    frames: [
      { time: 1.234567, path: '/work/frames/capture-test/frame-001.png' },
      { time: 0, path: '/work/a,"b\nc.png' }
    ]
  };

  it('uses compact or pretty JSON in preference to TTY with only the agreed fields', () => {
    expect(formatFrameResult(result, { json: true })).toBe(JSON.stringify(result) + '\n');
    expect(formatFrameResult(result, { json: true, isTTY: true })).toBe(
      JSON.stringify(result, null, 2) + '\n'
    );
  });

  it('prints CSV with fixed columns, exact times and escaped paths', () => {
    expect(formatFrameResult(result, {})).toBe(
      'time,path\n1.234567,/work/frames/capture-test/frame-001.png\n0,"/work/a,""b\nc.png"\n'
    );
  });

  it('prints a full-width TTY table and directory', () => {
    const output = formatFrameResult({ ...result, frames: [result.frames[0]] }, { isTTY: true });
    expect(output).toContain('Output directory: /work/frames/capture-test\n\nTIME');
    expect(output).toContain('1.234567  /work/frames/capture-test/frame-001.png');
    expect(output.endsWith('\n')).toBe(true);
  });

  it.each([
    ['--at', '2,0,2'],
    ['--start', '0', '--end', '4', '--count', '2']
  ])('prints one complete JSON result for %j', async (...args) => {
    const { file } = await media();
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await app().run(['frames', file, ...args, '--json']);
    expect(stdout).toHaveBeenCalledTimes(1);
    const output = JSON.parse(String(stdout.mock.calls[0][0]));
    expect(Object.keys(output)).toEqual(['output_dir', 'frames']);
    expect(output.frames.map((frame: { time: number }) => frame.time)).toEqual(
      args[0] === '--at' ? [2, 0] : [1, 3]
    );
    expect(Object.keys(output.frames[0])).toEqual(['time', 'path']);
  });
});
