import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { stringWidth } from 'breadc';
import { stringify } from 'smol-toml';
import { describe, expect, it, vi } from 'vitest';

import { Session } from '../src/index.js';
import {
  applySegmentPatch,
  parseSegmentPatch,
  summarizeSegmentPatchResult
} from '../src/segments/apply.js';
import {
  deleteSegment,
  editSegment,
  loadSegmentEditContext,
  mergeSegments,
  persistSegmentEdit,
  splitSegment
} from '../src/segments/edit.js';
import {
  formatValidationErrorSummary,
  readSegmentsFile,
  validateSegments,
  writeSegmentsFile
} from '../src/segments/index.js';
import { listSegments, type SegmentIssueFilter } from '../src/segments/list.js';
import { formatSegmentPatchStats, formatSegments } from '../src/segments/output.js';
import {
  checkSegmentsFile,
  filterCheckIssues,
  formatCheckJson,
  printCheckIssues,
  resolveCheckScope
} from '../src/session/check.js';
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

    expect(issues.some((issue) => issue.code === 'overlap' && issue.level === 'fatal')).toBe(true);
    expect(issues.some((issue) => issue.code === 'empty_zh' && issue.level === 'fatal')).toBe(true);
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
            end: 4,
            speaker: 'A',
            ja: 'あ'.repeat(21),
            zh: '你'.repeat(17)
          },
          {
            id: 'hard',
            start: 4.3,
            end: 8.3,
            speaker: 'A',
            ja: 'あ'.repeat(29),
            zh: '你'.repeat(25)
          },
          {
            id: 'punctuation',
            start: 8.6,
            end: 9.6,
            speaker: 'A',
            ja: 'これは、テストです。',
            zh: '你好，世界。'
          },
          {
            id: 'soft-break',
            start: 9.9,
            end: 10.9,
            speaker: 'A',
            ja: '一行目\n二行目',
            zh: '第一行\n第二行'
          },
          {
            id: 'hard-break',
            start: 11.2,
            end: 12.2,
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
          ja: `${'あ'.repeat(16)}\n${'あ'.repeat(15)}`,
          zh: '好'
        },
        {
          id: 'ja-speed-hard',
          start: 2.3,
          end: 4.3,
          speaker: 'A',
          ja: `${'あ'.repeat(21)}\n${'あ'.repeat(20)}`,
          zh: '好'
        },
        {
          id: 'zh-speed-soft',
          start: 4.6,
          end: 6.6,
          speaker: 'A',
          ja: 'あ',
          zh: '你'.repeat(23)
        },
        {
          id: 'zh-speed-hard',
          start: 6.9,
          end: 8.4,
          speaker: 'A',
          ja: 'あ',
          zh: '你'.repeat(23)
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
        { id: '2', start: 1.07, end: 2, speaker: 'A', ja: '二' },
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

  it('allows exact and near hard minimum subtitle gaps', () => {
    const issues = validateSegments({
      version: 1,
      source: { kind: 'transcript', generated_at: '2026-06-06T00:00:00.000Z' },
      segments: [
        { id: '1', start: 0, end: 1, speaker: 'A', ja: '一' },
        { id: '2', start: 1.08, end: 2, speaker: 'A', ja: '二' },
        { id: '3', start: 2.0795, end: 3, speaker: 'A', ja: '三' },
        { id: '4', start: 3.07, end: 4, speaker: 'A', ja: '四' }
      ]
    });

    expect(
      issues
        .filter((issue) => issue.code === 'subtitle_gap_too_short')
        .map((issue) => issue.segmentId)
    ).toEqual(['4']);
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

  it('downgrades matched segment skip checks to warnings with reasons', () => {
    const issues = validateSegments({
      version: 1,
      source: { kind: 'translation', generated_at: '2026-06-06T00:00:00.000Z' },
      segments: [
        {
          id: 'title',
          start: 0,
          end: 3,
          speaker: 'A',
          ja: 'タイトル',
          zh: 'STRAIGHT!!! REACH!! CHEER!!!',
          skip_checks: [
            { code: 'zh_line_hard_limit', reason: 'Official title should stay on one line.' },
            { code: 'zh_repeated_punctuation', reason: 'Official title spelling.' }
          ]
        }
      ]
    });

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'zh_line_hard_limit',
          level: 'warning',
          message: expect.stringContaining('Official title should stay on one line.')
        }),
        expect.objectContaining({
          code: 'zh_repeated_punctuation',
          level: 'warning',
          message: expect.stringContaining('Official title spelling.')
        })
      ])
    );
    expect(issues.some((issue) => issue.level === 'error')).toBe(false);
  });

  it('reports stale segment skip checks as fatal issues', () => {
    const issues = validateSegments({
      version: 1,
      source: { kind: 'translation', generated_at: '2026-06-06T00:00:00.000Z' },
      segments: [
        {
          id: 'clean',
          start: 0,
          end: 3,
          speaker: 'A',
          ja: 'タイトル',
          zh: '标题',
          skip_checks: [{ code: 'zh_line_hard_limit', reason: 'Old exception.' }]
        }
      ]
    });

    expect(issues).toContainEqual(
      expect.objectContaining({
        code: 'unused_skip_check',
        level: 'fatal',
        segmentId: 'clean',
        message: expect.stringContaining('zh_line_hard_limit')
      })
    );
  });

  it('rejects invalid segment skip check metadata', () => {
    expect(
      validateSegments({
        version: 1,
        source: { kind: 'translation', generated_at: '2026-06-06T00:00:00.000Z' },
        segments: [
          {
            id: 'bad-code',
            start: 0,
            end: 3,
            speaker: 'A',
            ja: 'タイトル',
            zh: '标题',
            skip_checks: [{ code: 'empty_zh', reason: 'Not skippable.' }]
          }
        ]
      })
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'schema',
          level: 'fatal',
          message: expect.stringContaining('segments.0.skip_checks.0.code')
        })
      ])
    );

    expect(
      validateSegments({
        version: 1,
        source: { kind: 'translation', generated_at: '2026-06-06T00:00:00.000Z' },
        segments: [
          {
            id: 'bad-reason',
            start: 0,
            end: 3,
            speaker: 'A',
            ja: 'タイトル',
            zh: '标题',
            skip_checks: [{ code: 'zh_line_hard_limit', reason: '' }]
          }
        ]
      })
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'schema',
          level: 'fatal',
          message: expect.stringContaining('segments.0.skip_checks.0.reason')
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
        message: 'Segment 1 Japanese line 1 has 21 chars; soft limit is 20.',
        segmentId: '1',
        segment: {
          id: '1',
          start: 0,
          end: 4,
          duration: 4,
          nextId: '2',
          jaChars: 21,
          text: 'あ'.repeat(21)
        }
      },
      {
        file: 'transcript/work/segments.toml',
        stage: 'transcript_work' as const,
        level: 'warning' as const,
        code: 'ja_line_soft_limit',
        message: 'Segment 2 Japanese line 1 has 22 chars; soft limit is 20.',
        segmentId: '2',
        segment: {
          id: '2',
          start: 4.3,
          end: 8.3,
          duration: 4,
          previousId: '1',
          jaChars: 22,
          text: 'い'.repeat(22)
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
      expect.stringContaining('id=1 time=0s-4s duration=4s chars=ja:21 adjacent=-|2')
    );
    expect(verboseLogger.warn).toHaveBeenCalledTimes(2);
    expect(verboseLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'transcript/work/segments.toml: Segment 1 Japanese line 1 has 21 chars; soft limit is 20.'
      )
    );
  });

  it('formats compact summary JSON check output by default and filters issues', () => {
    const sessionDir = path.join('/tmp', 'rajio-session');
    const transcriptFile = path.join(sessionDir, 'transcript/work/segments.toml');
    const translationFile = path.join(sessionDir, 'translation/work/segments.toml');
    const issues = [
      {
        file: transcriptFile,
        stage: 'transcript_work' as const,
        level: 'error' as const,
        code: 'ja_line_hard_limit',
        message: 'Segment 1 Japanese line 1 has 29 chars; hard limit is 28.',
        segmentId: '1'
      },
      {
        file: transcriptFile,
        stage: 'transcript_work' as const,
        level: 'warning' as const,
        code: 'ja_terminal_punctuation',
        message: 'Segment 2 Japanese line 1 ends with ordinary punctuation.',
        segmentId: '2'
      },
      {
        file: transcriptFile,
        stage: 'transcript_work' as const,
        level: 'error' as const,
        code: 'duration_too_short',
        message: 'Segment 3 duration is 0.49s; hard minimum is 0.5s.',
        segmentId: '3'
      },
      {
        file: translationFile,
        stage: 'translation_work' as const,
        level: 'error' as const,
        code: 'zh_line_hard_limit',
        message: 'Segment 4 Chinese line 1 has 25 chars; hard limit is 24.',
        segmentId: '4'
      },
      {
        file: translationFile,
        stage: 'translation_work' as const,
        level: 'warning' as const,
        code: 'subtitle_gap_short',
        message: 'Segment 5 starts 0.1s after previous segment 4; recommended gap is 0.25s.',
        segmentId: '5'
      },
      {
        file: translationFile,
        stage: 'translation_work' as const,
        level: 'error' as const,
        code: 'ja_line_hard_limit',
        message: 'Segment 6 Japanese line 1 has 29 chars; hard limit is 28.',
        segmentId: '6'
      },
      {
        file: translationFile,
        stage: 'translation_work' as const,
        level: 'warning' as const,
        code: 'zh_terminal_punctuation',
        message: 'Segment 7 Chinese line 1 ends with ordinary punctuation.',
        segmentId: '7'
      },
      {
        file: path.join(sessionDir, 'session.toml'),
        level: 'fatal' as const,
        code: 'invalid_schema_version',
        message: 'schema_version must be 1.'
      }
    ];

    expect(filterCheckIssues(issues, { level: 'fatal', currentStage: 'translation_work' })).toEqual(
      [expect.objectContaining({ code: 'invalid_schema_version' })]
    );
    expect(
      filterCheckIssues(issues, { level: 'error', currentStage: 'translation_work' }).map(
        (issue) => issue.code
      )
    ).toEqual(['zh_line_hard_limit', 'invalid_schema_version']);
    expect(
      filterCheckIssues(issues, { stage: 'translation', language: 'ja' }).map((issue) => issue.code)
    ).toEqual(['subtitle_gap_short', 'ja_line_hard_limit', 'invalid_schema_version']);
    expect(filterCheckIssues(issues, { stage: 'transcript' }).map((issue) => issue.code)).toEqual([
      'ja_line_hard_limit',
      'ja_terminal_punctuation',
      'duration_too_short',
      'invalid_schema_version'
    ]);
    expect(() => filterCheckIssues(issues, { stage: 'transcript', language: 'zh' })).toThrow(
      'transcript check supports only --language ja.'
    );
    expect(filterCheckIssues(issues, { stage: 'audio' })).toEqual([
      expect.objectContaining({ code: 'invalid_schema_version' })
    ]);

    const scope = resolveCheckScope({ currentStage: 'translation_work' });
    expect(scope).toMatchObject({
      level: 'warning',
      stage: 'translation_work',
      language: 'zh',
      description: 'translation_work zh QA',
      hint: 'Use --language ja to inspect Japanese QA.'
    });

    const output = formatCheckJson(issues, { sessionDir, scope });
    expect(output).not.toContain('\n');

    const json = JSON.parse(output) as {
      ok: boolean;
      scope: {
        level: string;
        stage: string;
        language: string;
        description: string;
        hint: string;
      };
      counts: { fatal: number; error: number; warning: number };
      summary: Array<{
        file: string;
        stage?: string;
        level: string;
        code: string;
        count: number;
        examples?: Array<Record<string, string>>;
      }>;
      issues?: Array<{ level: string; code: string }>;
    };
    expect(json.ok).toBe(false);
    expect(json.scope).toEqual(scope);
    expect(json.counts).toEqual({ fatal: 1, error: 4, warning: 3 });
    expect(json).not.toHaveProperty('issues');
    expect(json.summary.every((summary) => !('stage' in summary))).toBe(true);

    const transcriptSummary = json.summary.find(
      (summary) =>
        summary.file === 'transcript/work/segments.toml' && summary.code === 'ja_line_hard_limit'
    );
    expect(transcriptSummary).toMatchObject({
      level: 'error',
      count: 1,
      examples: [{ id: '1' }]
    });
    expect(transcriptSummary?.examples?.every((example) => Object.keys(example).length === 1)).toBe(
      true
    );
    expect(
      json.summary.filter(
        (summary) => summary.level === 'error' && summary.code === 'ja_line_hard_limit'
      )
    ).toHaveLength(2);

    const sessionSummary = json.summary.find((summary) => summary.file === 'session.toml');
    expect(sessionSummary).not.toHaveProperty('examples');
    expect(formatCheckJson(issues, { sessionDir, pretty: true })).toContain('\n  "ok"');
  });

  it('prints check scope before human output when provided', () => {
    const issues = [
      {
        file: 'translation/work/segments.toml',
        stage: 'translation_work' as const,
        level: 'warning' as const,
        code: 'zh_terminal_punctuation',
        message: 'Segment 1 Chinese line 1 ends with ordinary punctuation.',
        segmentId: '1'
      }
    ];
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const scope = resolveCheckScope({ currentStage: 'translation_work' });

    printCheckIssues(issues, { verbose: false, logger: logger as never, scope });

    expect(logger.info).toHaveBeenCalledWith(
      'check scope: translation_work zh QA. Use --language ja to inspect Japanese QA.'
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('1 warning issue (zh_terminal_punctuation)')
    );

    const emptyLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    printCheckIssues([], { verbose: false, logger: emptyLogger as never, scope });
    printCheckIssues([], {
      verbose: false,
      logger: emptyLogger as never,
      scope,
      scopeLabel: 'commit',
      printScopeWhenEmpty: false
    });
    expect(emptyLogger.info).toHaveBeenCalledTimes(1);
    expect(emptyLogger.info).toHaveBeenCalledWith(
      'check scope: translation_work zh QA. Use --language ja to inspect Japanese QA.'
    );
  });

  it('checks a single segments file with inferred stage and segment context', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'rajio-check-segments-'));
    const filePath = path.join(dir, 'translation/work/segments.toml');
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      stringify({
        version: 1,
        source: { kind: 'translation', generated_at: '2026-06-06T00:00:00.000Z' },
        segments: [
          {
            id: '1',
            start: 0,
            end: 4,
            speaker: 'A',
            ja: 'こんにちは',
            zh: '你'.repeat(17)
          }
        ]
      })
    );

    const issues = await checkSegmentsFile(filePath);

    expect(issues).toEqual([
      expect.objectContaining({
        file: filePath,
        stage: 'translation_work',
        level: 'warning',
        code: 'zh_line_soft_limit',
        segmentId: '1',
        segment: expect.objectContaining({
          id: '1',
          start: 0,
          end: 4,
          zhChars: 17
        })
      })
    ]);
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

    const ttyWriter = { isTTY: true, write: vi.fn() };
    printCheckIssues(issues, { verbose: false, json: true, writer: ttyWriter });
    expect(ttyWriter.write.mock.calls[0][0]).toContain('\n  "ok"');
  });

  it('summarizes validation errors without printing every message', () => {
    expect(
      formatValidationErrorSummary(
        [
          { level: 'error', code: 'empty_ja', message: 'Segment 1 has empty Japanese text.' },
          { level: 'error', code: 'empty_ja', message: 'Segment 2 has empty Japanese text.' },
          { level: 'error', code: 'overlap', message: 'Segment 2 overlaps previous segment 1.' }
        ],
        'transcript_work transcript/work/segments.toml'
      )
    ).toBe(
      'transcript_work transcript/work/segments.toml has 3 blocking issues (empty_ja: 2, overlap: 1).'
    );
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

  it('preserves empty transcript segments when merging raw chunks', () => {
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
        id: '1-empty',
        start: 10,
        end: 10.2,
        speaker: 'A',
        ja: ''
      },
      {
        id: '1-blank',
        start: 10.2,
        end: 10.4,
        speaker: 'A',
        ja: '   '
      },
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
});

describe('segment edit tools', () => {
  it('lists segments by id, offset range, or time range', () => {
    const segments = [
      ...sampleTranscript().segments,
      { id: '3', start: 3, end: 4.2, speaker: 'C', ja: 'またね' }
    ];

    expect(listSegments(segments, { id: '2' }).map((segment) => segment.id)).toEqual(['2']);
    expect(listSegments(segments, { offset: 1, limit: 1 }).map((segment) => segment.id)).toEqual([
      '2'
    ]);
    expect(listSegments(segments, { offset: 1 }).map((segment) => segment.id)).toEqual(['2', '3']);
    expect(listSegments(segments, { start: 1.2, end: 2.8 }).map((segment) => segment.id)).toEqual([
      '2'
    ]);
    expect(listSegments(segments, { id: '2', around: 1 }).map((segment) => segment.id)).toEqual([
      '1',
      '2',
      '3'
    ]);
  });

  it('rejects conflicting or invalid segment list filters', () => {
    const segments = sampleTranscript().segments;

    expect(() => listSegments(segments, { id: '1', offset: 0 })).toThrow('mutually exclusive');
    expect(() => listSegments(segments, { issues: ['overlap'], start: 0, end: 1 })).toThrow(
      'mutually exclusive'
    );
    expect(() => listSegments(segments, { start: 0 })).toThrow('provided together');
    expect(() => listSegments(segments, { start: 2, end: 1 })).toThrow('greater than or equal');
    expect(() => listSegments(segments, { offset: -1 })).toThrow('non-negative integer');
    expect(() => listSegments(segments, { id: 'missing' })).toThrow('segment not found');
    expect(() => listSegments(segments, { around: 1 })).toThrow('requires --id');
  });

  it('lists segments by issue filters', () => {
    const segments = [
      { id: 'base', start: 0, end: 1, speaker: 'A', ja: '基準です', zh: '基准' },
      { id: 'overlap', start: 0.9, end: 1.5, speaker: 'A', ja: '重なり', zh: '重叠' },
      { id: 'gap-short', start: 1.6, end: 2.5, speaker: 'A', ja: '短い間隔', zh: '短间隔' },
      { id: 'duration-long', start: 2.75, end: 9.9, speaker: 'A', ja: '長い', zh: '很长' },
      { id: 'hard-line', start: 10.2, end: 11.2, speaker: 'A', ja: 'あ'.repeat(29), zh: '长行' },
      { id: 'punctuation-only', start: 11.5, end: 12.5, speaker: 'A', ja: '！？', zh: '？！' },
      { id: 'missing-zh', start: 12.8, end: 13.8, speaker: 'A', ja: '未翻訳' },
      { id: 'blank-zh', start: 14.1, end: 15.1, speaker: 'A', ja: '空白', zh: '  ' },
      { id: 'ok', start: 15.4, end: 16.4, speaker: 'A', ja: '大丈夫です', zh: '没问题' },
      { id: 'invalid', start: 16.7, end: 16.6, speaker: 'A', ja: '時間', zh: '时间' }
    ];
    const file = {
      version: 1 as const,
      source: { kind: 'translation' as const, generated_at: '2026-06-06T00:00:00.000Z' },
      segments
    };
    const validationIssues = validateSegments(file, { requireZh: true });
    const listByIssues = (...issues: SegmentIssueFilter[]) =>
      listSegments(segments, { issues, validationIssues }).map((segment) => segment.id);

    expect(listByIssues('invalid_time', 'overlap')).toEqual(['overlap', 'invalid']);
    expect(listByIssues('duration_too_long')).toEqual(['duration-long']);
    expect(listByIssues('ja_line_hard_limit')).toEqual(['hard-line']);
    expect(listByIssues('subtitle_gap_short')).toEqual(['gap-short']);
    expect(listByIssues('ja_punctuation_only_line')).toEqual(['punctuation-only']);
    expect(listByIssues('empty_zh')).toEqual(['missing-zh', 'blank-zh']);
    expect(listByIssues('ja_line_hard_limit', 'empty_zh')).toEqual([
      'hard-line',
      'missing-zh',
      'blank-zh'
    ]);
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
    expect(formatSegments(segments, 'json')).not.toContain('\n');
    expect(formatSegments(segments, 'json', { jsonPretty: true })).toContain('\n  "segments"');
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

  it('formats segment patch stats as human table, csv, or json', () => {
    const stats = { edits: 2, splits: 1, merges: 1, deletes: 1, total: 5 };

    expect(formatSegmentPatchStats(stats, 'human')).toContain(
      'EDITS  SPLITS  MERGES  DELETES  TOTAL'
    );
    expect(formatSegmentPatchStats(stats, 'csv')).toBe(
      ['edits,splits,merges,deletes,total', '2,1,1,1,5'].join('\n')
    );
    expect(formatSegmentPatchStats(stats, 'json')).toBe(
      '{"stats":{"edits":2,"splits":1,"merges":1,"deletes":1,"total":5}}'
    );
    expect(formatSegmentPatchStats(stats, 'json', true)).toContain('\n  "stats"');
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

  it('applies ordered edit, split, merge, and delete operations atomically', () => {
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
        '[[operations]]',
        'op = "edit"',
        'segment_id = "delete-me"',
        'ja = "削除します"',
        '',
        '[[operations]]',
        'op = "split"',
        'source_id = "long"',
        '',
        '[[operations.replacements]]',
        'segment_id = "long.1"',
        'start = 0',
        'end = 2',
        'speaker = "A"',
        'ja = "前半"',
        '',
        '[[operations.replacements]]',
        'segment_id = "long.2"',
        'start = 2',
        'end = 4',
        'speaker = "A"',
        'ja = "後半"',
        '',
        '[[operations]]',
        'op = "merge"',
        'source_ids = ["2", "3"]',
        'merged_id = "2-3"',
        'speaker = "B,C"',
        'ja = "次続き"',
        '',
        '[[operations]]',
        'op = "delete"',
        'segment_id = "delete-me"'
      ].join('\n')
    );

    const result = applySegmentPatch(file, patch);

    expect(result).toEqual({
      edits: [{ id: 'delete-me', start: 6, end: 7, speaker: 'C', ja: '削除します' }],
      splits: [
        { id: 'long.1', start: 0, end: 1.96, speaker: 'A', ja: '前半' },
        { id: 'long.2', start: 2.04, end: 4, speaker: 'A', ja: '後半' }
      ],
      merges: [{ id: '2-3', start: 4, end: 6, speaker: 'B,C', ja: '次続き' }],
      deletes: [{ id: 'delete-me', start: 6, end: 7, speaker: 'C', ja: '削除します' }],
      affected: [
        { id: 'delete-me', start: 6, end: 7, speaker: 'C', ja: '削除します' },
        { id: 'long.1', start: 0, end: 1.96, speaker: 'A', ja: '前半' },
        { id: 'long.2', start: 2.04, end: 4, speaker: 'A', ja: '後半' },
        { id: '2-3', start: 4, end: 6, speaker: 'B,C', ja: '次続き' },
        { id: 'delete-me', start: 6, end: 7, speaker: 'C', ja: '削除します' }
      ]
    });
    expect(summarizeSegmentPatchResult(patch)).toEqual({
      edits: 1,
      splits: 1,
      merges: 1,
      deletes: 1,
      total: 4
    });
    expect(file.segments).toEqual([
      { id: 'long.1', start: 0, end: 1.96, speaker: 'A', ja: '前半' },
      { id: 'long.2', start: 2.04, end: 4, speaker: 'A', ja: '後半' },
      { id: '2-3', start: 4, end: 6, speaker: 'B,C', ja: '次続き' }
    ]);
  });

  it('applies ordered field edit operations', () => {
    const file = sampleTranslation();
    const patch = parseSegmentPatch(
      [
        '[[operations]]',
        'op = "edit"',
        'segment_id = "1"',
        'zh = "您好"',
        '',
        '[[operations]]',
        'op = "edit"',
        'segment_id = "2"',
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
      deletes: [],
      affected: [
        { id: '1', start: 0, end: 1.2, speaker: 'A', ja: 'こんにちは', zh: '您好' },
        { id: '2', start: 2.5, end: 3.5, speaker: 'C', ja: 'またね', zh: '回头见' }
      ]
    });
    expect(file.segments).toEqual([
      { id: '1', start: 0, end: 1.2, speaker: 'A', ja: 'こんにちは', zh: '您好' },
      { id: '2', start: 2.5, end: 3.5, speaker: 'C', ja: 'またね', zh: '回头见' }
    ]);
  });

  it('replaces and clears segment skip checks through edit patch operations', () => {
    const file = sampleTranslation();
    const patch = parseSegmentPatch(
      [
        '[[operations]]',
        'op = "edit"',
        'segment_id = "1"',
        '',
        '[[operations.skip_checks]]',
        'code = "zh_line_hard_limit"',
        'reason = "Official title should stay on one line."',
        '',
        '[[operations.skip_checks]]',
        'code = "zh_repeated_punctuation"',
        'reason = "Official title spelling."',
        '',
        '[[operations]]',
        'op = "edit"',
        'segment_id = "2"',
        'skip_checks = []'
      ].join('\n')
    );
    file.segments[1]!.skip_checks = [{ code: 'zh_line_hard_limit', reason: 'Stale exception.' }];

    applySegmentPatch(file, patch);

    expect(file.segments[0]?.skip_checks).toEqual([
      { code: 'zh_line_hard_limit', reason: 'Official title should stay on one line.' },
      { code: 'zh_repeated_punctuation', reason: 'Official title spelling.' }
    ]);
    expect(file.segments[1]).not.toHaveProperty('skip_checks');
  });

  it('applies patches without running full subtitle validation', () => {
    const file = sampleTranslation();

    expect(() =>
      applySegmentPatch(file, {
        operations: [{ op: 'edit', segment_id: '1', zh: '第一行\n第二行\n第三行' }]
      })
    ).not.toThrow();
    expect(file.segments[0]?.zh).toBe('第一行\n第二行\n第三行');
  });

  it('splits segments around a default midpoint gap', () => {
    const file = sampleTranscript();

    const segments = splitSegment(file, '1', {
      at: 0.6,
      id1: '1.1',
      id2: '1.2',
      ja1: 'こん',
      ja2: 'にちは'
    });

    expect(segments).toEqual([
      { id: '1.1', start: 0, end: 0.56, speaker: 'A', ja: 'こん' },
      { id: '1.2', start: 0.64, end: 1.2, speaker: 'A', ja: 'にちは' }
    ]);
    expect(validateSegments(file).some((issue) => issue.code === 'subtitle_gap_too_short')).toBe(
      false
    );
  });

  it('does not inherit skip checks when splitting or merging segments', () => {
    const splitFile: SegmentsFile = {
      ...sampleTranscript(),
      segments: [
        {
          id: '1',
          start: 0,
          end: 2,
          speaker: 'A',
          ja: '長いタイトルです',
          skip_checks: [{ code: 'ja_line_hard_limit', reason: 'Old exception.' }]
        }
      ]
    };

    expect(
      splitSegment(splitFile, '1', {
        at: 1,
        id1: '1.1',
        id2: '1.2',
        ja1: '前半',
        ja2: '後半'
      })
    ).toEqual([
      { id: '1.1', start: 0, end: 0.96, speaker: 'A', ja: '前半' },
      { id: '1.2', start: 1.04, end: 2, speaker: 'A', ja: '後半' }
    ]);

    const mergeFile: SegmentsFile = {
      ...sampleTranscript(),
      segments: [
        {
          id: '1',
          start: 0,
          end: 1,
          speaker: 'A',
          ja: '前半',
          skip_checks: [{ code: 'ja_line_hard_limit', reason: 'Old exception.' }]
        },
        { id: '2', start: 1.1, end: 2, speaker: 'A', ja: '後半' }
      ]
    };

    expect(mergeSegments(mergeFile, '1', '2', { id: '1-2', ja: '前半後半' })).toEqual({
      id: '1-2',
      start: 0,
      end: 2,
      speaker: 'A',
      ja: '前半後半'
    });
  });

  it('does not require zh when merging segments with only blank zh text', () => {
    const file: SegmentsFile = {
      ...sampleTranscript(),
      segments: [
        { id: '1', start: 0, end: 1, speaker: 'A', ja: '前半', zh: '' },
        { id: '2', start: 1.1, end: 2, speaker: 'A', ja: '後半', zh: '  ' }
      ]
    };

    expect(mergeSegments(file, '1', '2', { id: '1-2', ja: '前半後半' })).toEqual({
      id: '1-2',
      start: 0,
      end: 2,
      speaker: 'A',
      ja: '前半後半'
    });
  });

  it('rejects split gaps below the hard subtitle gap and too-short split results', () => {
    const file = sampleTranscript();

    expect(() =>
      splitSegment(file, '1', {
        at: 0.6,
        gap: 0.079,
        id1: '1.1',
        id2: '1.2',
        ja1: 'こん',
        ja2: 'にちは'
      })
    ).toThrow('must be at least 0.08 seconds');

    expect(() =>
      splitSegment(file, '1', {
        at: 0.5,
        id1: '1.1',
        id2: '1.2',
        ja1: 'こん',
        ja2: 'にちは'
      })
    ).toThrow('shorter than 0.5 seconds');
  });

  it('allows small floating point drift in split patch coverage', () => {
    const file: SegmentsFile = {
      ...sampleTranscript(),
      segments: [{ id: 'long', start: 10.123456, end: 12.654321, speaker: 'A', ja: '長い文' }]
    };

    expect(() =>
      applySegmentPatch(file, {
        operations: [
          {
            op: 'split',
            source_id: 'long',
            replacements: [
              {
                segment_id: 'long.1',
                start: 10.123956,
                end: 11.0004,
                speaker: 'A',
                ja: '前半'
              },
              {
                segment_id: 'long.2',
                start: 11.0009,
                end: 12.653821,
                speaker: 'A',
                ja: '後半'
              }
            ]
          }
        ]
      })
    ).not.toThrow();
  });

  it('applies midpoint gaps to continuous split patch boundaries', () => {
    const file: SegmentsFile = {
      ...sampleTranscript(),
      segments: [{ id: 'long', start: 0, end: 2.5, speaker: 'A', ja: '長い文です' }]
    };

    expect(
      applySegmentPatch(file, {
        operations: [
          {
            op: 'split',
            source_id: 'long',
            replacements: [
              { segment_id: 'long.1', start: 0, end: 1.2, speaker: 'A', ja: '前半' },
              { segment_id: 'long.2', start: 1.2, end: 2.5, speaker: 'A', ja: '後半' }
            ]
          }
        ]
      }).splits
    ).toEqual([
      { id: 'long.1', start: 0, end: 1.16, speaker: 'A', ja: '前半' },
      { id: 'long.2', start: 1.24, end: 2.5, speaker: 'A', ja: '後半' }
    ]);
    expect(validateSegments(file).some((issue) => issue.code === 'subtitle_gap_too_short')).toBe(
      false
    );
  });

  it('applies midpoint gaps at every split patch boundary', () => {
    const file: SegmentsFile = {
      ...sampleTranscript(),
      segments: [{ id: 'long', start: 0, end: 3, speaker: 'A', ja: '長い文です' }]
    };

    applySegmentPatch(file, {
      operations: [
        {
          op: 'split',
          source_id: 'long',
          replacements: [
            { segment_id: 'long.1', start: 0, end: 1, speaker: 'A', ja: '一' },
            { segment_id: 'long.2', start: 1, end: 2, speaker: 'A', ja: '二' },
            { segment_id: 'long.3', start: 2, end: 3, speaker: 'A', ja: '三' }
          ]
        }
      ]
    });

    expect(file.segments).toEqual([
      { id: 'long.1', start: 0, end: 0.96, speaker: 'A', ja: '一' },
      { id: 'long.2', start: 1.04, end: 1.96, speaker: 'A', ja: '二' },
      { id: 'long.3', start: 2.04, end: 3, speaker: 'A', ja: '三' }
    ]);
  });

  it('can merge and then split using an intermediate segment id', () => {
    const file: SegmentsFile = {
      ...sampleTranscript(),
      segments: [
        { id: '1', start: 0, end: 1, speaker: 'A', ja: '前の誤切り' },
        { id: '2', start: 1, end: 2.4, speaker: 'B', ja: '後の誤切り' }
      ]
    };
    const patch = parseSegmentPatch(
      [
        '[[operations]]',
        'op = "merge"',
        'source_ids = ["1", "2"]',
        'merged_id = "1-2"',
        'ja = "前の誤切り後の誤切り"',
        '',
        '[[operations]]',
        'op = "split"',
        'source_id = "1-2"',
        '',
        '[[operations.replacements]]',
        'segment_id = "1a"',
        'start = 0',
        'end = 1.2',
        'speaker = "A"',
        'ja = "正しい前半"',
        '',
        '[[operations.replacements]]',
        'segment_id = "2a"',
        'start = 1.2',
        'end = 2.4',
        'speaker = "B"',
        'ja = "正しい後半"'
      ].join('\n')
    );

    const result = applySegmentPatch(file, patch);

    expect(result.affected.map((segment) => segment.id)).toEqual(['1-2', '1a', '2a']);
    expect(file.segments).toEqual([
      { id: '1a', start: 0, end: 1.16, speaker: 'A', ja: '正しい前半' },
      { id: '2a', start: 1.24, end: 2.4, speaker: 'B', ja: '正しい後半' }
    ]);
  });

  it('does not require zh in merge patches when source zh text is blank', () => {
    const file: SegmentsFile = {
      ...sampleTranscript(),
      segments: [
        { id: '1', start: 0, end: 1, speaker: 'A', ja: '前半', zh: '' },
        { id: '2', start: 1, end: 2.4, speaker: 'B', ja: '後半', zh: '  ' }
      ]
    };

    applySegmentPatch(file, {
      operations: [
        {
          op: 'merge',
          source_ids: ['1', '2'],
          merged_id: '1-2',
          ja: '前半後半'
        }
      ]
    });

    expect(file.segments).toEqual([
      { id: '1-2', start: 0, end: 2.4, speaker: 'A,B', ja: '前半後半' }
    ]);
  });

  it('rejects invalid segment patches without changing the source file', () => {
    const file = sampleTranslation();

    expect(() => parseSegmentPatch('')).toThrow();
    expect(() =>
      parseSegmentPatch(['[[items]]', 'segment_id = "1"', 'zh = "您好"'].join('\n'))
    ).toThrow();

    expect(() =>
      applySegmentPatch(file, {
        operations: [
          { op: 'edit', segment_id: '1', zh: '您好' },
          { op: 'delete', segment_id: 'missing' }
        ]
      })
    ).toThrow('segment not found');
    expect(file).toEqual(sampleTranslation());

    expect(() =>
      applySegmentPatch(file, {
        operations: [
          {
            op: 'split',
            source_id: '1',
            replacements: [
              { segment_id: '1.1', start: 0, end: 0.6, speaker: 'A', ja: 'こん', zh: '你' },
              { segment_id: '2', start: 0.6, end: 1.2, speaker: 'A', ja: 'にちは', zh: '好' }
            ]
          }
        ]
      })
    ).toThrow('duplicate current segment id');
  });

  it('rejects invalid split and merge patches without changing the source file', () => {
    const file = sampleTranslation();

    expect(() =>
      applySegmentPatch(file, {
        operations: [
          {
            op: 'split',
            source_id: '1',
            replacements: [
              { segment_id: '1.1', start: 0, end: 0.5, speaker: 'A', ja: 'こん', zh: '你' },
              { segment_id: '1.2', start: 0.6, end: 1.2, speaker: 'A', ja: 'にちは', zh: '好' }
            ]
          }
        ]
      })
    ).toThrow('continuous');
    expect(file).toEqual(sampleTranslation());

    expect(() =>
      applySegmentPatch(file, {
        operations: [
          {
            op: 'split',
            source_id: '1',
            replacements: [
              { segment_id: '1.1', start: 0, end: 0.6, speaker: 'A', ja: 'こん' },
              { segment_id: '1.2', start: 0.6, end: 1.2, speaker: 'A', ja: 'にちは', zh: '好' }
            ]
          }
        ]
      })
    ).toThrow('requires zh');

    expect(() =>
      applySegmentPatch(file, {
        operations: [
          { op: 'merge', source_ids: ['1', 'missing'], merged_id: '1-3', ja: '結合', zh: '合并' }
        ]
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
        {
          operations: [
            { op: 'merge', source_ids: ['1', '2'], merged_id: '1-2', ja: '結合', zh: '合并' }
          ]
        }
      )
    ).toThrow('adjacent');

    expect(() =>
      applySegmentPatch(file, {
        operations: [{ op: 'merge', source_ids: ['1', '2'], merged_id: '1-2', ja: '結合' }]
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

  it('preserves and clears segment skip checks during direct edits', () => {
    const file = sampleTranslation();
    file.segments[0]!.skip_checks = [
      { code: 'zh_line_hard_limit', reason: 'Official title should stay on one line.' }
    ];

    editSegment(file, '1', { zh: '您好' });
    expect(file.segments[0]?.skip_checks).toEqual([
      { code: 'zh_line_hard_limit', reason: 'Official title should stay on one line.' }
    ]);

    editSegment(file, '1', { clearSkipChecks: true });
    expect(file.segments[0]).not.toHaveProperty('skip_checks');
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

  it('requires explicit session target and marks committed stages dirty after edits', async () => {
    const dir = await preparedCompleteSession();
    const context = await loadSegmentEditContext({ sessionTarget: dir, stage: 'translation' });
    editSegment(context.file, '1', { zh: '您好' });
    await persistSegmentEdit(context);

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
