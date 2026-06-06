import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { stringify } from 'smol-toml';
import { describe, expect, it, vi } from 'vitest';

import { Session } from '../src/index.js';
import { readSegmentsFile, writeSegmentsFile } from '../src/segments/index.js';
import { checkRajio } from '../src/session/check.js';
import { logExportOutputs, runRajio } from '../src/workflow/index.js';
import {
  baseOptions,
  baseSession,
  preparedCompleteSession,
  preparedSession,
  sampleTranscript,
  sampleTranslation
} from './helpers.js';

describe('session workflow', () => {
  it('sets up transcript work from raw and stops at manual stage', async () => {
    const dir = await preparedSession('transcript_work', {
      transcript_raw: {
        status: 'done',
        segments: 'transcript/raw/segments.toml',
        segments_sha256: 'placeholder'
      }
    });

    const session = await Session.loadOrCreate(dir);
    await runRajio(session, baseOptions);

    const work = await readSegmentsFile(path.join(dir, 'transcript/work/segments.toml'));
    expect(work.segments[0]?.ja).toBe('こんにちは');
    expect(await readFile(path.join(dir, 'session.toml'), 'utf8')).toContain(
      'current_stage = "transcript_work"'
    );
  });

  it('pre-cuts long raw transcript segments when setting up transcript work', async () => {
    const dir = await preparedSession('transcript_work', {
      transcript_raw: {
        status: 'done',
        segments: 'transcript/raw/segments.toml',
        segments_sha256: 'placeholder'
      }
    });
    await writeFile(
      path.join(dir, 'transcript/raw/segments.toml'),
      stringify({
        ...sampleTranscript(),
        segments: [
          {
            id: 'long',
            start: 0,
            end: 12,
            speaker: 'A',
            ja: '今日は新しい企画について話していきたいと思いますので、まずは前回の内容を少し振り返りながら進めていきます'
          }
        ]
      })
    );

    const session = await Session.loadOrCreate(dir);
    await runRajio(session, baseOptions);

    const work = await readSegmentsFile(path.join(dir, 'transcript/work/segments.toml'));
    expect(work.segments.map((segment) => segment.id)).toEqual(['long.1', 'long.2']);
  });

  it('sets up transcript work even when raw transcript needs manual fixes', async () => {
    const dir = await preparedSession('transcript_work', {
      transcript_raw: {
        status: 'done',
        segments: 'transcript/raw/segments.toml',
        segments_sha256: 'placeholder'
      }
    });
    await writeFile(
      path.join(dir, 'transcript/raw/segments.toml'),
      stringify({
        ...sampleTranscript(),
        segments: [
          { id: 'bad-time', start: 1, end: 0.5, speaker: 'A', ja: '時間が逆です' },
          { id: 'empty', start: 0.5, end: 1, speaker: 'A', ja: '' },
          { id: 'overlap', start: 0.75, end: 2, speaker: 'A', ja: '重なっています' }
        ]
      })
    );

    const session = await Session.loadOrCreate(dir);
    await runRajio(session, baseOptions);

    await expect(
      readFile(path.join(dir, 'transcript/work/segments.toml'), 'utf8')
    ).resolves.toContain('id = "empty"');

    const checked = await checkRajio(await Session.loadOrCreate(dir));
    expect(checked.ok).toBe(false);
    expect(checked.issues.every((issue) => !issue.file.includes('transcript/raw'))).toBe(true);
    expect(checked.issues.some((issue) => issue.code === 'invalid_time')).toBe(true);
    expect(checked.issues.some((issue) => issue.code === 'empty_ja')).toBe(true);
    expect(checked.issues.some((issue) => issue.code === 'overlap')).toBe(true);
  });

  it('commits transcript, waits for manual translation, commits translation, and exports', async () => {
    const dir = await preparedSession('transcript_work', {
      transcript_raw: {
        status: 'done',
        segments: 'transcript/raw/segments.toml',
        segments_sha256: 'placeholder'
      }
    });
    let session = await Session.loadOrCreate(dir);
    await runRajio(session, baseOptions);

    session = await Session.loadOrCreate(dir);
    await runRajio(session, { ...baseOptions, full: true, agent: false });

    let sessionToml = await readFile(path.join(dir, 'session.toml'), 'utf8');
    expect(sessionToml).toContain('current_stage = "translation_work"');
    const translationDraft = await readSegmentsFile(
      path.join(dir, 'translation/work/segments.toml')
    );
    expect(translationDraft.source.kind).toBe('translation');
    expect(translationDraft.segments[0]?.zh).toBeUndefined();

    await writeSegmentsFile(path.join(dir, 'translation/work/segments.toml'), {
      ...translationDraft,
      segments: translationDraft.segments.map((segment) => ({ ...segment, zh: '你好' }))
    });
    session = await Session.loadOrCreate(dir);
    await runRajio(session, { ...baseOptions, commit: true, continue: 'until-manual' });

    sessionToml = await readFile(path.join(dir, 'session.toml'), 'utf8');
    expect(sessionToml).toContain('current_stage = "export"');
    expect(sessionToml).toContain('status = "done"');
    expect(sessionToml).toContain('ja_srt = "output/Example.ja.srt"');
    expect(sessionToml).toContain('zh_srt = "output/Example.zh.srt"');
    expect(sessionToml).toContain('bilingual_ass = "output/Example.ja-zh.ass"');
    expect(await readFile(path.join(dir, 'output/Example.zh.srt'), 'utf8')).toContain('你好');
    expect(await readFile(path.join(dir, 'output/Example.ja-zh.ass'), 'utf8')).toContain(
      'こんにちは'
    );
  });

  it('checks session and segment TOML files', async () => {
    const dir = await preparedSession('transcript_work', {
      transcript_raw: {
        status: 'done',
        segments: 'transcript/raw/segments.toml',
        segments_sha256: 'placeholder'
      }
    });

    const session = await Session.loadOrCreate(dir);
    const result = await checkRajio(session);
    expect(result.ok).toBe(true);
  });

  it('reports missing audio chunk metadata for completed audio stages', async () => {
    const dir = await preparedSession('transcript_raw', {
      audio: {
        status: 'done',
        audio: 'audio/extracted.m4a',
        chunk_count: 1
      }
    });

    const session = await Session.loadOrCreate(dir);
    const result = await checkRajio(session);

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        file: path.join(dir, 'session.toml'),
        stage: 'audio',
        level: 'error',
        code: 'missing_audio_chunks',
        message: 'audio stage is missing detailed chunk metadata.'
      })
    );
  });

  it('does not block checks on raw transcript timing or text cleanup issues', async () => {
    const dir = await preparedSession('transcript_raw', {
      transcript_raw: {
        status: 'done',
        segments: 'transcript/raw/segments.toml',
        segments_sha256: 'placeholder'
      }
    });
    await writeFile(
      path.join(dir, 'transcript/raw/segments.toml'),
      stringify({
        ...sampleTranscript(),
        segments: [
          { id: 'bad-time', start: 1, end: 0.5, speaker: 'A', ja: '時間が逆です' },
          { id: 'empty', start: 0.5, end: 1, speaker: 'A', ja: '' },
          { id: 'overlap', start: 0.75, end: 2, speaker: 'A', ja: 'あ'.repeat(41) }
        ]
      })
    );

    const session = await Session.loadOrCreate(dir);
    const result = await checkRajio(session);

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('reports work segment warnings once when checking a session directory', async () => {
    const dir = await preparedSession('transcript_work', {
      transcript_raw: {
        status: 'done',
        segments: 'transcript/raw/segments.toml',
        segments_sha256: 'placeholder'
      },
      transcript_work: {
        status: 'waiting',
        segments: 'transcript/work/segments.toml'
      }
    });
    await writeSegmentsFile(path.join(dir, 'transcript/raw/segments.toml'), {
      ...sampleTranscript(),
      segments: [{ ...sampleTranscript().segments[0]!, ja: 'あ'.repeat(29) }]
    });
    await mkdir(path.join(dir, 'transcript/work'), { recursive: true });
    await writeSegmentsFile(path.join(dir, 'transcript/work/segments.toml'), {
      ...sampleTranscript(),
      segments: [{ ...sampleTranscript().segments[0]!, ja: 'あ'.repeat(29) }]
    });

    const session = await Session.loadOrCreate(dir);
    const result = await checkRajio(session);

    const warning = result.issues.find((issue) => issue.code === 'ja_line_soft_limit');
    expect(result.issues.filter((issue) => issue.code === 'ja_line_soft_limit')).toHaveLength(1);
    expect(warning).toEqual(
      expect.objectContaining({
        stage: 'transcript_work',
        segmentId: '1',
        segment: expect.objectContaining({
          id: '1',
          start: 0,
          end: 1.2,
          jaChars: 29,
          text: 'あ'.repeat(29)
        })
      })
    );
  });

  it('requires Chinese text when checking translation segments', async () => {
    const dir = await preparedSession('translation_work', {
      translation_work: {
        status: 'waiting',
        segments: 'translation/work/segments.toml'
      }
    });
    const filePath = path.join(dir, 'translation/work/segments.toml');
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeSegmentsFile(filePath, {
      ...sampleTranscript(),
      source: { kind: 'translation', media: 'video.mp4', generated_at: '2026-06-06T00:00:00.000Z' }
    });

    const session = await Session.loadOrCreate(dir);
    const result = await checkRajio(session);

    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.message.includes('empty Chinese text'))).toBe(true);
  });

  it('marks committed work dirty when the file changes', async () => {
    const dir = await preparedSession('translation_work', {
      translation_work: {
        status: 'committed',
        segments: 'translation/work/segments.toml',
        segments_sha256: 'incorrect'
      }
    });
    await mkdir(path.join(dir, 'translation/work'), { recursive: true });
    await writeSegmentsFile(path.join(dir, 'translation/work/segments.toml'), sampleTranslation());
    const session = baseSession('translation_work');
    session.stages.translation_work = {
      status: 'committed',
      segments: 'translation/work/segments.toml',
      segments_sha256: 'incorrect'
    };

    const wrapper = await Session.loadOrCreate(dir);
    wrapper.state = session;
    await wrapper.refreshDirtyState();
    expect(session.stages.translation_work.status).toBe('dirty');
  });

  it('returns to dirty translation work instead of reporting completed export', async () => {
    const dir = await preparedCompleteSession();
    const translationPath = path.join(dir, 'translation/work/segments.toml');
    const translation = await readSegmentsFile(translationPath);
    await writeSegmentsFile(translationPath, {
      ...translation,
      segments: translation.segments.map((segment) => ({ ...segment, zh: `${segment.zh}！` }))
    });

    const session = await Session.loadOrCreate(dir);
    await runRajio(session, baseOptions);

    const sessionToml = await readFile(path.join(dir, 'session.toml'), 'utf8');
    expect(sessionToml).toContain('current_stage = "translation_work"');
    expect(sessionToml).toContain('status = "dirty"');
  });

  it('logs export output paths from completed session state', async () => {
    const dir = await preparedCompleteSession();
    const session = await Session.loadOrCreate(dir);
    const logger = { success: vi.fn(), info: vi.fn() };

    logExportOutputs(session, logger);

    expect(logger.success).toHaveBeenCalledWith('export outputs:');
    expect(logger.info.mock.calls.map((call) => call[0])).toEqual([
      'ja srt: output/Example.ja.srt',
      'zh srt: output/Example.zh.srt',
      'bilingual ass: output/Example.ja-zh.ass'
    ]);
  });

  it('logs export output paths once when export completes', async () => {
    const dir = await preparedCompleteSession();
    const session = await Session.loadOrCreate(dir);
    session.setStage('export', { status: 'pending' });
    await session.save();
    const logger = { success: vi.fn(), info: vi.fn() };

    await runRajio(session, baseOptions, { outputLogger: logger });

    expect(logger.success.mock.calls.map((call) => call[0])).toEqual(['export outputs:']);
    expect(logger.info.mock.calls.map((call) => call[0])).toEqual([
      'ja srt: output/Example.ja.srt',
      'zh srt: output/Example.zh.srt',
      'bilingual ass: output/Example.ja-zh.ass'
    ]);
  });

  it('invalidates completed workflow state when the media file changes', async () => {
    const dir = await preparedCompleteSession();
    await writeFile(path.join(dir, 'video.mp4'), 'replacement media');

    const session = await Session.loadOrCreate(dir);
    await session.refreshMediaState();
    await session.save();

    expect(session.currentStage).toBe('audio');
    expect(session.stage('audio').status).toBe('pending');
    expect(session.stage('transcript_raw').status).toBe('pending');
    expect(session.stage('translation_work').status).toBe('pending');
    expect(session.stage('export').status).toBe('pending');
  });
});
