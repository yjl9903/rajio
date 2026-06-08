import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { Session } from '../src/index.js';
import { checkRajio } from '../src/session/check.js';
import { preparedSession, tempDir } from './helpers.js';

describe('session target resolution', () => {
  it('uses markdown parent as session and resolves frontmatter media', async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, 'video.mp4'), '');
    await writeFile(
      path.join(dir, 'description.md'),
      ['---', 'media: ./video.mp4', 'title: Example', '---', '', 'context'].join('\n')
    );

    const session = await Session.loadOrCreate(path.join(dir, 'description.md'));

    expect(session.dir).toBe(dir);
    expect(session.mediaPath).toBe(path.join(dir, 'video.mp4'));
    expect(session.description.frontmatter.title).toBe('Example');
    expect(session.description.body).toBe('context');
  });

  it('rejects ambiguous directory markdown descriptions', async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, 'a.md'), '');
    await writeFile(path.join(dir, 'b.md'), '');

    await expect(Session.loadOrCreate(dir)).rejects.toThrow('Multiple description markdown files');
  });

  it('restores existing session description instead of rescanning markdown files', async () => {
    const dir = await preparedSession('transcript_work', {});
    await writeFile(path.join(dir, 'notes.md'), 'extra notes');

    const session = await Session.loadOrCreate(dir);

    expect(session.description.frontmatter.title).toBe('Example');
    expect(session.description.body).toBe('context');
  });

  it('persists and reuses the media path from session.toml in directory targets', async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, 'video-main.mp4'), 'media');
    await writeFile(
      path.join(dir, 'description.md'),
      ['---', 'title: Example', '---', '', 'context'].join('\n')
    );

    const first = await Session.loadOrCreate(dir);
    expect(first.state.input.media).toBe('video-main.mp4');
    await writeFile(path.join(dir, 'video-alt.mp4'), 'alternative');

    const second = await Session.loadOrCreate(dir);
    expect(second.state.input.media).toBe('video-main.mp4');
    expect(second.mediaPath).toBe(path.join(dir, 'video-main.mp4'));
  });

  it('cleans generated session artifacts without deleting session inputs', async () => {
    const dir = await preparedSession('transcript_work', {});
    await writeFile(path.join(dir, 'notes.txt'), 'keep');
    await mkdir(path.join(dir, 'audio', 'chunks'), { recursive: true });
    await mkdir(path.join(dir, 'translation', 'work'), { recursive: true });
    await mkdir(path.join(dir, 'patches'), { recursive: true });
    await mkdir(path.join(dir, 'clips', 'clip-000000-010000'), { recursive: true });
    await mkdir(path.join(dir, 'output'), { recursive: true });
    await writeFile(path.join(dir, 'audio', 'chunks', 'chunk-000.m4a'), 'audio');
    await writeFile(path.join(dir, 'translation', 'work', 'segments.toml'), 'segments');
    await writeFile(path.join(dir, 'patches', 'batch-001.toml'), 'patch');
    await writeFile(path.join(dir, 'clips', 'clip-000000-010000', 'segments.toml'), 'clip');
    await writeFile(path.join(dir, 'output', 'example.zh.srt'), 'srt');

    const session = await Session.loadOrCreate(dir);
    const result = await session.clean();

    expect(result).toEqual([
      'session.toml',
      'audio',
      'transcript',
      'translation',
      'patches',
      'clips',
      'output'
    ]);
    await expect(readFile(path.join(dir, 'session.toml'), 'utf8')).rejects.toThrow();
    await expect(
      readFile(path.join(dir, 'audio', 'chunks', 'chunk-000.m4a'), 'utf8')
    ).rejects.toThrow();
    await expect(
      readFile(path.join(dir, 'transcript', 'raw', 'segments.toml'), 'utf8')
    ).rejects.toThrow();
    await expect(
      readFile(path.join(dir, 'translation', 'work', 'segments.toml'), 'utf8')
    ).rejects.toThrow();
    await expect(readFile(path.join(dir, 'patches', 'batch-001.toml'), 'utf8')).rejects.toThrow();
    await expect(
      readFile(path.join(dir, 'clips', 'clip-000000-010000', 'segments.toml'), 'utf8')
    ).rejects.toThrow();
    await expect(readFile(path.join(dir, 'output', 'example.zh.srt'), 'utf8')).rejects.toThrow();
    await expect(readFile(path.join(dir, 'video.mp4'), 'utf8')).resolves.toBe('media');
    await expect(readFile(path.join(dir, 'description.md'), 'utf8')).resolves.toContain(
      'title: Example'
    );
    await expect(readFile(path.join(dir, 'notes.txt'), 'utf8')).resolves.toBe('keep');
  });

  it('loads sessions for validation without creating session.toml', async () => {
    const dir = await tempDir();

    const session = await Session.load(dir);
    const result = await checkRajio(session);

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({
        file: path.join(dir, 'session.toml'),
        level: 'error',
        code: 'missing_session',
        message: 'Missing session.toml.'
      })
    ]);
    await expect(readFile(path.join(dir, 'session.toml'), 'utf8')).rejects.toThrow();
  });
});
