import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { stringify } from 'smol-toml';
import { describe, expect, it, vi } from 'vitest';

import { Session } from '../src/index.js';
import { applySegmentPatch, parseSegmentPatch } from '../src/segments/apply.js';
import { readSegmentsFile, writeSegmentsFile } from '../src/segments/index.js';
import { checkRajio, formatCheckJson } from '../src/session/check.js';
import { logger } from '../src/utils/logger.js';
import { sha256File } from '../src/utils/fs.js';
import { cleanJapaneseSubtitlePunctuation } from '../src/workflow/suggested-patches.js';
import { logExportOutputs, runRajio } from '../src/workflow/index.js';
import {
  baseOptions,
  baseSession,
  preparedCompleteSession,
  preparedSession,
  sampleTranscript,
  sampleTranslation
} from './helpers.js';

const QA_EXCEPTION_JA = `${'あ'.repeat(29)}！！！`;
const QA_EXCEPTION_ZH = `${'你'.repeat(25)}！！！`;

function qaExceptionTranscript() {
  return {
    ...sampleTranscript(),
    segments: [
      {
        id: 'title-call',
        start: 0,
        end: 5,
        speaker: 'A',
        ja: QA_EXCEPTION_JA
      }
    ]
  };
}

function skippedQaTranscript() {
  return {
    ...qaExceptionTranscript(),
    segments: qaExceptionTranscript().segments.map((segment) => ({
      ...segment,
      skip_checks: [
        { code: 'ja_line_hard_limit' as const, reason: 'Official event title.' },
        { code: 'ja_repeated_punctuation' as const, reason: 'Official event title.' }
      ]
    }))
  };
}

function qaExceptionTranslation() {
  return {
    ...qaExceptionTranscript(),
    source: { kind: 'translation' as const, generated_at: '2026-06-06T00:00:00.000Z' },
    segments: qaExceptionTranscript().segments.map((segment) => ({
      ...segment,
      zh: QA_EXCEPTION_ZH
    }))
  };
}

function skippedQaTranslation() {
  return {
    ...qaExceptionTranslation(),
    segments: qaExceptionTranslation().segments.map((segment) => ({
      ...segment,
      skip_checks: [
        { code: 'zh_line_hard_limit' as const, reason: 'Official event title.' },
        { code: 'zh_repeated_punctuation' as const, reason: 'Official event title.' }
      ]
    }))
  };
}

function inheritedJapaneseQaTranslation() {
  return {
    ...qaExceptionTranscript(),
    source: { kind: 'translation' as const, generated_at: '2026-06-06T00:00:00.000Z' },
    segments: qaExceptionTranscript().segments.map((segment) => ({
      ...segment,
      zh: '官方活动名'
    }))
  };
}

function chineseHardQaTranslation() {
  return {
    ...sampleTranslation(),
    segments: sampleTranslation().segments.map((segment) => ({
      ...segment,
      zh: '你'.repeat(25)
    }))
  };
}

function captureConsoleOutput(): {
  output: () => string;
  restore: () => void;
} {
  const chunks: string[] = [];
  const loggerLevel = logger.level;
  logger.level = 3;
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  return {
    output: () => chunks.join(''),
    restore: () => {
      stdout.mockRestore();
      stderr.mockRestore();
      logger.level = loggerLevel;
    }
  };
}

describe('session workflow', () => {
  it('cleans ordinary Japanese subtitle punctuation for suggested patches', () => {
    expect(cleanJapaneseSubtitlePunctuation('そうですね、今日は。')).toBe('そうですね 今日は');
    expect(cleanJapaneseSubtitlePunctuation('「そうですね。」')).toBe('「そうですね」');
    expect(cleanJapaneseSubtitlePunctuation('えっ！？')).toBe('えっ！？');
    expect(cleanJapaneseSubtitlePunctuation('A、B，C...')).toBe('A B C');
    expect(cleanJapaneseSubtitlePunctuation('第1部：開演')).toBe('第1部：開演');
    expect(cleanJapaneseSubtitlePunctuation('詳細は、https://example.com/path?q=a.b&v=1.2.')).toBe(
      '詳細は https://example.com/path?q=a.b&v=1.2'
    );
    expect(
      cleanJapaneseSubtitlePunctuation('詳細は、https://example.com/a.、次は、foo@example.com。')
    ).toBe('詳細は https://example.com/a 次は foo@example.com');
    expect(cleanJapaneseSubtitlePunctuation('詳細は、example.com/path?q=a.b#top。')).toBe(
      '詳細は example.com/path?q=a.b#top'
    );
    expect(cleanJapaneseSubtitlePunctuation('連絡先、foo@example.com。')).toBe(
      '連絡先 foo@example.com'
    );
    expect(cleanJapaneseSubtitlePunctuation('。。。')).toBe('');
  });

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

  it('normalizes raw transcript text without changing gaps when setting up transcript work', async () => {
    const dir = await preparedSession('transcript_work', {
      transcript_raw: {
        status: 'done',
        segments: 'transcript/raw/segments.toml',
        segments_sha256: 'placeholder'
      }
    });
    const rawPath = path.join(dir, 'transcript/raw/segments.toml');
    await writeFile(
      rawPath,
      stringify({
        ...sampleTranscript(),
        segments: [
          { id: 'empty', start: 0, end: 0.1, speaker: 'A', ja: '   ' },
          { id: '1', start: 0.1, end: 1.1, speaker: 'A', ja: ' 一 ' },
          { id: '2', start: 1.1, end: 2.1, speaker: 'A', ja: '\n二\t' }
        ]
      })
    );
    const rawBefore = await readFile(rawPath, 'utf8');

    const session = await Session.loadOrCreate(dir);
    await runRajio(session, baseOptions);

    const work = await readSegmentsFile(path.join(dir, 'transcript/work/segments.toml'));
    expect(work.segments).toEqual([
      { id: '1', start: 0.1, end: 1.1, speaker: 'A', ja: '一' },
      { id: '2', start: 1.1, end: 2.1, speaker: 'A', ja: '二' }
    ]);
    expect(await readFile(rawPath, 'utf8')).toBe(rawBefore);
  });

  it('does not directly normalize tiny negative raw transcript drift when setting up transcript work', async () => {
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
          { id: '1', start: 0, end: 1.0005, speaker: 'A', ja: '一' },
          { id: '2', start: 1, end: 2, speaker: 'A', ja: '二' }
        ]
      })
    );

    const session = await Session.loadOrCreate(dir);
    await runRajio(session, baseOptions);

    const work = await readSegmentsFile(path.join(dir, 'transcript/work/segments.toml'));
    expect(work.segments[0]?.end).toBe(1.0005);
    expect(work.segments[1]?.start).toBe(1);
  });

  it('preserves real raw transcript overlaps for manual validation', async () => {
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
          { id: '1', start: 0, end: 1.002, speaker: 'A', ja: '一' },
          { id: '2', start: 1, end: 2, speaker: 'A', ja: '二' }
        ]
      })
    );

    const session = await Session.loadOrCreate(dir);
    await runRajio(session, baseOptions);

    const work = await readSegmentsFile(path.join(dir, 'transcript/work/segments.toml'));
    expect(work.segments[0]?.end).toBe(1.002);
    expect(work.segments[1]?.start).toBe(1);

    const checked = await checkRajio(await Session.loadOrCreate(dir));
    expect(checked.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'overlap', segmentId: '2' })])
    );
  });

  it('skips transcript work gap normalization that would make adjusted segments too short', async () => {
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
          { id: '1', start: 0, end: 0.52, speaker: 'A', ja: '一' },
          { id: '2', start: 0.52, end: 1.1, speaker: 'A', ja: '二' }
        ]
      })
    );

    const session = await Session.loadOrCreate(dir);
    await runRajio(session, baseOptions);

    const work = await readSegmentsFile(path.join(dir, 'transcript/work/segments.toml'));
    expect(work.segments).toEqual([
      { id: '1', start: 0, end: 0.52, speaker: 'A', ja: '一' },
      { id: '2', start: 0.52, end: 1.1, speaker: 'A', ja: '二' }
    ]);
  });

  it('generates transcript work suggested patches without applying them', async () => {
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
          { id: 'same-1', start: 0, end: 0.4, speaker: 'A', ja: 'な、' },
          { id: 'punctuation-only', start: 0.4, end: 0.45, speaker: 'A', ja: '。。。' },
          { id: 'same-2', start: 0.45, end: 0.9, speaker: 'A', ja: 'んか' },
          { id: 'flicker-1', start: 1.2, end: 1.3, speaker: 'A', ja: 'バ' },
          { id: 'flicker-2', start: 1.3, end: 1.4, speaker: 'B', ja: '可' },
          { id: 'flicker-3', start: 1.4, end: 1.7, speaker: 'A', ja: 'ッサ' },
          { id: 'retime-1', start: 2, end: 3, speaker: 'A', ja: '長めの文です' },
          { id: 'retime-2', start: 3, end: 4, speaker: 'A', ja: '次の文です' },
          {
            id: 'long',
            start: 5,
            end: 16,
            speaker: 'A',
            ja: 'これはとても長い字幕候補なので人間が意味を見ながら分割する必要があります'
          }
        ]
      })
    );
    const session = await Session.loadOrCreate(dir);
    session.state.stages.audio = {
      status: 'done',
      chunks: [
        {
          audio: 'audio/chunks/chunk-000.m4a',
          start: 0,
          end: 20,
          size: 1,
          sha256: 'placeholder'
        }
      ]
    };
    await session.save();

    await runRajio(session, baseOptions);

    const work = await readSegmentsFile(path.join(dir, 'transcript/work/segments.toml'));
    expect(work.segments.find((segment) => segment.id === 'same-1')?.end).toBe(0.4);
    expect(work.segments.find((segment) => segment.id === 'punctuation-only')).toBeDefined();
    expect(work.segments.find((segment) => segment.id === 'retime-1')?.end).toBe(3);

    const suggestedPatchDir = path.join(dir, 'transcript/work/suggested-patches');
    const punctuationHighPath = path.join(
      suggestedPatchDir,
      '01-punctuation-cleanup-chunk-000-000000s-000020s-high.toml'
    );
    const fragmentHighPath = path.join(
      suggestedPatchDir,
      '02-fragment-merge-chunk-000-000000s-000020s-high.toml'
    );
    const fragmentMediumPath = path.join(
      suggestedPatchDir,
      '02-fragment-merge-chunk-000-000000s-000020s-medium.toml'
    );
    const retimeHighPath = path.join(
      suggestedPatchDir,
      '03-boundary-retime-chunk-000-000000s-000020s-high.toml'
    );
    const longReportPath = path.join(
      suggestedPatchDir,
      '04-long-segment-candidates-chunk-000-000000s-000020s-low.md'
    );

    const punctuationHigh = await readFile(punctuationHighPath, 'utf8');
    const punctuationPatch = parseSegmentPatch(punctuationHigh);
    expect(punctuationPatch.start).toBe(0);
    expect(punctuationPatch.end).toBe(20);
    expect(punctuationPatch.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          op: 'edit',
          confidence: 'high',
          segment_id: 'same-1',
          ja: 'な'
        }),
        expect.objectContaining({
          op: 'delete',
          confidence: 'high',
          segment_id: 'punctuation-only'
        })
      ])
    );
    const fragmentHigh = await readFile(fragmentHighPath, 'utf8');
    expect(fragmentHigh).toContain('confidence = "high"');
    expect(parseSegmentPatch(fragmentHigh).operations[0]).toEqual(
      expect.objectContaining({
        op: 'merge',
        confidence: 'high',
        source_ids: ['same-1', 'same-2']
      })
    );
    const fragmentMedium = await readFile(fragmentMediumPath, 'utf8');
    expect(fragmentMedium).toContain('confidence = "medium"');
    expect(parseSegmentPatch(fragmentMedium).operations[0]).toEqual(
      expect.objectContaining({
        op: 'merge',
        confidence: 'medium',
        source_ids: ['flicker-1', 'flicker-2', 'flicker-3']
      })
    );
    const retimeHigh = await readFile(retimeHighPath, 'utf8');
    expect(retimeHigh).toContain('segment_id = "retime-1"');
    expect(retimeHigh).toContain('end = 2.96');
    expect(retimeHigh).toContain('segment_id = "retime-2"');
    expect(retimeHigh).toContain('start = 3.04');
    await expect(readFile(longReportPath, 'utf8')).resolves.toContain('long');

    const patched = structuredClone(work);
    applySegmentPatch(patched, punctuationPatch);
    applySegmentPatch(patched, parseSegmentPatch(fragmentHigh));
    applySegmentPatch(patched, parseSegmentPatch(retimeHigh));
    expect(patched.segments.find((segment) => segment.id === 'same-1')?.ja).toBe('なんか');
    expect(patched.segments.find((segment) => segment.id === 'punctuation-only')).toBeUndefined();
    expect(patched.segments.find((segment) => segment.id === 'retime-1')?.end).toBe(2.96);
    expect(patched.segments.find((segment) => segment.id === 'retime-2')?.start).toBe(3.04);
  });

  it('copies long raw transcript segments without pre-cutting transcript work', async () => {
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
    expect(work.segments).toEqual([
      {
        id: 'long',
        start: 0,
        end: 12,
        speaker: 'A',
        ja: '今日は新しい企画について話していきたいと思いますので、まずは前回の内容を少し振り返りながら進めていきます'
      }
    ]);
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
          { id: 'anchor', start: 0.5, end: 1, speaker: 'A', ja: '基準' },
          { id: 'overlap', start: 0.75, end: 2, speaker: 'A', ja: '重なっています' }
        ]
      })
    );

    const session = await Session.loadOrCreate(dir);
    await runRajio(session, baseOptions);

    const workText = await readFile(path.join(dir, 'transcript/work/segments.toml'), 'utf8');
    expect(workText).not.toContain('id = "empty"');
    expect(workText).toContain('id = "anchor"');

    const checked = await checkRajio(await Session.loadOrCreate(dir));
    expect(checked.ok).toBe(false);
    expect(checked.issues.every((issue) => !issue.file.includes('transcript/raw'))).toBe(true);
    expect(checked.issues.some((issue) => issue.code === 'invalid_time')).toBe(true);
    expect(checked.issues.some((issue) => issue.code === 'empty_ja')).toBe(false);
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
    expect(sessionToml).toContain('current_stage = "done"');
    expect(sessionToml).toContain('status = "done"');
    expect(sessionToml).toContain('ja_srt = "output/Example.ja.srt"');
    expect(sessionToml).toContain('zh_srt = "output/Example.zh.srt"');
    expect(sessionToml).toContain('bilingual_ass = "output/Example.ja-zh.ass"');
    expect(await readFile(path.join(dir, 'output/Example.zh.srt'), 'utf8')).toContain('你好');
    expect(await readFile(path.join(dir, 'output/Example.ja-zh.ass'), 'utf8')).toContain(
      'こんにちは'
    );
  });

  it('rejects subtitle QA errors with regular commit', async () => {
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
    await mkdir(path.join(dir, 'transcript/work'), { recursive: true });
    await writeFile(
      path.join(dir, 'transcript/work/segments.toml'),
      stringify(qaExceptionTranscript())
    );

    const session = await Session.loadOrCreate(dir);
    await expect(runRajio(session, { ...baseOptions, commit: true })).rejects.toThrow(
      'blocking issue'
    );

    const reloaded = await Session.loadOrCreate(dir);
    expect(reloaded.stage('transcript_work').status).toBe('waiting');
  });

  it('commits per-segment skipped subtitle QA errors without recording a session marker', async () => {
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
    await mkdir(path.join(dir, 'transcript/work'), { recursive: true });
    await writeFile(
      path.join(dir, 'transcript/work/segments.toml'),
      stringify(skippedQaTranscript())
    );

    const session = await Session.loadOrCreate(dir);
    await runRajio(session, { ...baseOptions, commit: true });

    const reloaded = await Session.loadOrCreate(dir);
    expect(reloaded.currentStage).toBe('translation_work');
    expect(reloaded.stage('transcript_work')).toEqual(
      expect.objectContaining({
        status: 'committed'
      })
    );
  });

  it('does not skip data integrity errors', async () => {
    const dir = await preparedSession('translation_work', {
      translation_work: {
        status: 'waiting',
        segments: 'translation/work/segments.toml'
      }
    });
    await mkdir(path.join(dir, 'translation/work'), { recursive: true });
    await writeFile(
      path.join(dir, 'translation/work/segments.toml'),
      stringify({
        ...sampleTranslation(),
        segments: sampleTranslation().segments.map((segment) => ({
          id: segment.id,
          start: segment.start,
          end: segment.end,
          speaker: segment.speaker,
          ja: segment.ja,
          skip_checks: [{ code: 'zh_line_hard_limit', reason: 'Wrong attempt.' }]
        }))
      })
    );

    const session = await Session.loadOrCreate(dir);
    await expect(runRajio(session, { ...baseOptions, commit: true })).rejects.toThrow('empty_zh');

    const reloaded = await Session.loadOrCreate(dir);
    expect(reloaded.stage('translation_work').status).toBe('waiting');
  });

  it('commits and exports translation with inherited Japanese QA errors', async () => {
    const dir = await preparedSession('translation_work', {
      translation_work: {
        status: 'waiting',
        segments: 'translation/work/segments.toml'
      }
    });
    await mkdir(path.join(dir, 'translation/work'), { recursive: true });
    await writeFile(
      path.join(dir, 'translation/work/segments.toml'),
      stringify(inheritedJapaneseQaTranslation())
    );

    const capture = captureConsoleOutput();
    try {
      const session = await Session.loadOrCreate(dir);
      await runRajio(session, { ...baseOptions, commit: true });
    } finally {
      capture.restore();
    }
    expect(capture.output()).not.toContain('translation inherited Japanese QA');

    const reloaded = await Session.loadOrCreate(dir);
    expect(reloaded.stage('translation_work')).toEqual(
      expect.objectContaining({
        status: 'committed'
      })
    );
    expect(reloaded.stage('export').status).toBe('done');
    expect(await readFile(path.join(dir, 'output/Example.ja.srt'), 'utf8')).toContain(
      QA_EXCEPTION_JA
    );
  });

  it('prints translation commit scope and Chinese QA warnings', async () => {
    const dir = await preparedSession('translation_work', {
      translation_work: {
        status: 'waiting',
        segments: 'translation/work/segments.toml'
      }
    });
    await mkdir(path.join(dir, 'translation/work'), { recursive: true });
    await writeFile(
      path.join(dir, 'translation/work/segments.toml'),
      stringify({
        ...sampleTranslation(),
        segments: sampleTranslation().segments.map((segment) => ({
          ...segment,
          zh: '你好。'
        }))
      })
    );

    const capture = captureConsoleOutput();
    try {
      const session = await Session.loadOrCreate(dir);
      await runRajio(session, { ...baseOptions, commit: true });
    } finally {
      capture.restore();
    }

    const output = capture.output();
    expect(output).toContain('commit scope: translation_work zh QA.');
    expect(output).toContain('Run rajio check');
    expect(output).toContain('--stage translation --language ja');
    expect(output).toContain('zh_terminal_punctuation');
    expect(output).not.toContain('translation inherited Japanese QA');
  });

  it('prints transcript commit scope and Japanese QA warnings', async () => {
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
    await mkdir(path.join(dir, 'transcript/work'), { recursive: true });
    await writeFile(
      path.join(dir, 'transcript/work/segments.toml'),
      stringify({
        ...sampleTranscript(),
        segments: [
          {
            id: '1',
            start: 0,
            end: 4,
            speaker: 'A',
            ja: 'あ'.repeat(21)
          }
        ]
      })
    );

    const capture = captureConsoleOutput();
    try {
      const session = await Session.loadOrCreate(dir);
      await runRajio(session, { ...baseOptions, commit: true });
    } finally {
      capture.restore();
    }

    const output = capture.output();
    expect(output).toContain('commit scope: transcript_work ja QA.');
    expect(output).toContain('ja_line_soft_limit');
    expect(output).not.toContain('--language zh');
  });

  it('rejects translation commit when Chinese QA has hard errors', async () => {
    const dir = await preparedSession('translation_work', {
      translation_work: {
        status: 'waiting',
        segments: 'translation/work/segments.toml'
      }
    });
    await mkdir(path.join(dir, 'translation/work'), { recursive: true });
    await writeFile(
      path.join(dir, 'translation/work/segments.toml'),
      stringify(chineseHardQaTranslation())
    );

    const capture = captureConsoleOutput();
    try {
      const session = await Session.loadOrCreate(dir);
      await expect(runRajio(session, { ...baseOptions, commit: true })).rejects.toThrow(
        'zh_line_hard_limit'
      );
    } finally {
      capture.restore();
    }

    const output = capture.output();
    expect(output).toContain('commit scope: translation_work zh QA.');
    expect(output).toContain('zh_line_hard_limit');

    const reloaded = await Session.loadOrCreate(dir);
    expect(reloaded.stage('translation_work').status).toBe('waiting');
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

  it('accepts terminal done current stage during session checks', async () => {
    const dir = await preparedCompleteSession();
    const session = await Session.loadOrCreate(dir);
    const result = await checkRajio(session);

    expect(result.ok).toBe(true);
    expect(result.issues.some((issue) => issue.code === 'invalid_current_stage')).toBe(false);
    expect(result.issues.some((issue) => issue.code === 'failed_stage')).toBe(false);
  });

  it('reports terminal done current stage when export is incomplete', async () => {
    const dir = await preparedCompleteSession();
    const session = await Session.loadOrCreate(dir);
    session.state.stages.export = { status: 'pending' };
    await session.save();

    const result = await checkRajio(await Session.loadOrCreate(dir));

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        file: path.join(dir, 'session.toml'),
        stage: 'export',
        level: 'fatal',
        code: 'incomplete_terminal_stage',
        message: 'current_stage is done but export status is pending.'
      })
    );
  });

  it('reports failed current automatic stages as check errors', async () => {
    const dir = await preparedSession('transcript_raw', {
      transcript_raw: {
        status: 'failed',
        error: 'transcription provider timed out'
      }
    });

    const session = await Session.loadOrCreate(dir);
    const result = await checkRajio(session);

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        file: path.join(dir, 'session.toml'),
        stage: 'transcript_raw',
        level: 'fatal',
        code: 'failed_stage',
        message: 'transcript_raw failed: transcription provider timed out'
      })
    );

    const json = JSON.parse(formatCheckJson(result.issues, { sessionDir: dir })) as {
      ok: boolean;
      counts: { fatal: number; error: number; warning: number };
      summary: Array<{ file: string; level: string; code: string; count: number }>;
    };
    expect(json.ok).toBe(false);
    expect(json.counts).toEqual({ fatal: 1, error: 0, warning: 0 });
    expect(json.summary).toContainEqual(
      expect.objectContaining({
        file: 'session.toml',
        level: 'fatal',
        code: 'failed_stage',
        count: 1
      })
    );
  });

  it('does not report failed_stage for failed current manual stages', async () => {
    const dir = await preparedSession('transcript_work', {
      transcript_work: {
        status: 'failed',
        error: 'Segment 1 has invalid timing.'
      }
    });

    const session = await Session.loadOrCreate(dir);
    const result = await checkRajio(session);

    expect(result.issues.some((issue) => issue.code === 'failed_stage')).toBe(false);
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
        level: 'fatal',
        code: 'missing_audio_chunks',
        message: 'audio stage is missing detailed chunk metadata.'
      })
    );
  });

  it('reports inherited Japanese QA warnings', async () => {
    const dir = await preparedSession('translation_work', {
      transcript_work: {
        status: 'committed',
        segments: 'transcript/work/segments.toml',
        segments_sha256: 'placeholder'
      },
      translation_work: {
        status: 'waiting',
        segments: 'translation/work/segments.toml'
      }
    });
    await mkdir(path.join(dir, 'translation/work'), { recursive: true });
    const filePath = path.join(dir, 'translation/work/segments.toml');
    await writeFile(filePath, stringify(qaExceptionTranslation()));
    const session = await Session.loadOrCreate(dir);
    session.state.current_stage = 'export';
    session.state.stages.translation_work = {
      status: 'committed',
      segments: 'translation/work/segments.toml',
      segments_sha256: await sha256File(filePath)
    };
    await session.save();

    const result = await checkRajio(await Session.loadOrCreate(dir));

    const issue = result.issues.find((item) => item.code === 'ja_line_hard_limit');
    expect(issue).toEqual(
      expect.objectContaining({
        level: 'warning',
        message: expect.stringContaining('translation inherited Japanese QA')
      })
    );
    expect(
      result.issues.some((item) => item.level === 'error' && item.code === 'ja_line_hard_limit')
    ).toBe(false);
  });

  it('reports Chinese hard QA errors as translation errors', async () => {
    const dir = await preparedSession('translation_work', {
      translation_work: {
        status: 'waiting',
        segments: 'translation/work/segments.toml'
      }
    });
    await mkdir(path.join(dir, 'translation/work'), { recursive: true });
    await writeFile(
      path.join(dir, 'translation/work/segments.toml'),
      stringify(chineseHardQaTranslation())
    );

    const result = await checkRajio(await Session.loadOrCreate(dir));

    expect(
      result.issues.some((item) => item.level === 'error' && item.code === 'zh_line_hard_limit')
    ).toBe(true);
  });

  it('keeps inherited Japanese QA as translation warnings after the work file changes', async () => {
    const dir = await preparedSession('translation_work', {
      translation_work: {
        status: 'committed',
        segments: 'translation/work/segments.toml',
        segments_sha256: 'incorrect'
      }
    });
    await mkdir(path.join(dir, 'translation/work'), { recursive: true });
    await writeFile(
      path.join(dir, 'translation/work/segments.toml'),
      stringify(qaExceptionTranslation())
    );

    const result = await checkRajio(await Session.loadOrCreate(dir));

    const issue = result.issues.find((item) => item.code === 'ja_line_hard_limit');
    expect(issue).toEqual(
      expect.objectContaining({
        level: 'warning',
        message: expect.stringContaining('translation inherited Japanese QA')
      })
    );
    expect(
      result.issues.some((item) => item.level === 'error' && item.code === 'ja_line_hard_limit')
    ).toBe(false);
  });

  it('exports translation with per-segment skipped subtitle QA errors', async () => {
    const dir = await preparedSession('translation_work', {
      transcript_work: {
        status: 'committed',
        segments: 'transcript/work/segments.toml',
        segments_sha256: 'placeholder'
      },
      translation_work: {
        status: 'waiting',
        segments: 'translation/work/segments.toml'
      }
    });
    await mkdir(path.join(dir, 'transcript/work'), { recursive: true });
    await writeSegmentsFile(path.join(dir, 'transcript/work/segments.toml'), sampleTranscript());
    const transcriptHash = await sha256File(path.join(dir, 'transcript/work/segments.toml'));
    await mkdir(path.join(dir, 'translation/work'), { recursive: true });
    await writeFile(
      path.join(dir, 'translation/work/segments.toml'),
      stringify(skippedQaTranslation())
    );

    const session = await Session.loadOrCreate(dir);
    session.state.stages.transcript_work = {
      status: 'committed',
      segments: 'transcript/work/segments.toml',
      segments_sha256: transcriptHash
    };
    await session.save();
    await runRajio(session, { ...baseOptions, commit: true });

    const reloaded = await Session.loadOrCreate(dir);
    expect(reloaded.stage('translation_work')).toEqual(
      expect.objectContaining({
        status: 'committed'
      })
    );
    expect(reloaded.stage('export').status).toBe('done');
    expect(await readFile(path.join(dir, 'output/Example.ja.srt'), 'utf8')).toContain(
      QA_EXCEPTION_JA
    );
  });

  it('reports malformed raw transcript segment artifacts during checks', async () => {
    const dir = await preparedSession('transcript_raw', {
      transcript_raw: {
        status: 'done',
        segments: 'transcript/raw/segments.toml',
        segments_sha256: 'placeholder'
      }
    });
    await writeFile(path.join(dir, 'transcript/raw/segments.toml'), 'this is not valid toml = [');

    const session = await Session.loadOrCreate(dir);
    const result = await checkRajio(session);

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({
        stage: 'transcript_raw',
        level: 'fatal',
        code: 'segments_parse_error'
      })
    ]);
  });

  it('does not report subtitle QA issues for raw transcript segments', async () => {
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
      segments: [{ ...sampleTranscript().segments[0]!, end: 4, ja: 'あ'.repeat(21) }]
    });
    await mkdir(path.join(dir, 'transcript/work'), { recursive: true });
    await writeSegmentsFile(path.join(dir, 'transcript/work/segments.toml'), {
      ...sampleTranscript(),
      segments: [{ ...sampleTranscript().segments[0]!, end: 4, ja: 'あ'.repeat(21) }]
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
          end: 4,
          jaChars: 21,
          text: 'あ'.repeat(21)
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
      source: { kind: 'translation', generated_at: '2026-06-06T00:00:00.000Z' }
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
    session.currentStage = 'export';
    session.state.stages.export = { status: 'pending' };
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

  it('rejects terminal done workflow state when export is incomplete', async () => {
    const dir = await preparedCompleteSession();
    const session = await Session.loadOrCreate(dir);
    session.state.stages.export = { status: 'pending' };
    await session.save();

    await expect(runRajio(session, baseOptions)).rejects.toThrow(
      'current_stage is done but export is not done.'
    );

    const reloaded = await Session.loadOrCreate(dir);
    expect(reloaded.currentStage).toBe('done');
    expect(reloaded.stage('export').status).toBe('pending');
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

  it('resets to raw transcription and regenerates all chunk checkpoints', async () => {
    const dir = await preparedCompleteSession();
    await mkdir(path.join(dir, 'audio/chunks'), { recursive: true });
    await mkdir(path.join(dir, 'transcript/raw/chunks'), { recursive: true });
    await writeFile(path.join(dir, 'audio/extracted.m4a'), 'audio');
    await writeFile(path.join(dir, 'audio/chunks/chunk-000.m4a'), 'audio 0');
    await writeFile(path.join(dir, 'audio/chunks/chunk-001.m4a'), 'audio 1');
    await writeFile(
      path.join(dir, 'transcript/raw/chunks/chunk-000.toml'),
      [
        'version = 1',
        'status = "done"',
        'chunk_index = 0',
        'audio = "audio/chunks/chunk-000.m4a"',
        'start = 0',
        'end = 1',
        'model = "old"',
        'started_at = "2026-06-05T00:00:00.000Z"',
        'completed_at = "2026-06-05T00:00:00.000Z"',
        '',
        '[[response.segments]]',
        'id = "old"',
        'start = 0',
        'end = 0.5',
        'speaker = "A"',
        'text = "old checkpoint"'
      ].join('\n')
    );

    const firstHash = await sha256File(path.join(dir, 'audio/chunks/chunk-000.m4a'));
    const secondHash = await sha256File(path.join(dir, 'audio/chunks/chunk-001.m4a'));
    const session = await Session.loadOrCreate(dir);
    session.state.stages.audio = {
      status: 'done',
      audio: 'audio/extracted.m4a',
      chunks_dir: 'audio/chunks',
      chunk_count: 2,
      chunks: [
        {
          audio: 'audio/chunks/chunk-000.m4a',
          start: 0,
          end: 1,
          size: 7,
          sha256: firstHash
        },
        {
          audio: 'audio/chunks/chunk-001.m4a',
          start: 1,
          end: 2,
          size: 7,
          sha256: secondHash
        }
      ]
    };
    await session.save();

    const calls: string[] = [];
    await runRajio(
      session,
      { ...baseOptions, reset: 'transcript_raw' },
      {
        transcribe: async ({ audioPath }) => {
          calls.push(path.basename(audioPath));
          return {
            segments: [
              {
                id: path.basename(audioPath, '.m4a'),
                start: 0,
                end: 0.5,
                speaker: 'A',
                text: path.basename(audioPath)
              }
            ]
          };
        }
      }
    );

    expect(calls.toSorted()).toEqual(['chunk-000.m4a', 'chunk-001.m4a']);
    expect(
      await readFile(path.join(dir, 'transcript/raw/chunks/chunk-000.toml'), 'utf8')
    ).toContain('chunk-000.m4a');
    expect(await readFile(path.join(dir, 'transcript/raw/segments.toml'), 'utf8')).not.toContain(
      'old checkpoint'
    );
    const reloaded = await Session.loadOrCreate(dir);
    expect(reloaded.currentStage).toBe('transcript_work');
    expect(reloaded.stage('audio').status).toBe('done');
    expect(reloaded.stage('transcript_raw').status).toBe('done');
    expect(reloaded.stage('transcript_work').status).toBe('waiting');
    expect(reloaded.stage('translation_work').status).toBe('pending');
    expect(reloaded.stage('export').status).toBe('pending');
  });

  it('resets transcript work and regenerates the manual work file', async () => {
    const dir = await preparedCompleteSession();
    await writeFile(path.join(dir, 'transcript/work/segments.toml'), 'old work');

    const session = await Session.loadOrCreate(dir);
    await runRajio(session, { ...baseOptions, reset: 'transcript_work' });

    const work = await readSegmentsFile(path.join(dir, 'transcript/work/segments.toml'));
    const reloaded = await Session.loadOrCreate(dir);
    expect(work.segments[0]?.ja).toBe('こんにちは');
    expect(reloaded.currentStage).toBe('transcript_work');
    expect(reloaded.stage('transcript_raw').status).toBe('done');
    expect(reloaded.stage('transcript_work').status).toBe('waiting');
    expect(reloaded.stage('translation_work').status).toBe('pending');
    expect(reloaded.stage('export').status).toBe('pending');
  });

  it('resets translation work and regenerates the translation draft', async () => {
    const dir = await preparedCompleteSession();
    await writeFile(path.join(dir, 'translation/work/segments.toml'), 'old translation');

    const session = await Session.loadOrCreate(dir);
    await runRajio(session, { ...baseOptions, reset: 'translation_work' });

    const work = await readSegmentsFile(path.join(dir, 'translation/work/segments.toml'));
    const reloaded = await Session.loadOrCreate(dir);
    expect(work.source.kind).toBe('translation');
    expect(work.segments[0]?.zh).toBeUndefined();
    expect(reloaded.currentStage).toBe('translation_work');
    expect(reloaded.stage('transcript_work').status).toBe('committed');
    expect(reloaded.stage('translation_work').status).toBe('waiting');
    expect(reloaded.stage('export').status).toBe('pending');
  });

  it('resets export but retargets dirty translation work before exporting', async () => {
    const dir = await preparedCompleteSession();
    const translationPath = path.join(dir, 'translation/work/segments.toml');
    const translation = await readSegmentsFile(translationPath);
    await writeSegmentsFile(translationPath, {
      ...translation,
      segments: translation.segments.map((segment) => ({ ...segment, zh: `${segment.zh}！` }))
    });

    const session = await Session.loadOrCreate(dir);
    await runRajio(session, { ...baseOptions, reset: 'export' });

    const reloaded = await Session.loadOrCreate(dir);
    expect(reloaded.currentStage).toBe('translation_work');
    expect(reloaded.stage('translation_work').status).toBe('dirty');
    expect(reloaded.stage('export').status).toBe('pending');
  });

  it('recommits dirty translation work and regenerates export in one reset command', async () => {
    const dir = await preparedCompleteSession();
    const translationPath = path.join(dir, 'translation/work/segments.toml');
    const translation = await readSegmentsFile(translationPath);
    await writeSegmentsFile(translationPath, {
      ...translation,
      segments: translation.segments.map((segment) => ({ ...segment, zh: '精修后的字幕' }))
    });

    const session = await Session.loadOrCreate(dir);
    await runRajio(session, {
      ...baseOptions,
      reset: 'export',
      commit: true,
      continue: 'until-manual'
    });

    const reloaded = await Session.loadOrCreate(dir);
    expect(reloaded.currentStage).toBe('done');
    expect(reloaded.stage('translation_work').status).toBe('committed');
    expect(reloaded.stage('export').status).toBe('done');
    expect(await readFile(path.join(dir, 'output/Example.zh.srt'), 'utf8')).toContain(
      '精修后的字幕'
    );
    expect(await readFile(path.join(dir, 'output/Example.ja-zh.ass'), 'utf8')).toContain(
      '精修后的字幕'
    );
  });

  it('saves media invalidation and rejects reset to a later stage', async () => {
    const dir = await preparedCompleteSession();
    await writeFile(path.join(dir, 'video.mp4'), 'replacement media');

    const session = await Session.loadOrCreate(dir);
    await expect(runRajio(session, { ...baseOptions, reset: 'transcript_raw' })).rejects.toThrow(
      'Media changed; run from audio before resetting to a later stage.'
    );

    const reloaded = await Session.loadOrCreate(dir);
    expect(reloaded.currentStage).toBe('audio');
    expect(reloaded.stage('audio').status).toBe('pending');
    expect(reloaded.stage('transcript_raw').status).toBe('pending');
    expect(reloaded.stage('transcript_work').status).toBe('pending');
    expect(reloaded.stage('translation_work').status).toBe('pending');
    expect(reloaded.stage('export').status).toBe('pending');
  });
});
