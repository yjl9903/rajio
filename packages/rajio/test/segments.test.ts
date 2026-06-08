import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { stringWidth } from 'breadc';
import { describe, expect, it, vi } from 'vitest';

import { Session } from '../src/index.js';
import { applySegmentPatch, parseSegmentPatch } from '../src/segments/apply.js';
import {
  deleteSegment,
  editSegment,
  loadSegmentEditContext,
  mergeSegments,
  persistSegmentEdit,
  splitSegment
} from '../src/segments/edit.js';
import {
  precutTranscriptSegments,
  readSegmentsFile,
  validateSegments,
  writeSegmentsFile
} from '../src/segments/index.js';
import { listSegments } from '../src/segments/list.js';
import { formatSegments } from '../src/segments/output.js';
import { filterCheckIssues, formatCheckJson, printCheckIssues } from '../src/session/check.js';
import { renderAss, renderSrt } from '../src/workflow/subtitles.js';
import { mergeTranscriptChunks } from '../src/workflow/transcription.js';
import type { SegmentsFile } from '../src/types.js';
import {
  preparedCompleteSession,
  preparedSession,
  sampleTranscript,
  sampleTranslation,
  tempDir
} from './helpers.js';

describe('segments validation and subtitle rendering', () => {
  it('reports blocking timeline and translation errors', () => {
    const issues = validateSegments(
      {
        version: 1,
        source: { kind: 'translation', generated_at: '2026-06-06T00:00:00.000Z' },
        segments: [
          { id: '1', start: 1, end: 2, speaker: 'A', ja: 'こんにちは', zh: '你好' },
          { id: '2', start: 1.5, end: 3, speaker: 'A', ja: '次' }
        ]
      },
      { requireZh: true }
    );

    expect(issues.some((issue) => issue.code === 'overlap' && issue.level === 'error')).toBe(true);
    expect(issues.some((issue) => issue.code === 'empty_zh' && issue.level === 'error')).toBe(true);
  });

  it('ignores tiny floating point drift when checking overlaps', () => {
    const issues = validateSegments({
      version: 1,
      source: { kind: 'transcript', generated_at: '2026-06-06T00:00:00.000Z' },
      segments: [
        { id: '1', start: 0, end: 1.0005, speaker: 'A', ja: 'こんにちは' },
        { id: '2', start: 1, end: 2, speaker: 'A', ja: '次' },
        { id: '3', start: 1.998, end: 3, speaker: 'A', ja: '重なり' }
      ]
    });

    expect(
      issues.filter((issue) => issue.code === 'overlap').map((issue) => issue.segmentId)
    ).toEqual(['3']);
  });

  it('reports subtitle length limits and punctuation warnings', () => {
    const issues = validateSegments(
      {
        version: 1,
        source: { kind: 'translation', generated_at: '2026-06-06T00:00:00.000Z' },
        segments: [
          {
            id: 'soft',
            start: 0,
            end: 2,
            speaker: 'A',
            ja: 'あ'.repeat(14),
            zh: '你'.repeat(17)
          },
          {
            id: 'hard',
            start: 2.3,
            end: 4.3,
            speaker: 'A',
            ja: 'あ'.repeat(21),
            zh: '你'.repeat(25)
          },
          {
            id: 'punctuation',
            start: 4.6,
            end: 5.6,
            speaker: 'A',
            ja: 'これは、テストです。',
            zh: '你好，世界。'
          },
          {
            id: 'soft-break',
            start: 5.9,
            end: 6.9,
            speaker: 'A',
            ja: '一行目\n二行目',
            zh: '第一行\n第二行'
          },
          {
            id: 'hard-break',
            start: 7.2,
            end: 8.2,
            speaker: 'A',
            ja: '一行目\n二行目\n三行目',
            zh: '第一行\n第二行\n第三行'
          }
        ]
      },
      { requireZh: true }
    );

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'ja_line_soft_limit', level: 'warning' }),
        expect.objectContaining({ code: 'zh_line_soft_limit', level: 'warning' }),
        expect.objectContaining({ code: 'ja_line_hard_limit', level: 'error' }),
        expect.objectContaining({ code: 'zh_line_hard_limit', level: 'error' }),
        expect.objectContaining({ code: 'ja_common_punctuation', level: 'warning' }),
        expect.objectContaining({ code: 'zh_common_punctuation', level: 'warning' }),
        expect.objectContaining({ code: 'ja_terminal_punctuation', level: 'warning' }),
        expect.objectContaining({ code: 'zh_terminal_punctuation', level: 'warning' }),
        expect.objectContaining({ code: 'ja_line_break_soft_limit', level: 'warning' }),
        expect.objectContaining({ code: 'zh_line_break_soft_limit', level: 'warning' }),
        expect.objectContaining({ code: 'ja_line_break_hard_limit', level: 'error' }),
        expect.objectContaining({ code: 'zh_line_break_hard_limit', level: 'error' })
      ])
    );
  });

  it('reports subtitle duration limits', () => {
    const issues = validateSegments({
      version: 1,
      source: { kind: 'transcript', generated_at: '2026-06-06T00:00:00.000Z' },
      segments: [
        { id: 'short-hard', start: 0, end: 0.49, speaker: 'A', ja: 'あ' },
        { id: 'short-soft', start: 1, end: 1.7, speaker: 'A', ja: 'あ' },
        { id: 'long-soft', start: 2, end: 9.1, speaker: 'A', ja: 'あ' },
        { id: 'long-hard', start: 10, end: 20.1, speaker: 'A', ja: 'あ' }
      ]
    });

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'duration_too_short',
          level: 'error',
          segmentId: 'short-hard'
        }),
        expect.objectContaining({
          code: 'duration_too_short',
          level: 'warning',
          segmentId: 'short-soft'
        }),
        expect.objectContaining({
          code: 'duration_too_long',
          level: 'warning',
          segmentId: 'long-soft'
        }),
        expect.objectContaining({
          code: 'duration_too_long',
          level: 'error',
          segmentId: 'long-hard'
        })
      ])
    );
  });

  it('reports language-specific reading speed limits', () => {
    const issues = validateSegments({
      version: 1,
      source: { kind: 'translation', generated_at: '2026-06-06T00:00:00.000Z' },
      segments: [
        {
          id: 'ja-speed-soft',
          start: 0,
          end: 2,
          speaker: 'A',
          ja: 'あ'.repeat(9),
          zh: '好'
        },
        {
          id: 'ja-speed-hard',
          start: 2.3,
          end: 4.3,
          speaker: 'A',
          ja: 'あ'.repeat(13),
          zh: '好'
        },
        {
          id: 'zh-speed-soft',
          start: 4.6,
          end: 6.6,
          speaker: 'A',
          ja: 'あ',
          zh: '你'.repeat(19)
        },
        {
          id: 'zh-speed-hard',
          start: 6.9,
          end: 8.9,
          speaker: 'A',
          ja: 'あ',
          zh: '你'.repeat(25)
        }
      ]
    });

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'ja_reading_speed_limit',
          level: 'warning',
          segmentId: 'ja-speed-soft'
        }),
        expect.objectContaining({
          code: 'ja_reading_speed_limit',
          level: 'error',
          segmentId: 'ja-speed-hard'
        }),
        expect.objectContaining({
          code: 'zh_reading_speed_limit',
          level: 'warning',
          segmentId: 'zh-speed-soft'
        }),
        expect.objectContaining({
          code: 'zh_reading_speed_limit',
          level: 'error',
          segmentId: 'zh-speed-hard'
        })
      ])
    );
  });

  it('reports short subtitle gaps on the following segment', () => {
    const issues = validateSegments({
      version: 1,
      source: { kind: 'transcript', generated_at: '2026-06-06T00:00:00.000Z' },
      segments: [
        { id: '1', start: 0, end: 1, speaker: 'A', ja: '一' },
        { id: '2', start: 1.079, end: 2, speaker: 'A', ja: '二' },
        { id: '3', start: 2.179, end: 3, speaker: 'A', ja: '三' },
        { id: '4', start: 3.25, end: 4, speaker: 'A', ja: '四' }
      ]
    });

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'subtitle_gap_too_short',
          level: 'error',
          segmentId: '2'
        }),
        expect.objectContaining({
          code: 'subtitle_gap_short',
          level: 'warning',
          segmentId: '3'
        })
      ])
    );
    expect(issues.some((issue) => issue.segmentId === '4' && issue.code?.includes('gap'))).toBe(
      false
    );
  });

  it('reports repeated and punctuation-only subtitle punctuation', () => {
    const issues = validateSegments({
      version: 1,
      source: { kind: 'translation', generated_at: '2026-06-06T00:00:00.000Z' },
      segments: [
        { id: 'allowed', start: 0, end: 1, speaker: 'A', ja: '本当？', zh: '真的吗？' },
        { id: 'repeat-soft', start: 1.3, end: 2.3, speaker: 'A', ja: '本当？!', zh: '真的吗？！' },
        {
          id: 'repeat-hard',
          start: 2.6,
          end: 3.6,
          speaker: 'A',
          ja: '本当？？？',
          zh: '真的吗？？？'
        },
        { id: 'only', start: 3.9, end: 4.9, speaker: 'A', ja: '！？', zh: '？！' }
      ]
    });

    expect(
      issues.filter((issue) => issue.segmentId === 'allowed').map((issue) => issue.code)
    ).not.toContain('ja_terminal_punctuation');
    expect(
      issues.filter((issue) => issue.segmentId === 'allowed').map((issue) => issue.code)
    ).not.toContain('zh_terminal_punctuation');
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'ja_repeated_punctuation',
          level: 'warning',
          segmentId: 'repeat-soft'
        }),
        expect.objectContaining({
          code: 'zh_repeated_punctuation',
          level: 'warning',
          segmentId: 'repeat-soft'
        }),
        expect.objectContaining({
          code: 'ja_repeated_punctuation',
          level: 'error',
          segmentId: 'repeat-hard'
        }),
        expect.objectContaining({
          code: 'zh_repeated_punctuation',
          level: 'error',
          segmentId: 'repeat-hard'
        }),
        expect.objectContaining({
          code: 'ja_punctuation_only_line',
          level: 'error',
          segmentId: 'only'
        }),
        expect.objectContaining({
          code: 'zh_punctuation_only_line',
          level: 'error',
          segmentId: 'only'
        })
      ])
    );
  });

  it('summarizes check issues by severity and code unless verbose output is requested', () => {
    const issues = [
      {
        file: 'transcript/work/segments.toml',
        stage: 'transcript_work' as const,
        level: 'warning' as const,
        code: 'ja_line_soft_limit',
        message: 'Segment 1 Japanese line 1 has 14 chars; soft limit is 13.',
        segmentId: '1',
        segment: {
          id: '1',
          start: 0,
          end: 1.2,
          duration: 1.2,
          nextId: '2',
          jaChars: 14,
          text: 'あ'.repeat(14)
        }
      },
      {
        file: 'transcript/work/segments.toml',
        stage: 'transcript_work' as const,
        level: 'warning' as const,
        code: 'ja_line_soft_limit',
        message: 'Segment 2 Japanese line 1 has 15 chars; soft limit is 13.',
        segmentId: '2',
        segment: {
          id: '2',
          start: 1.2,
          end: 2.4,
          duration: 1.2,
          previousId: '1',
          jaChars: 15,
          text: 'い'.repeat(15)
        }
      }
    ];
    const summarizedLogger = { warn: vi.fn(), error: vi.fn() };
    const verboseLogger = { warn: vi.fn(), error: vi.fn() };

    printCheckIssues(issues, { verbose: false, logger: summarizedLogger as never });
    printCheckIssues(issues, { verbose: true, logger: verboseLogger as never });

    expect(summarizedLogger.warn).toHaveBeenCalledTimes(1);
    expect(summarizedLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('2 warning issues (ja_line_soft_limit)')
    );
    expect(summarizedLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('id=1 time=0s-1.2s duration=1.2s chars=ja:14 adjacent=-|2')
    );
    expect(verboseLogger.warn).toHaveBeenCalledTimes(2);
    expect(verboseLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'transcript/work/segments.toml: Segment 1 Japanese line 1 has 14 chars; soft limit is 13.'
      )
    );
  });

  it('formats summary JSON check output by default and filters issues', () => {
    const issues = [
      {
        file: 'transcript/work/segments.toml',
        stage: 'transcript_work' as const,
        level: 'warning' as const,
        code: 'ja_terminal_punctuation',
        message: 'Segment 1 Japanese line 1 ends with punctuation.',
        segmentId: '1'
      },
      {
        file: 'translation/work/segments.toml',
        stage: 'translation_work' as const,
        level: 'error' as const,
        code: 'empty_zh',
        message: 'Segment 1 has empty Chinese text.',
        segmentId: '1'
      }
    ];

    expect(filterCheckIssues(issues, { level: 'error' })).toHaveLength(1);
    expect(filterCheckIssues(issues, { stage: 'transcript' })).toHaveLength(1);

    const json = JSON.parse(formatCheckJson(issues)) as {
      ok: boolean;
      counts: { errors: number; warnings: number };
      summary: Array<{ level: string; code: string }>;
      issues?: Array<{ level: string; code: string }>;
    };
    expect(json.ok).toBe(false);
    expect(json.counts).toEqual({ errors: 1, warnings: 1 });
    expect(json.summary.map((summary) => summary.code)).toEqual([
      'empty_zh',
      'ja_terminal_punctuation'
    ]);
    expect(json).not.toHaveProperty('issues');
  });

  it('formats full check issues only for verbose JSON output', () => {
    const issues = [
      {
        file: 'transcript/work/segments.toml',
        stage: 'transcript_work' as const,
        level: 'warning' as const,
        code: 'ja_terminal_punctuation',
        message: 'Segment 1 Japanese line 1 ends with punctuation.',
        segmentId: '1'
      },
      {
        file: 'translation/work/segments.toml',
        stage: 'translation_work' as const,
        level: 'error' as const,
        code: 'empty_zh',
        message: 'Segment 1 has empty Chinese text.',
        segmentId: '1'
      }
    ];
    const compactWriter = { write: vi.fn() };
    const verboseWriter = { write: vi.fn() };

    printCheckIssues(issues, { verbose: false, json: true, writer: compactWriter });
    printCheckIssues(issues, { verbose: true, json: true, writer: verboseWriter });

    const compactJson = JSON.parse(compactWriter.write.mock.calls[0][0] as string) as {
      issues?: Array<{ level: string; code: string }>;
    };
    const verboseJson = JSON.parse(verboseWriter.write.mock.calls[0][0] as string) as {
      issues: Array<{ level: string; code: string }>;
    };
    expect(compactJson).not.toHaveProperty('issues');
    expect(verboseJson.issues.map((issue) => issue.code)).toEqual([
      'empty_zh',
      'ja_terminal_punctuation'
    ]);
  });

  it('renders SRT and ASS subtitles', () => {
    const file = sampleTranslation();

    expect(renderSrt(file, 'ja')).toContain('00:00:00,000 --> 00:00:01,200');
    expect(renderSrt(file, 'zh')).toContain('你好');
    expect(renderAss(file, 'Title')).toContain('Dialogue: 0,0:00:00.00,0:00:01.20');
  });

  it('drops legacy source media when rewriting segments files', async () => {
    const dir = await tempDir();
    const filePath = path.join(dir, 'segments.toml');
    await writeFile(
      filePath,
      [
        'version = 1',
        '',
        '[source]',
        'kind = "transcript"',
        'media = "/absolute/video.mp4"',
        'generated_at = "2026-06-06T00:00:00.000Z"',
        '',
        '[[segments]]',
        'id = "1"',
        'start = 0',
        'end = 1',
        'speaker = "A"',
        'ja = "こんにちは"'
      ].join('\n')
    );

    const file = await readSegmentsFile(filePath);
    expect(file.source).toEqual({
      kind: 'transcript',
      generated_at: '2026-06-06T00:00:00.000Z'
    });

    await writeSegmentsFile(filePath, file);

    expect(await readFile(filePath, 'utf8')).not.toContain('media =');
  });

  it('filters empty transcript segments when merging raw chunks', () => {
    const file = mergeTranscriptChunks({
      generatedAt: '2026-06-06T00:00:00.000Z',
      chunks: [
        {
          index: 0,
          audioPath: 'chunk-000.m4a',
          start: 10,
          end: 11,
          response: {
            segments: [
              { id: 'empty', start: 0, end: 0.2, speaker: 'A', text: '' },
              { id: 'blank', start: 0.2, end: 0.4, speaker: 'A', text: '   ' },
              { id: 'ok', start: 0.4, end: 1, speaker: 'A', text: 'こんにちは' }
            ]
          }
        }
      ]
    });

    expect(file.segments).toEqual([
      {
        id: '1-ok',
        start: 10.4,
        end: 11,
        speaker: 'A',
        ja: 'こんにちは'
      }
    ]);
    expect(file.source).toEqual({
      kind: 'transcript',
      generated_at: '2026-06-06T00:00:00.000Z'
    });
  });

  it('pre-cuts long transcript segments for subtitle work', () => {
    const source: SegmentsFile = {
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
    };

    const result = precutTranscriptSegments(source);

    expect(result.segments.length).toBeGreaterThan(1);
    expect(
      result.segments.every((segment) => Array.from(segment.ja.replace(/\s/g, '')).length <= 20)
    ).toBe(true);
    expect(result.segments[0]?.start).toBe(0);
    expect(result.segments.at(-1)?.end).toBe(12);
    expect(result.segments[1]?.start).toBe(result.segments[0]?.end);
  });

  it('falls back to hard-boundary pre-cutting when no safe boundary exists', () => {
    const source: SegmentsFile = {
      ...sampleTranscript(),
      segments: [
        {
          id: 'long',
          start: 0,
          end: 12,
          speaker: 'A',
          ja: 'あ'.repeat(60)
        }
      ]
    };

    const result = precutTranscriptSegments(source);

    expect(result.segments.map((segment) => segment.id)).toEqual(['long.1', 'long.2', 'long.3']);
    expect(
      result.segments.every((segment) => Array.from(segment.ja.replace(/\s/g, '')).length <= 20)
    ).toBe(true);
    expect(result.segments[0]?.start).toBe(0);
    expect(result.segments.at(-1)?.end).toBe(12);
  });

  it('can pre-cut long transcript segments at line breaks', () => {
    const source: SegmentsFile = {
      ...sampleTranscript(),
      segments: [
        {
          id: 'long',
          start: 0,
          end: 12,
          speaker: 'A',
          ja: `${'あ'.repeat(13)}\n${'い'.repeat(13)}`
        }
      ]
    };

    const result = precutTranscriptSegments(source);

    expect(result.segments.map((segment) => segment.id)).toEqual(['long.1', 'long.2']);
    expect(result.segments[0]?.ja).toBe('あ'.repeat(13));
    expect(result.segments[1]?.ja).toBe('い'.repeat(13));
  });
});

describe('segment edit tools', () => {
  it('lists segments by id, offset range, or time range', () => {
    const segments = [
      ...sampleTranscript().segments,
      { id: '3', start: 3, end: 4.2, speaker: 'C', ja: 'またね' }
    ];

    expect(listSegments(segments, { ids: ['2', '1'] }).map((segment) => segment.id)).toEqual([
      '2',
      '1'
    ]);
    expect(listSegments(segments, { offset: 1, limit: 1 }).map((segment) => segment.id)).toEqual([
      '2'
    ]);
    expect(listSegments(segments, { offset: 1 }).map((segment) => segment.id)).toEqual(['2', '3']);
    expect(listSegments(segments, { start: 1.2, end: 2.8 }).map((segment) => segment.id)).toEqual([
      '2'
    ]);
    expect(listSegments(segments, { ids: ['2'], around: 1 }).map((segment) => segment.id)).toEqual([
      '1',
      '2',
      '3'
    ]);
  });

  it('rejects conflicting or invalid segment list filters', () => {
    const segments = sampleTranscript().segments;

    expect(() => listSegments(segments, { ids: ['1'], offset: 0 })).toThrow('mutually exclusive');
    expect(() => listSegments(segments, { issues: ['overlap'], start: 0, end: 1 })).toThrow(
      'mutually exclusive'
    );
    expect(() => listSegments(segments, { start: 0 })).toThrow('provided together');
    expect(() => listSegments(segments, { start: 2, end: 1 })).toThrow('greater than or equal');
    expect(() => listSegments(segments, { offset: -1 })).toThrow('non-negative integer');
    expect(() => listSegments(segments, { ids: ['missing'] })).toThrow('segment not found');
    expect(() => listSegments(segments, { around: 1 })).toThrow('requires exactly one --id');
    expect(() => listSegments(segments, { ids: ['1', '2'], around: 1 })).toThrow(
      'requires exactly one --id'
    );
  });

  it('lists segments by issue filters', () => {
    const segments = [
      { id: 'invalid', start: 2, end: 1, speaker: 'A', ja: '時間' },
      { id: 'overlap', start: 0.5, end: 1.5, speaker: 'A', ja: '重なり' },
      { id: 'long-duration', start: 1.5, end: 9, speaker: 'A', ja: '長い' },
      { id: 'long-text', start: 9, end: 10, speaker: 'A', ja: 'あ'.repeat(21) },
      { id: 'fragment', start: 10, end: 11, speaker: 'A', ja: 'あ' },
      { id: 'missing-zh', start: 12, end: 13, speaker: 'A', ja: '未翻訳' },
      { id: 'blank-zh', start: 13, end: 14, speaker: 'A', ja: '空白', zh: '  ' },
      { id: 'ok', start: 14, end: 15, speaker: 'A', ja: '大丈夫です', zh: '没问题' }
    ];

    expect(
      listSegments(segments, { issues: ['invalid-time', 'overlap'] }).map((segment) => segment.id)
    ).toEqual(['invalid', 'overlap']);
    expect(listSegments(segments, { issues: ['long'] }).map((segment) => segment.id)).toEqual([
      'long-duration',
      'long-text'
    ]);
    expect(listSegments(segments, { issues: ['fragment'] }).map((segment) => segment.id)).toEqual([
      'fragment'
    ]);
    expect(listSegments(segments, { issues: ['empty-zh'] }).map((segment) => segment.id)).toEqual([
      'invalid',
      'overlap',
      'long-duration',
      'long-text',
      'fragment',
      'missing-zh',
      'blank-zh'
    ]);
    expect(
      listSegments(segments, { issues: ['fragment', 'empty-zh'] }).map((segment) => segment.id)
    ).toContain('blank-zh');
  });

  it('formats segment command output as human table, csv, or json', () => {
    const segments = [
      {
        id: '1',
        start: 0,
        end: 1.2,
        speaker: 'A',
        ja: 'こんにちは, "皆さん"\n次',
        zh: '你好'
      }
    ];

    expect(formatSegments(segments, 'human')).toContain(
      '1   00:00  00:01  A        こんにちは, "皆さん"\\n次  你好'
    );
    expect(formatSegments(segments, 'csv')).toBe(
      'id,start,end,speaker,ja,zh\n1,0,1.2,A,"こんにちは, ""皆さん""\n次",你好'
    );
    expect(JSON.parse(formatSegments(segments, 'json'))).toEqual({
      segments: [
        {
          id: '1',
          start: 0,
          end: 1.2,
          speaker: 'A',
          ja: 'こんにちは, "皆さん"\n次',
          zh: '你好'
        }
      ]
    });
    expect(
      JSON.parse(
        formatSegments(segments, 'json', {
          stats: { total: 2, listed: 1, translated: 1, untranslated: 1 }
        })
      )
    ).toEqual({
      segments: [
        {
          id: '1',
          start: 0,
          end: 1.2,
          speaker: 'A',
          ja: 'こんにちは, "皆さん"\n次',
          zh: '你好'
        }
      ],
      stats: { total: 2, listed: 1, translated: 1, untranslated: 1 }
    });
    expect(
      formatSegments(segments, 'human', {
        stats: { total: 2, listed: 1, translated: 1, untranslated: 1 }
      })
    ).toContain('total 2  listed 1  translated 1  untranslated 1');
    expect(
      formatSegments(segments, 'csv', {
        stats: { total: 2, listed: 1, translated: 1, untranslated: 1 }
      })
    ).not.toContain('total 2');
  });

  it('aligns human segment output with full-width Japanese and Chinese text', () => {
    const output = formatSegments(
      [
        { id: '1', start: 0, end: 1, speaker: 'A', ja: 'aa', zh: '短' },
        { id: '2', start: 1, end: 2, speaker: 'A', ja: 'ああ', zh: '长' }
      ],
      'human'
    );
    const rows = output.split('\n').slice(2);
    const prefixWidths = rows.map((row) => stringWidth(row.slice(0, row.lastIndexOf('  ') + 2)));

    expect(prefixWidths[0]).toBe(prefixWidths[1]);
  });

  it('applies segment field patches atomically', () => {
    const file = sampleTranslation();
    const patch = parseSegmentPatch(
      [
        '[[edits]]',
        'id = "1"',
        'zh = "您好"',
        '',
        '[[edits]]',
        'id = "2"',
        'start = 2.5',
        'end = 3.5',
        'speaker = "C"',
        'ja = "またね"',
        'zh = "回头见"'
      ].join('\n')
    );

    expect(applySegmentPatch(file, patch)).toEqual({
      edits: [
        { id: '1', start: 0, end: 1.2, speaker: 'A', ja: 'こんにちは', zh: '您好' },
        { id: '2', start: 2.5, end: 3.5, speaker: 'C', ja: 'またね', zh: '回头见' }
      ],
      splits: [],
      merges: [],
      deletes: []
    });
    expect(file.segments).toEqual([
      { id: '1', start: 0, end: 1.2, speaker: 'A', ja: 'こんにちは', zh: '您好' },
      { id: '2', start: 2.5, end: 3.5, speaker: 'C', ja: 'またね', zh: '回头见' }
    ]);
  });

  it('applies patches without running full subtitle validation', () => {
    const file = sampleTranslation();

    expect(() =>
      applySegmentPatch(file, {
        edits: [{ id: '1', zh: '第一行\n第二行\n第三行' }]
      })
    ).not.toThrow();
    expect(file.segments[0]?.zh).toBe('第一行\n第二行\n第三行');
  });

  it('allows small floating point drift in split patch coverage', () => {
    const file: SegmentsFile = {
      ...sampleTranscript(),
      segments: [{ id: 'long', start: 10.123456, end: 12.654321, speaker: 'A', ja: '長い文' }]
    };

    expect(() =>
      applySegmentPatch(file, {
        splits: [
          {
            id: 'long',
            segments: [
              { id: 'long.1', start: 10.123956, end: 11.0004, speaker: 'A', ja: '前半' },
              { id: 'long.2', start: 11.0009, end: 12.653821, speaker: 'A', ja: '後半' }
            ]
          }
        ]
      })
    ).not.toThrow();
  });

  it('applies split, merge, and delete patches atomically', () => {
    const file: SegmentsFile = {
      ...sampleTranscript(),
      segments: [
        { id: 'long', start: 0, end: 4, speaker: 'A', ja: '長い文です' },
        { id: '2', start: 4, end: 5, speaker: 'B', ja: '次' },
        { id: '3', start: 5, end: 6, speaker: 'C', ja: '続き' },
        { id: 'delete-me', start: 6, end: 7, speaker: 'C', ja: '削除' }
      ]
    };
    const patch = parseSegmentPatch(
      [
        '[[splits]]',
        'id = "long"',
        '',
        '[[splits.segments]]',
        'id = "long.1"',
        'start = 0',
        'end = 2',
        'speaker = "A"',
        'ja = "前半"',
        '',
        '[[splits.segments]]',
        'id = "long.2"',
        'start = 2',
        'end = 4',
        'speaker = "A"',
        'ja = "後半"',
        '',
        '[[merges]]',
        'ids = ["2", "3"]',
        'id = "2-3"',
        'speaker = "B,C"',
        'ja = "次続き"',
        '',
        '[[deletes]]',
        'id = "delete-me"'
      ].join('\n')
    );

    expect(applySegmentPatch(file, patch)).toEqual({
      edits: [],
      splits: [
        { id: 'long.1', start: 0, end: 2, speaker: 'A', ja: '前半' },
        { id: 'long.2', start: 2, end: 4, speaker: 'A', ja: '後半' }
      ],
      merges: [{ id: '2-3', start: 4, end: 6, speaker: 'B,C', ja: '次続き' }],
      deletes: [{ id: 'delete-me', start: 6, end: 7, speaker: 'C', ja: '削除' }]
    });
    expect(file.segments).toEqual([
      { id: 'long.1', start: 0, end: 2, speaker: 'A', ja: '前半' },
      { id: 'long.2', start: 2, end: 4, speaker: 'A', ja: '後半' },
      { id: '2-3', start: 4, end: 6, speaker: 'B,C', ja: '次続き' }
    ]);
  });

  it('rejects invalid segment patches without changing the source file', () => {
    const file = sampleTranslation();

    expect(() => parseSegmentPatch('')).toThrow();
    expect(() =>
      parseSegmentPatch(
        ['[[splits]]', 'id = "1"', '', '[[splits.segments]]', 'id = "1.1"'].join('\n')
      )
    ).toThrow();

    expect(() =>
      applySegmentPatch(file, {
        edits: [
          { id: '1', zh: '您好' },
          { id: 'missing', zh: '缺失' }
        ]
      })
    ).toThrow('segment not found');
    expect(file).toEqual(sampleTranslation());

    expect(() =>
      applySegmentPatch(file, {
        edits: [
          { id: '1', zh: '您好' },
          { id: '1', zh: '你好' }
        ]
      })
    ).toThrow('duplicate edit id');

    expect(() => applySegmentPatch(file, { deletes: [{ id: 'missing' }] })).toThrow(
      'segment not found'
    );
    expect(() => applySegmentPatch(file, { deletes: [{ id: '1' }, { id: '1' }] })).toThrow(
      'duplicate delete id'
    );
  });

  it('rejects invalid split and merge patches without changing the source file', () => {
    const file = sampleTranslation();

    expect(() =>
      applySegmentPatch(file, {
        splits: [
          {
            id: '1',
            segments: [
              { id: '1.1', start: 0, end: 0.5, speaker: 'A', ja: 'こん', zh: '你' },
              { id: '1.2', start: 0.6, end: 1.2, speaker: 'A', ja: 'にちは', zh: '好' }
            ]
          }
        ]
      })
    ).toThrow('continuous');
    expect(file).toEqual(sampleTranslation());

    expect(() =>
      applySegmentPatch(file, {
        splits: [
          {
            id: '1',
            segments: [
              { id: '1.1', start: 0, end: 0.6, speaker: 'A', ja: 'こん', zh: '你' },
              { id: '2', start: 0.6, end: 1.2, speaker: 'A', ja: 'にちは', zh: '好' }
            ]
          }
        ]
      })
    ).toThrow('duplicate final segment id');

    expect(() =>
      applySegmentPatch(file, {
        splits: [
          {
            id: '1',
            segments: [
              { id: '1.1', start: 0, end: 0.6, speaker: 'A', ja: 'こん' },
              { id: '1.2', start: 0.6, end: 1.2, speaker: 'A', ja: 'にちは', zh: '好' }
            ]
          }
        ]
      })
    ).toThrow('requires zh');

    expect(() =>
      applySegmentPatch(file, {
        merges: [{ ids: ['1', 'missing'], id: '1-3', ja: '結合', zh: '合并' }]
      })
    ).toThrow('segment not found');

    expect(() =>
      applySegmentPatch(
        {
          ...sampleTranslation(),
          segments: [
            sampleTranslation().segments[0]!,
            { id: 'gap', start: 1.25, end: 1.4, speaker: 'A', ja: '間', zh: '中间' },
            sampleTranslation().segments[1]!
          ]
        },
        { merges: [{ ids: ['1', '2'], id: '1-2', ja: '結合', zh: '合并' }] }
      )
    ).toThrow('adjacent');

    expect(() =>
      applySegmentPatch(file, {
        merges: [{ ids: ['1', '2'], id: '1-2', ja: '結合' }]
      })
    ).toThrow('requires zh');
  });

  it('edits, splits, merges, and deletes transcript work segments', async () => {
    const dir = await preparedSession('transcript_work', {
      transcript_work: {
        status: 'waiting',
        segments: 'transcript/work/segments.toml'
      }
    });
    await mkdir(path.join(dir, 'transcript/work'), { recursive: true });
    await writeSegmentsFile(path.join(dir, 'transcript/work/segments.toml'), sampleTranscript());

    const context = await loadSegmentEditContext({ sessionTarget: dir });
    editSegment(context.file, '1', { speaker: 'A,B', ja: 'こんにちはみなさん' });
    splitSegment(context.file, '1', {
      at: 0.6,
      id1: '1.1',
      id2: '1.2',
      ja1: 'こんにちは',
      ja2: 'みなさん',
      speaker2: 'B'
    });
    mergeSegments(context.file, '1.1', '1.2', {
      id: '1',
      ja: 'こんにちはみなさん'
    });
    deleteSegment(context.file, '2');
    await persistSegmentEdit(context);

    const result = await readSegmentsFile(path.join(dir, 'transcript/work/segments.toml'));
    expect(result.segments).toEqual([
      {
        id: '1',
        start: 0,
        end: 1.2,
        speaker: 'A,B',
        ja: 'こんにちはみなさん'
      }
    ]);
  });

  it('supports structural edits on translation work segments', async () => {
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

    const context = await loadSegmentEditContext({ sessionTarget: dir });
    editSegment(context.file, '2', { start: 2, end: 3, speaker: 'C', ja: 'またね', zh: '回头见' });
    splitSegment(context.file, '1', {
      at: 0.6,
      id1: '1.1',
      id2: '1.2',
      ja1: 'こん',
      ja2: 'にちは',
      zh1: '你',
      zh2: '好'
    });
    mergeSegments(context.file, '1.1', '1.2', {
      id: '1',
      ja: 'こんにちは',
      zh: '你好'
    });
    await persistSegmentEdit(context);

    const result = await readSegmentsFile(path.join(dir, 'translation/work/segments.toml'));
    expect(result.segments).toEqual([
      { id: '1', start: 0, end: 1.2, speaker: 'A', ja: 'こんにちは', zh: '你好' },
      { id: '2', start: 2, end: 3, speaker: 'C', ja: 'またね', zh: '回头见' }
    ]);
  });

  it('persists segment edits without running full subtitle validation', async () => {
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

    const context = await loadSegmentEditContext({ sessionTarget: dir });
    editSegment(context.file, '1', { zh: '第一行\n第二行\n第三行' });
    await persistSegmentEdit(context);

    const result = await readSegmentsFile(path.join(dir, 'translation/work/segments.toml'));
    expect(result.segments[0]?.zh).toBe('第一行\n第二行\n第三行');
  });

  it('requires zh when splitting or merging already translated segments', async () => {
    const file = sampleTranslation();

    expect(() =>
      splitSegment(file, '1', {
        at: 0.6,
        id1: '1.1',
        id2: '1.2',
        ja1: 'こん',
        ja2: 'にちは'
      })
    ).toThrow('requires --zh1 and --zh2');

    expect(() =>
      mergeSegments(file, '1', '2', {
        id: '1-2',
        ja: 'こんにちはさようなら'
      })
    ).toThrow('requires --zh');
  });

  it('resolves cwd sessions and marks committed stages dirty after edits', async () => {
    const dir = await preparedCompleteSession();
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      await expect(loadSegmentEditContext({})).rejects.toThrow('current stage is not manual');
      const context = await loadSegmentEditContext({ stage: 'translation' });
      editSegment(context.file, '1', { zh: '您好' });
      await persistSegmentEdit(context);
    } finally {
      process.chdir(cwd);
    }

    const session = await Session.loadOrCreate(dir);
    await session.refreshDirtyState();
    expect(session.stage('translation_work').status).toBe('dirty');
    const result = await readSegmentsFile(path.join(dir, 'translation/work/segments.toml'));
    expect(result.segments[0]?.zh).toBe('您好');
  });

  it('rejects duplicate split ids, non-adjacent merges, and unknown deletes', () => {
    const file = {
      ...sampleTranscript(),
      segments: [
        ...sampleTranscript().segments,
        { id: '3', start: 3, end: 4.2, speaker: 'C', ja: 'またね' }
      ]
    };

    expect(() =>
      splitSegment(file, '1', {
        at: 0.6,
        id1: '1.1',
        id2: '2',
        ja1: 'こん',
        ja2: 'にちは'
      })
    ).toThrow('already exists');

    expect(() =>
      mergeSegments(file, '1', '3', {
        id: '1-3',
        ja: '結合'
      })
    ).toThrow('must be adjacent');

    expect(() => deleteSegment(file, 'missing')).toThrow('segment not found');
  });
});
