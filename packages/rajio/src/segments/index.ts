import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { parse, stringify } from 'smol-toml';

import type { Segment, SegmentsFile, ValidationIssue } from '../types.js';
import { writeFileAtomic } from '../utils/fs.js';
import {
  SEGMENT_DURATION_LIMITS as DURATION_LIMITS,
  SEGMENT_TIME_EPSILON as TIME_EPSILON,
  SUBTITLE_GAP_LIMITS as GAP_LIMITS
} from './limits.js';

const VALIDATION_SUMMARY_CODE_LIMIT = 5;
const FORCE_COMMITTABLE_VALIDATION_CODES = new Set([
  'ja_line_hard_limit',
  'zh_line_hard_limit',
  'ja_line_break_hard_limit',
  'zh_line_break_hard_limit',
  'duration_too_short',
  'duration_too_long',
  'ja_reading_speed_limit',
  'zh_reading_speed_limit',
  'subtitle_gap_too_short',
  'ja_punctuation_only_line',
  'zh_punctuation_only_line',
  'ja_repeated_punctuation',
  'zh_repeated_punctuation'
]);
const TRANSLATION_INHERITED_JAPANESE_QA_CODES = new Set([
  'ja_line_hard_limit',
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
    readingSpeedSoft: 6,
    readingSpeedHard: 9,
    warningPunctuation: /[。、,.]/,
    terminalPunctuation: /[。．.,，、;；:：…]$/
  },
  zh: {
    label: 'Chinese',
    soft: 16,
    hard: 24,
    softLines: 1,
    hardLines: 2,
    readingSpeedSoft: 9,
    readingSpeedHard: 12,
    warningPunctuation: /[，,。.]/,
    terminalPunctuation: /[。．.,，、;；:：…]$/
  }
} as const;

const REPEATED_EMPHATIC_PUNCTUATION = /[?!？！]{2,}/;
const REPEATED_EMPHATIC_PUNCTUATION_HARD = /[?!？！]{3,}/;
const PUNCTUATION_ONLY_LINE = /^[\s\p{P}\p{S}]+$/u;
const TRAILING_CLOSERS = /[\s"'”’）)」』】》]+$/;

export const segmentSchema = z.object({
  id: z.string().min(1),
  start: z.number().nonnegative(),
  end: z.number().positive(),
  speaker: z.string().min(1),
  ja: z.string(),
  zh: z.string().optional(),
  notes: z.string().optional(),
  flags: z.array(z.string()).optional()
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

  return issues;
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

export function isForceCommittableValidationIssue(issue: ValidationIssue): boolean {
  return issue.level === 'error' && FORCE_COMMITTABLE_VALIDATION_CODES.has(issue.code);
}

export function isTranslationInheritedJapaneseQaIssue(issue: ValidationIssue): boolean {
  return issue.level === 'error' && TRANSLATION_INHERITED_JAPANESE_QA_CODES.has(issue.code);
}

export function blockingValidationErrors(
  issues: ValidationIssue[],
  options: { forceCommit?: boolean; profile?: ValidationProfile } = {}
): ValidationIssue[] {
  const errors = issues.filter((issue) => issue.level === 'fatal' || issue.level === 'error');
  return errors.filter((issue) => isBlockingValidationIssue(issue, options));
}

export function formatValidationIssueForProfile(
  issue: ValidationIssue,
  options: { forceCommit?: boolean; profile?: ValidationProfile } = {}
): ValidationIssue {
  if (options.profile === 'translation_work' && isTranslationInheritedJapaneseQaIssue(issue)) {
    return {
      ...issue,
      level: 'warning',
      message: `translation inherited Japanese QA: ${issue.message}`
    };
  }
  if (options.forceCommit && isForceCommittableValidationIssue(issue)) {
    return {
      ...issue,
      level: 'warning',
      message: `force-committed exception: ${issue.message}`
    };
  }
  return issue;
}

function isBlockingValidationIssue(
  issue: ValidationIssue,
  options: { forceCommit?: boolean; profile?: ValidationProfile }
): boolean {
  if (issue.level === 'fatal') {
    return true;
  }
  if (options.profile === 'translation_work' && isTranslationInheritedJapaneseQaIssue(issue)) {
    return false;
  }
  return !(options.forceCommit && isForceCommittableValidationIssue(issue));
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
    segments: source.segments.map((segment) => ({ ...segment }))
  };
}

export function normalizeTranscriptWorkGaps(source: SegmentsFile): SegmentsFile {
  const segments = source.segments.map((segment) => ({ ...segment }));

  for (let index = 1; index < segments.length; index += 1) {
    const previous = segments[index - 1]!;
    const segment = segments[index]!;
    if (!hasValidDuration(previous) || !hasValidDuration(segment)) {
      continue;
    }

    const gap = segment.start - previous.end;
    if (gap >= GAP_LIMITS.hard - TIME_EPSILON || gap < -TIME_EPSILON) {
      continue;
    }

    const midpoint = (previous.end + segment.start) / 2;
    const previousEnd = roundSegmentTime(midpoint - GAP_LIMITS.hard / 2);
    const segmentStart = roundSegmentTime(midpoint + GAP_LIMITS.hard / 2);
    if (
      previousEnd - previous.start < DURATION_LIMITS.shortHard - TIME_EPSILON ||
      segment.end - segmentStart < DURATION_LIMITS.shortHard - TIME_EPSILON
    ) {
      continue;
    }
    previous.end = previousEnd;
    segment.start = segmentStart;
  }

  return {
    ...source,
    segments
  };
}

function hasValidDuration(segment: Segment): boolean {
  return segment.end > segment.start;
}

function textWeight(value: string): number {
  return Array.from(stripSpaces(value)).length;
}

function stripSpaces(value: string): string {
  return value.replace(/\s/g, '');
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
    const compactLength = Array.from(stripSpaces(line)).length;
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

    if (PUNCTUATION_ONLY_LINE.test(line)) {
      issues.push({
        level: 'error',
        code: `${language}_punctuation_only_line`,
        segmentId: segment.id,
        message: `Segment ${segment.id} ${limits.label} line ${lineNumber} contains only punctuation.`
      });
    }

    const repeatedPunctuation = line.match(REPEATED_EMPHATIC_PUNCTUATION);
    if (repeatedPunctuation) {
      const hard = REPEATED_EMPHATIC_PUNCTUATION_HARD.test(repeatedPunctuation[0]);
      issues.push({
        level: hard ? 'error' : 'warning',
        code: `${language}_repeated_punctuation`,
        segmentId: segment.id,
        message: `Segment ${segment.id} ${limits.label} line ${lineNumber} uses repeated question/exclamation punctuation: ${repeatedPunctuation[0]}.`
      });
    }

    if (limits.warningPunctuation.test(line)) {
      issues.push({
        level: 'warning',
        code: `${language}_common_punctuation`,
        segmentId: segment.id,
        message: `Segment ${segment.id} ${limits.label} line ${lineNumber} uses ordinary comma/period punctuation; prefer a space, rewrite, or split the subtitle.`
      });
    }

    if (limits.terminalPunctuation.test(line.trim().replace(TRAILING_CLOSERS, ''))) {
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
  const chars = textWeight(value);
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

function roundSegmentTime(value: number): number {
  return Number(value.toFixed(6));
}
