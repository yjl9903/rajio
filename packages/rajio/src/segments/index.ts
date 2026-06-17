import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { parse, stringify } from 'smol-toml';

import {
  SKIPPABLE_ISSUE_CODES,
  type Segment,
  type SegmentSkipCheck,
  type SegmentsFile,
  type ValidationIssue
} from '../types.js';
import { writeFileAtomic } from '../utils/fs.js';
import {
  SEGMENT_DURATION_LIMITS as DURATION_LIMITS,
  SEGMENT_TIME_EPSILON as TIME_EPSILON,
  SUBTITLE_GAP_LIMITS as GAP_LIMITS
} from './limits.js';
import { countSubtitleTextUnits, stripSubtitleProtectedText } from './text.js';

export { countSubtitleTextUnits } from './text.js';

const VALIDATION_SUMMARY_CODE_LIMIT = 5;
const TRANSLATION_INHERITED_JAPANESE_QA_CODES = new Set([
  'ja_line_hard_limit',
  'ja_line_break_can_merge_soft',
  'ja_line_break_hard_limit',
  'ja_reading_speed_limit',
  'ja_punctuation_only_line',
  'ja_repeated_punctuation'
]);

export type ValidationProfile = 'default' | 'translation_work';

const TEXT_LIMITS = {
  ja: {
    label: 'Japanese',
    soft: 20,
    hard: 28,
    softLines: 1,
    hardLines: 2,
    readingSpeedSoft: 15,
    readingSpeedHard: 20,
    warningPunctuation: /[。、,.]/,
    terminalPunctuation: /[。．.,，、;；:：…]$/
  },
  zh: {
    label: 'Chinese',
    soft: 16,
    hard: 24,
    softLines: 1,
    hardLines: 2,
    readingSpeedSoft: 11,
    readingSpeedHard: 15,
    warningPunctuation: /[，,。.]/,
    terminalPunctuation: /[。．.,，、;；:：…]$/
  }
} as const;

const REPEATED_EMPHATIC_PUNCTUATION = /[?!？！]{2,}/;
const REPEATED_EMPHATIC_PUNCTUATION_HARD = /[?!？！]{3,}/;
const PUNCTUATION_ONLY_LINE = /^[\s\p{P}\p{S}]+$/u;
const TRAILING_CLOSERS = /[\s"'”’）)」』】》]+$/;

export const segmentSkipCheckSchema = z.object({
  code: z.enum(SKIPPABLE_ISSUE_CODES),
  reason: z.string().trim().min(1)
});

export const segmentSchema = z.object({
  id: z.string().min(1),
  start: z.number().nonnegative(),
  end: z.number().positive(),
  speaker: z.string().min(1),
  ja: z.string(),
  zh: z.string().optional(),
  notes: z.string().optional(),
  flags: z.array(z.string()).optional(),
  skip_checks: z.array(segmentSkipCheckSchema).optional()
});

export const segmentsFileSchema = z.object({
  version: z.literal(1),
  source: z.object({
    kind: z.union([z.literal('transcript'), z.literal('translation')]),
    generated_at: z.string()
  }),
  segments: z.array(segmentSchema)
});

export function parseSegments(value: unknown): SegmentsFile {
  return segmentsFileSchema.parse(value);
}

export function validateSegments(
  value: unknown,
  options: { requireZh?: boolean; strict?: boolean } = {}
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const parsed = segmentsFileSchema.safeParse(value);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push({
        level: 'fatal',
        code: 'schema',
        message: `${issue.path.join('.') || 'segments'}: ${issue.message}`
      });
    }
    return issues;
  }

  const ids = new Set<string>();
  let previous: Segment | undefined;
  const strict = options.strict ?? true;
  for (const segment of parsed.data.segments) {
    if (ids.has(segment.id)) {
      issues.push({
        level: 'fatal',
        code: 'duplicate_id',
        segmentId: segment.id,
        message: `Duplicate segment id: ${segment.id}`
      });
    }
    ids.add(segment.id);

    if (strict && segment.end <= segment.start) {
      issues.push({
        level: 'fatal',
        code: 'invalid_time',
        segmentId: segment.id,
        message: `Segment ${segment.id} end must be greater than start.`
      });
    }

    let hasInvalidTime = false;
    if (strict) {
      if (segment.end <= segment.start) {
        hasInvalidTime = true;
      }

      if (previous) {
        if (segment.start < previous.end - TIME_EPSILON) {
          issues.push({
            level: 'fatal',
            code: 'overlap',
            segmentId: segment.id,
            message: `Segment ${segment.id} overlaps previous segment ${previous.id}.`
          });
        } else {
          validateSubtitleGap(issues, previous, segment);
        }
      }
    }

    if (strict && !segment.ja.trim()) {
      issues.push({
        level: 'fatal',
        code: 'empty_ja',
        segmentId: segment.id,
        message: `Segment ${segment.id} has empty Japanese text.`
      });
    }

    if (options.requireZh && !segment.zh?.trim()) {
      issues.push({
        level: 'fatal',
        code: 'empty_zh',
        segmentId: segment.id,
        message: `Segment ${segment.id} has empty Chinese text.`
      });
    }

    if (strict) {
      validateTextLines(issues, segment, 'ja', segment.ja);
      validateTextLines(issues, segment, 'zh', segment.zh);
    }

    if (strict && !hasInvalidTime) {
      validateDuration(issues, segment);
      validateReadingSpeed(issues, segment, 'ja', segment.ja);
      validateReadingSpeed(issues, segment, 'zh', segment.zh);
    }

    previous = segment;
  }

  return applySegmentSkipChecks(issues, parsed.data.segments);
}

function applySegmentSkipChecks(issues: ValidationIssue[], segments: Segment[]): ValidationIssue[] {
  const skips = buildSkipCheckMap(segments);
  const matched = new Set<string>();
  const formatted: ValidationIssue[] = [];
  for (const issue of issues) {
    if (issue.level !== 'error' || !issue.segmentId) {
      formatted.push(issue);
      continue;
    }
    const key = skipCheckKey(issue.segmentId, issue.code);
    const skip = skips.get(key);
    if (!skip) {
      formatted.push(issue);
      continue;
    }
    matched.add(key);
  }

  for (const segment of segments) {
    for (const skip of segment.skip_checks ?? []) {
      const key = skipCheckKey(segment.id, skip.code);
      if (matched.has(key)) {
        continue;
      }
      formatted.push({
        level: 'fatal',
        code: 'unused_skip_check',
        segmentId: segment.id,
        message: `Segment ${segment.id} skip_checks entry for ${skip.code} does not match any generated issue. Remove the stale skip annotation.`
      });
    }
  }

  return formatted;
}

function buildSkipCheckMap(segments: Segment[]): Map<string, SegmentSkipCheck> {
  const skips = new Map<string, SegmentSkipCheck>();
  for (const segment of segments) {
    for (const skip of segment.skip_checks ?? []) {
      skips.set(skipCheckKey(segment.id, skip.code), skip);
    }
  }
  return skips;
}

function skipCheckKey(segmentId: string, code: string): string {
  return `${segmentId}\0${code}`;
}

export function assertValidSegments(
  value: unknown,
  options: { requireZh?: boolean; strict?: boolean } = {}
): SegmentsFile {
  const issues = validateSegments(value, {
    requireZh: options.requireZh,
    strict: options.strict
  });
  const errors = blockingValidationErrors(issues);
  if (errors.length > 0) {
    throw new Error(formatValidationErrorSummary(errors));
  }
  return parseSegments(value);
}

export function isTranslationInheritedJapaneseQaIssue(issue: ValidationIssue): boolean {
  return issue.level === 'error' && TRANSLATION_INHERITED_JAPANESE_QA_CODES.has(issue.code);
}

export function blockingValidationErrors(
  issues: ValidationIssue[],
  options: { profile?: ValidationProfile } = {}
): ValidationIssue[] {
  const errors = issues.filter((issue) => issue.level === 'fatal' || issue.level === 'error');
  return errors.filter((issue) => isBlockingValidationIssue(issue, options));
}

export function formatValidationIssueForProfile(
  issue: ValidationIssue,
  options: { profile?: ValidationProfile } = {}
): ValidationIssue {
  if (options.profile === 'translation_work' && isTranslationInheritedJapaneseQaIssue(issue)) {
    return {
      ...issue,
      level: 'warning',
      message: `translation inherited Japanese QA: ${issue.message}`
    };
  }
  return issue;
}

function isBlockingValidationIssue(
  issue: ValidationIssue,
  options: { profile?: ValidationProfile }
): boolean {
  if (issue.level === 'fatal') {
    return true;
  }
  if (options.profile === 'translation_work' && isTranslationInheritedJapaneseQaIssue(issue)) {
    return false;
  }
  return true;
}

export function formatValidationErrorSummary(
  errors: ValidationIssue[],
  label = 'segments'
): string {
  const issueLabel = errors.length === 1 ? 'issue' : 'issues';
  const codes = summarizeValidationCodes(errors);
  const codeText = codes.length > 0 ? ` (${codes.join(', ')})` : '';
  return `${label} has ${errors.length} blocking ${issueLabel}${codeText}.`;
}

function summarizeValidationCodes(issues: ValidationIssue[]): string[] {
  const counts = new Map<string, number>();
  for (const issue of issues) {
    counts.set(issue.code, (counts.get(issue.code) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort(([aCode, aCount], [bCode, bCount]) => bCount - aCount || aCode.localeCompare(bCode))
    .slice(0, VALIDATION_SUMMARY_CODE_LIMIT)
    .map(([code, count]) => `${code}: ${count}`);
}

export async function readSegmentsFile(filePath: string): Promise<SegmentsFile> {
  return parseSegments(parse(await readFile(filePath, 'utf8')));
}

export async function writeSegmentsFile(
  filePath: string,
  value: SegmentsFile,
  options: { requireZh?: boolean; strict?: boolean; validate?: boolean } = {}
): Promise<void> {
  if (options.validate !== false) {
    assertValidSegments(value, {
      requireZh: options.requireZh ?? false,
      strict: options.strict
    });
  }
  await writeFileAtomic(filePath, stringify(value));
}

export function cloneForTranslation(source: SegmentsFile, generatedAt: string): SegmentsFile {
  return {
    version: 1,
    source: {
      ...source.source,
      kind: 'translation',
      generated_at: generatedAt
    },
    segments: source.segments.map(withoutSkipChecks)
  };
}

function withoutSkipChecks(segment: Segment): Segment {
  const next = { ...segment };
  delete next.skip_checks;
  return next;
}

export function normalizeTranscriptWorkSegments(source: SegmentsFile): SegmentsFile {
  const segments = source.segments
    .map((segment) => ({
      ...segment,
      ja: segment.ja.trim()
    }))
    .filter((segment) => segment.ja);

  return {
    ...source,
    segments
  };
}

function hasValidDuration(segment: Segment): boolean {
  return segment.end > segment.start;
}

function validateTextLines(
  issues: ValidationIssue[],
  segment: Segment,
  language: keyof typeof TEXT_LIMITS,
  value: string | undefined
): void {
  if (!value) {
    return;
  }

  const limits = TEXT_LIMITS[language];
  const lines = value.split(/\r?\n/);
  if (lines.length > limits.hardLines) {
    issues.push({
      level: 'error',
      code: `${language}_line_break_hard_limit`,
      segmentId: segment.id,
      message: `Segment ${segment.id} ${limits.label} text has ${lines.length} lines; hard limit is ${limits.hardLines}. Split into multiple segments.`
    });
  } else if (lines.length === 2) {
    const mergedLength = countSubtitleTextUnits(`${lines[0]!.trim()} ${lines[1]!.trim()}`);
    if (mergedLength <= limits.soft) {
      issues.push({
        level: 'error',
        code: `${language}_line_break_can_merge_soft`,
        segmentId: segment.id,
        message: `Segment ${segment.id} ${limits.label} text has 2 lines but merges to ${mergedLength} chars; soft limit is ${limits.soft}. Use one line.`
      });
    } else if (mergedLength <= limits.hard) {
      issues.push({
        level: 'warning',
        code: `${language}_line_break_can_merge_hard`,
        segmentId: segment.id,
        message: `Segment ${segment.id} ${limits.label} text has 2 lines but merges to ${mergedLength} chars; hard limit is ${limits.hard}. Prefer one line.`
      });
    } else {
      issues.push({
        level: 'warning',
        code: `${language}_line_break_soft_limit`,
        segmentId: segment.id,
        message: `Segment ${segment.id} ${limits.label} text has ${lines.length} lines; prefer one line or split into multiple segments.`
      });
    }
  } else if (lines.length > limits.softLines) {
    issues.push({
      level: 'warning',
      code: `${language}_line_break_soft_limit`,
      segmentId: segment.id,
      message: `Segment ${segment.id} ${limits.label} text has ${lines.length} lines; prefer one line or split into multiple segments.`
    });
  }

  for (const [lineIndex, line] of lines.entries()) {
    const lineNumber = lineIndex + 1;
    const compactLength = countSubtitleTextUnits(line);
    if (compactLength > limits.hard) {
      issues.push({
        level: 'error',
        code: `${language}_line_hard_limit`,
        segmentId: segment.id,
        message: `Segment ${segment.id} ${limits.label} line ${lineNumber} has ${compactLength} chars; hard limit is ${limits.hard}.`
      });
    } else if (compactLength > limits.soft) {
      issues.push({
        level: 'warning',
        code: `${language}_line_soft_limit`,
        segmentId: segment.id,
        message: `Segment ${segment.id} ${limits.label} line ${lineNumber} has ${compactLength} chars; soft limit is ${limits.soft}.`
      });
    }

    const punctuationLine = stripSubtitleProtectedText(line);
    if (punctuationLine.trim() && PUNCTUATION_ONLY_LINE.test(punctuationLine)) {
      issues.push({
        level: 'error',
        code: `${language}_punctuation_only_line`,
        segmentId: segment.id,
        message: `Segment ${segment.id} ${limits.label} line ${lineNumber} contains only punctuation.`
      });
    }

    const repeatedPunctuation = punctuationLine.match(REPEATED_EMPHATIC_PUNCTUATION);
    if (repeatedPunctuation) {
      const hard = REPEATED_EMPHATIC_PUNCTUATION_HARD.test(repeatedPunctuation[0]);
      issues.push({
        level: hard ? 'error' : 'warning',
        code: `${language}_repeated_punctuation`,
        segmentId: segment.id,
        message: `Segment ${segment.id} ${limits.label} line ${lineNumber} uses repeated question/exclamation punctuation: ${repeatedPunctuation[0]}.`
      });
    }

    if (limits.warningPunctuation.test(punctuationLine)) {
      issues.push({
        level: 'warning',
        code: `${language}_common_punctuation`,
        segmentId: segment.id,
        message: `Segment ${segment.id} ${limits.label} line ${lineNumber} uses ordinary comma/period punctuation; prefer a space, rewrite, or split the subtitle.`
      });
    }

    if (limits.terminalPunctuation.test(punctuationLine.trim().replace(TRAILING_CLOSERS, ''))) {
      issues.push({
        level: 'warning',
        code: `${language}_terminal_punctuation`,
        segmentId: segment.id,
        message: `Segment ${segment.id} ${limits.label} line ${lineNumber} ends with ordinary punctuation; subtitle lines should omit ordinary sentence-ending punctuation.`
      });
    }
  }
}

function validateDuration(issues: ValidationIssue[], segment: Segment): void {
  const duration = segment.end - segment.start;
  if (duration < DURATION_LIMITS.shortHard) {
    issues.push({
      level: 'error',
      code: 'duration_too_short',
      segmentId: segment.id,
      message: `Segment ${segment.id} lasts ${formatSeconds(duration)} seconds; hard minimum is ${formatSeconds(DURATION_LIMITS.shortHard)} seconds.`
    });
  } else if (duration < DURATION_LIMITS.shortSoft) {
    issues.push({
      level: 'warning',
      code: 'duration_too_short',
      segmentId: segment.id,
      message: `Segment ${segment.id} lasts ${formatSeconds(duration)} seconds; soft minimum is ${formatSeconds(DURATION_LIMITS.shortSoft)} seconds.`
    });
  }

  if (duration > DURATION_LIMITS.longHard) {
    issues.push({
      level: 'error',
      code: 'duration_too_long',
      segmentId: segment.id,
      message: `Segment ${segment.id} lasts ${formatSeconds(duration)} seconds; hard maximum is ${formatSeconds(DURATION_LIMITS.longHard)} seconds.`
    });
  } else if (duration > DURATION_LIMITS.longSoft) {
    issues.push({
      level: 'warning',
      code: 'duration_too_long',
      segmentId: segment.id,
      message: `Segment ${segment.id} lasts ${formatSeconds(duration)} seconds; soft maximum is ${formatSeconds(DURATION_LIMITS.longSoft)} seconds.`
    });
  }
}

function validateReadingSpeed(
  issues: ValidationIssue[],
  segment: Segment,
  language: keyof typeof TEXT_LIMITS,
  value: string | undefined
): void {
  if (!value) {
    return;
  }

  const duration = segment.end - segment.start;
  if (duration <= 0) {
    return;
  }

  const limits = TEXT_LIMITS[language];
  const chars = countSubtitleTextUnits(value);
  const charsPerSecond = chars / duration;
  if (charsPerSecond > limits.readingSpeedHard) {
    issues.push({
      level: 'error',
      code: `${language}_reading_speed_limit`,
      segmentId: segment.id,
      message: `Segment ${segment.id} ${limits.label} reading speed is ${formatRate(charsPerSecond)} chars/s (${chars} chars over ${formatSeconds(duration)} seconds); hard limit is ${limits.readingSpeedHard} chars/s.`
    });
  } else if (charsPerSecond > limits.readingSpeedSoft) {
    issues.push({
      level: 'warning',
      code: `${language}_reading_speed_limit`,
      segmentId: segment.id,
      message: `Segment ${segment.id} ${limits.label} reading speed is ${formatRate(charsPerSecond)} chars/s (${chars} chars over ${formatSeconds(duration)} seconds); soft limit is ${limits.readingSpeedSoft} chars/s.`
    });
  }
}

function validateSubtitleGap(issues: ValidationIssue[], previous: Segment, segment: Segment): void {
  const gap = segment.start - previous.end;
  if (gap < GAP_LIMITS.hard - TIME_EPSILON) {
    issues.push({
      level: 'error',
      code: 'subtitle_gap_too_short',
      segmentId: segment.id,
      message: `Segment ${segment.id} starts ${formatSeconds(gap)} seconds after previous segment ${previous.id}; hard minimum gap is ${formatSeconds(GAP_LIMITS.hard)} seconds.`
    });
  } else if (gap < GAP_LIMITS.soft - TIME_EPSILON) {
    issues.push({
      level: 'warning',
      code: 'subtitle_gap_short',
      segmentId: segment.id,
      message: `Segment ${segment.id} starts ${formatSeconds(gap)} seconds after previous segment ${previous.id}; soft minimum gap is ${formatSeconds(GAP_LIMITS.soft)} seconds.`
    });
  }
}

function formatSeconds(value: number): string {
  return Number(value.toFixed(3)).toString();
}

function formatRate(value: number): string {
  return Number(value.toFixed(2)).toString();
}
