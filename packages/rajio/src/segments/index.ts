import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { parse, stringify } from 'smol-toml';

import type { Segment, SegmentsFile, ValidationIssue } from '../types.js';
import { writeFileAtomic } from '../utils/fs.js';

const TRANSCRIPT_PRECUT = {
  targetChars: 28,
  hardChars: 40,
  minChars: 10
} as const;

const TEXT_LIMITS = {
  ja: { label: 'Japanese', soft: 28, hard: 40, softLines: 1, hardLines: 2 },
  zh: { label: 'Chinese', soft: 24, hard: 34, softLines: 1, hardLines: 2 }
} as const;

const TIME_EPSILON = 1e-3;

const COMMA_PUNCTUATION = /[,，、]/;
const TERMINAL_PUNCTUATION = /[。．.!！?？;；:：,，、…]$/;
const TRAILING_CLOSERS = /[\s"'”’）)」』】》]+$/;

export const segmentSchema = z.object({
  id: z.string().min(1),
  start: z.number().finite().nonnegative(),
  end: z.number().finite().positive(),
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
        level: 'error',
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
        level: 'error',
        code: 'duplicate_id',
        segmentId: segment.id,
        message: `Duplicate segment id: ${segment.id}`
      });
    }
    ids.add(segment.id);

    if (strict && segment.end <= segment.start) {
      issues.push({
        level: 'error',
        code: 'invalid_time',
        segmentId: segment.id,
        message: `Segment ${segment.id} end must be greater than start.`
      });
    }

    if (strict && previous && segment.start < previous.end - TIME_EPSILON) {
      issues.push({
        level: 'error',
        code: 'overlap',
        segmentId: segment.id,
        message: `Segment ${segment.id} overlaps previous segment ${previous.id}.`
      });
    }

    if (strict && !segment.ja.trim()) {
      issues.push({
        level: 'error',
        code: 'empty_ja',
        segmentId: segment.id,
        message: `Segment ${segment.id} has empty Japanese text.`
      });
    }

    if (options.requireZh && !segment.zh?.trim()) {
      issues.push({
        level: 'error',
        code: 'empty_zh',
        segmentId: segment.id,
        message: `Segment ${segment.id} has empty Chinese text.`
      });
    }

    if (strict) {
      validateTextLines(issues, segment, 'ja', segment.ja);
      validateTextLines(issues, segment, 'zh', segment.zh);
    }

    if (strict && segment.end - segment.start > 7) {
      issues.push({
        level: 'warning',
        code: 'duration_too_long',
        segmentId: segment.id,
        message: `Segment ${segment.id} lasts longer than 7 seconds.`
      });
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
  const errors = issues.filter((issue) => issue.level === 'error');
  if (errors.length > 0) {
    throw new Error(errors.map((issue) => issue.message).join('\n'));
  }
  return parseSegments(value);
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

export function precutTranscriptSegments(source: SegmentsFile): SegmentsFile {
  return {
    ...source,
    segments: source.segments.flatMap((segment) => precutTranscriptSegment(segment))
  };
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

function precutTranscriptSegment(segment: Segment): Segment[] {
  const parts = splitJapaneseText(segment.ja);
  if (parts.length <= 1) {
    return [segment];
  }

  const totalWeight = parts.reduce((sum, part) => sum + textWeight(part), 0);
  const duration = segment.end - segment.start;
  let cursor = segment.start;

  return parts.map((part, index) => {
    const start = cursor;
    const end =
      index === parts.length - 1
        ? segment.end
        : start + duration * (textWeight(part) / totalWeight);
    cursor = end;
    return {
      ...segment,
      id: `${segment.id}.${index + 1}`,
      start,
      end,
      ja: part
    };
  });
}

function splitJapaneseText(text: string): string[] {
  const compactLength = textWeight(text);
  if (compactLength <= TRANSCRIPT_PRECUT.hardChars) {
    return [text];
  }

  const parts: string[] = [];
  let rest = text.trim();
  while (textWeight(rest) > TRANSCRIPT_PRECUT.hardChars) {
    const index = chooseSplitIndex(rest);
    if (index === undefined) {
      return [text];
    }
    parts.push(rest.slice(0, index).trim());
    rest = rest.slice(index).trim();
  }
  if (rest) {
    parts.push(rest);
  }
  return parts.filter(Boolean);
}

function chooseSplitIndex(text: string): number | undefined {
  const hardIndex = charIndexToStringIndex(text, TRANSCRIPT_PRECUT.hardChars);
  const targetIndex = Math.min(
    charIndexToStringIndex(text, TRANSCRIPT_PRECUT.targetChars),
    hardIndex
  );
  const minIndex = charIndexToStringIndex(text, TRANSCRIPT_PRECUT.minChars);
  return findBestBoundary(text, minIndex, hardIndex, targetIndex);
}

function findBestBoundary(
  text: string,
  minIndex: number,
  maxIndex: number,
  targetIndex: number
): number | undefined {
  const boundaryPatterns = [
    /[。．.!！?？;；:：、，,…]\s*/g,
    /(けれども|けれど|けども|ですが|ですけど|なので|ので|から|なら|とか|って|たり)\s*/g,
    /[ \t]+/g,
    /\r?\n+/g
  ];
  let best: { index: number; distance: number } | undefined;
  for (const pattern of boundaryPatterns) {
    for (const match of text.matchAll(pattern)) {
      const index = (match.index ?? 0) + match[0].length;
      if (index < minIndex || index > maxIndex) {
        continue;
      }
      const distance = Math.abs(index - targetIndex);
      if (!best || distance < best.distance) {
        best = { index, distance };
      }
    }
    if (best) {
      return best.index;
    }
  }
  return undefined;
}

function charIndexToStringIndex(text: string, charIndex: number): number {
  return Array.from(text).slice(0, charIndex).join('').length;
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

    if (COMMA_PUNCTUATION.test(line)) {
      issues.push({
        level: 'warning',
        code: `${language}_comma_punctuation`,
        segmentId: segment.id,
        message: `Segment ${segment.id} ${limits.label} line ${lineNumber} uses comma punctuation; prefer a space or split the subtitle.`
      });
    }

    if (TERMINAL_PUNCTUATION.test(line.trim().replace(TRAILING_CLOSERS, ''))) {
      issues.push({
        level: 'warning',
        code: `${language}_terminal_punctuation`,
        segmentId: segment.id,
        message: `Segment ${segment.id} ${limits.label} line ${lineNumber} ends with punctuation; subtitle lines should omit sentence-ending punctuation.`
      });
    }
  }
}
