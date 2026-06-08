import type { Segment } from '../types.js';

export const SEGMENT_ISSUE_FILTERS = [
  'invalid-time',
  'overlap',
  'long',
  'fragment',
  'empty-zh'
] as const;

export type SegmentIssueFilter = (typeof SEGMENT_ISSUE_FILTERS)[number];

export interface SegmentListOptions {
  id?: string;
  offset?: number;
  limit?: number;
  start?: number;
  end?: number;
  around?: number;
  issues?: SegmentIssueFilter[];
}

export function listSegments(segments: Segment[], options: SegmentListOptions): Segment[] {
  const mode = resolveListMode(options);
  if (mode === 'id') {
    if (options.around !== undefined) {
      validateAroundOptions(options);
      return listAroundId(segments, options.id!, options.around);
    }
    const byId = new Map(segments.map((segment) => [segment.id, segment]));
    const segment = byId.get(options.id!);
    if (!segment) {
      throw new Error(`segment not found: ${options.id}`);
    }
    return [segment];
  }

  if (mode === 'range') {
    const offset = options.offset ?? 0;
    const limit = options.limit ?? Number.POSITIVE_INFINITY;
    return segments.slice(offset, Number.isFinite(limit) ? offset + limit : undefined);
  }

  if (mode === 'time') {
    const start = options.start!;
    const end = options.end!;
    return segments.filter((segment) => segment.start >= start && segment.start < end);
  }

  if (mode === 'issues') {
    const filters = new Set(options.issues);
    return segments.filter((segment, index) =>
      hasRequestedIssue(segments, segment, index, filters)
    );
  }

  return segments;
}

function resolveListMode(options: SegmentListOptions): 'all' | 'id' | 'range' | 'time' | 'issues' {
  const hasId = options.id !== undefined;
  const hasRange = options.offset !== undefined || options.limit !== undefined;
  const hasTime = options.start !== undefined || options.end !== undefined;
  const hasIssues = options.issues !== undefined && options.issues.length > 0;
  const modeCount = [hasId, hasRange, hasTime, hasIssues].filter(Boolean).length;
  if (modeCount > 1) {
    throw new Error('--id, --offset/--limit, --start/--end, and --issues are mutually exclusive.');
  }
  if (!hasId && options.around !== undefined) {
    throw new Error('--around requires --id.');
  }

  if (hasId) {
    return 'id';
  }
  if (hasRange) {
    validateRangeOptions(options);
    return 'range';
  }
  if (hasTime) {
    validateTimeOptions(options);
    return 'time';
  }
  if (hasIssues) {
    return 'issues';
  }
  return 'all';
}

function listAroundId(segments: Segment[], id: string, around: number): Segment[] {
  const index = segments.findIndex((segment) => segment.id === id);
  if (index === -1) {
    throw new Error(`segment not found: ${id}`);
  }
  return segments.slice(Math.max(0, index - around), index + around + 1);
}

function validateAroundOptions(options: SegmentListOptions): void {
  if (!isNonnegativeInteger(options.around!)) {
    throw new Error('--around must be a non-negative integer.');
  }
}

function validateRangeOptions(options: SegmentListOptions): void {
  if (options.offset !== undefined && !isNonnegativeInteger(options.offset)) {
    throw new Error('--offset must be a non-negative integer.');
  }
  if (options.limit !== undefined && !isNonnegativeInteger(options.limit)) {
    throw new Error('--limit must be a non-negative integer.');
  }
}

function validateTimeOptions(options: SegmentListOptions): void {
  if (options.start === undefined || options.end === undefined) {
    throw new Error('--start and --end must be provided together.');
  }
  if (!Number.isFinite(options.start) || !Number.isFinite(options.end)) {
    throw new Error('--start and --end must be finite numbers.');
  }
  if (options.end < options.start) {
    throw new Error('--end must be greater than or equal to --start.');
  }
}

function isNonnegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function hasRequestedIssue(
  segments: Segment[],
  segment: Segment,
  index: number,
  filters: Set<SegmentIssueFilter>
): boolean {
  return (
    (filters.has('invalid-time') && segment.end <= segment.start) ||
    (filters.has('overlap') && index > 0 && segment.start < segments[index - 1]!.end) ||
    (filters.has('long') && isLongSegment(segment)) ||
    (filters.has('fragment') && isFragmentSegment(segment)) ||
    (filters.has('empty-zh') && isEmptyZhSegment(segment))
  );
}

function isLongSegment(segment: Segment): boolean {
  return (
    segment.end - segment.start > 7 ||
    hasLongLine(segment.ja, 20) ||
    (segment.zh !== undefined && hasLongLine(segment.zh, 24))
  );
}

function hasLongLine(value: string, limit: number): boolean {
  return value.split(/\r?\n/).some((line) => compactLength(line) > limit);
}

function isFragmentSegment(segment: Segment): boolean {
  return compactLength(segment.ja) <= 1;
}

function isEmptyZhSegment(segment: Segment): boolean {
  return segment.zh === undefined || segment.zh.trim() === '';
}

function compactLength(value: string): number {
  return Array.from(value.replace(/\s/g, '')).length;
}
