import { describe, expect, it } from 'vitest';

import type { SegmentsFile } from '../src/types.js';
import { blockingValidationErrors, validateSegments } from '../src/segments/index.js';
import { sanitizeFileStem } from '../src/utils/fs.js';
import { renderAss, renderSrt } from '../src/workflow/subtitles.js';

function subtitles(ja: string, zh = '示例'): SegmentsFile {
  return {
    version: 1,
    source: { kind: 'translation', generated_at: '2026-10-08T00:00:00.000Z' },
    segments: [{ id: 's1', start: 0, end: 3, speaker: 'speaker_0', ja, zh }]
  };
}

describe('subtitle export', () => {
  it('uses the same newline forms for validation, SRT, and ASS', () => {
    for (const newline of ['\n', '\r\n', '\r']) {
      const file = subtitles(['一', '二', '三'].join(newline), ['甲', '乙', '丙'].join(newline));
      const issues = validateSegments(file, { requireZh: true });

      expect(issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'ja_line_break_hard_limit', level: 'error' }),
          expect.objectContaining({ code: 'zh_line_break_hard_limit', level: 'error' })
        ])
      );
      expect(blockingValidationErrors(issues, { profile: 'translation_work' })).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'zh_line_break_hard_limit' })])
      );
      expect(renderSrt(file, 'ja')).toContain('一\n二\n三\n');
      expect(renderSrt(file, 'zh')).toContain('甲\n乙\n丙\n');
      expect(renderAss(file, 'Title')).toContain('一\\N二\\N三\\N甲\\N乙\\N丙\n');
    }
  });

  it('blocks NUL characters in either subtitle language before export', () => {
    for (const file of [subtitles('前\0後'), subtitles('こんにちは', '前\0后')]) {
      const issues = validateSegments(file, { requireZh: true });

      expect(blockingValidationErrors(issues, { profile: 'translation_work' })).toEqual([
        expect.objectContaining({
          level: 'fatal',
          code: 'schema',
          message: expect.stringContaining('NUL')
        })
      ]);
    }
  });

  it('keeps multilingual filenames within the byte limit including temporary suffixes', () => {
    for (const title of ['春'.repeat(90), '春'.repeat(39) + '🌸'.repeat(30), 'A'.repeat(200)]) {
      const stem = sanitizeFileStem(title);

      expect(Buffer.byteLength(stem, 'utf8')).toBeLessThanOrEqual(120);
      expect(stem.length).toBeGreaterThan(0);
      expect(stem.isWellFormed()).toBe(true);
      expect(title.startsWith(stem)).toBe(true);
      for (const extension of ['.ja.srt', '.zh.srt', '.ja-zh.ass']) {
        expect(
          Buffer.byteLength(`.${stem}${extension}.${process.pid}.tmp`, 'utf8')
        ).toBeLessThanOrEqual(255);
      }
    }
    expect(sanitizeFileStem('春日さくら')).toBe('春日さくら');
    expect(sanitizeFileStem('  ')).toBe('subtitle');
  });

  it('defines the canvas used by the font size and margins', () => {
    const ass = renderAss(subtitles('こんにちは'), 'Title');

    expect(ass).toContain('PlayResX: 1920\nPlayResY: 1080\n');
    expect(ass).toContain('Style: Default,Arial,42,');
    expect(ass).toContain(',2,40,40,32,1\n');
  });

  it('preserves braces and prevents literal override tags from hiding or styling text', () => {
    const ass = renderAss(subtitles('集合{A} {{B}} }', String.raw`文字{\b1}普通`), 'Title');

    expect(ass).toContain(
      'Dialogue: 0,0:00:00.00,0:00:03.00,Default,,0,0,0,,集合\\{{}A} \\{{}\\{{}B}} }' +
        '\\N文字\\{{}\\\u2060b1}普通\n'
    );
  });

  it('keeps literal backslash sequences separate from ASS control characters', () => {
    const ass = renderAss(
      subtitles(String.raw`C:\new\hello \N \\`, String.raw`\n \h \{x\}`),
      'Title'
    );

    expect(ass).toContain(
      'C:\\\u2060new\\\u2060hello \\\u2060N \\\u2060\\\u2060' +
        '\\N\\\u2060n \\\u2060h \\\u2060\\{{}x\\\u2060}\n'
    );
  });

  it('does not duplicate an existing word joiner after a backslash', () => {
    const ass = renderAss(subtitles('a\\\u2060Nb'), 'Title');

    expect(ass).toContain('a\\\u2060Nb\\N示例\n');
    expect(ass).not.toContain('\u2060\u2060');
  });

  it('converts actual newlines without escaping the generated bilingual separator', () => {
    const ass = renderAss(subtitles('一\r\n二\n三\r四\\', '甲\n乙'), 'Title');

    expect(ass).toContain('一\\N二\\N三\\N四\\\u2060\\N甲\\N乙\n');
    expect(ass.split('\n').filter((line) => line.startsWith('Dialogue:'))).toHaveLength(1);
    expect(ass).not.toContain('\r');
  });

  it('keeps header text literal and prevents titles from adding script header lines', () => {
    const ass = renderAss(
      subtitles('こんにちは'),
      '集合{A} C:\\new\r\nPlayResX: 1\rTitle: Other\nEnd'
    );

    expect(ass).toContain('Title: 集合{A} C:\\new PlayResX: 1 Title: Other End\n');
    expect(ass.match(/^PlayResX:/gm)).toHaveLength(1);
    expect(ass).not.toContain('\r');
  });
});
