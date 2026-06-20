import type { IssueLevel, Segment, ValidationIssue } from '../types.js';

export const SEGMENT_ISSUE_FILTERS = [
  'duplicate_id',
  'invalid_time',
  'overlap',
  'empty_ja',
  'empty_zh',
  'ja_line_soft_limit',
  'ja_line_hard_limit',
  'zh_line_soft_limit',
  'zh_line_hard_limit',
  'ja_line_break_can_merge_soft',
  'ja_line_break_can_merge_hard',
  'ja_line_break_soft_limit',
  'ja_line_break_hard_limit',
  'zh_line_break_can_merge_soft',
  'zh_line_break_can_merge_hard',
  'zh_line_break_soft_limit',
  'zh_line_break_hard_limit',
  'duration_too_short',
  'duration_too_long',
  'ja_reading_speed_limit',
  'zh_reading_speed_limit',
  'subtitle_gap_too_short',
  'subtitle_gap_short',
  'ja_common_punctuation',
  'zh_common_punctuation',
  'ja_terminal_punctuation',
  'zh_terminal_punctuation',
  'ja_repeated_punctuation',
  'zh_repeated_punctuation',
  'ja_punctuation_only_line',
  'zh_punctuation_only_line',
  'unused_skip_check'
] as const;

export type SegmentIssueFilter = (typeof SEGMENT_ISSUE_FILTERS)[number];

export interface SegmentListOptions {
  id?: string[];
  offset?: number;
  limit?: number;
  start?: number;
  end?: number;
  around?: number;
  issues?: SegmentIssueFilter[];
  level?: IssueLevel;
  validationIssues?: ValidationIssue[];
}

export function listSegments(segments: Segment[], options: SegmentListOptions): Segment[] {
  const mode = resolveListMode(options);
  if (mode === 'id') {
    const ids = options.id!;
    if (options.around !== undefined) {
      validateAroundOptions(options);
      return listAroundIds(segments, ids, options.around);
    }
    return listByIds(segments, ids);
  }

  if (mode === 'range') {
    return pageSegments(segments, options);
  }

  if (mode === 'time') {
    const start = options.start!;
    const end = options.end!;
    return segments.filter((segment) => segment.start >= start && segment.start < end);
  }

  if (mode === 'issues') {
    const filters = new Set(options.issues);
    if (!options.validationIssues) {
      throw new Error('--issues requires validation issues.');
    }
    return pageSegments(
      listByValidationIssues(segments, filters, options.validationIssues, options.level),
      options
    );
  }

  return segments;
}

function resolveListMode(options: SegmentListOptions): 'all' | 'id' | 'range' | 'time' | 'issues' {
  const filterModeError =
    'filter modes cannot be mixed: use only one of --id, --start/--end, or --issues. --offset/--limit may page all rows or --issues results.';
  const hasId = options.id !== undefined;
  const hasPagination = options.offset !== undefined || options.limit !== undefined;
  const hasTime = options.start !== undefined || options.end !== undefined;
  const hasIssues = options.issues !== undefined && options.issues.length > 0;
  const hasLevel = options.level !== undefined;
  if (hasLevel && !hasIssues) {
    throw new Error('--level requires --issues.');
  }
  const modeCount = [hasId, hasTime, hasIssues].filter(Boolean).length;
  if (modeCount > 1) {
    throw new Error(filterModeError);
  }
  if (hasPagination && (hasId || hasTime)) {
    throw new Error(filterModeError);
  }
  if (!hasId && options.around !== undefined) {
    throw new Error('--around requires --id.');
  }
  if (hasId && options.id!.length === 0) {
    throw new Error('--id requires at least one segment id.');
  }
  if (hasPagination) {
    validateRangeOptions(options);
  }

  if (hasId) {
    return 'id';
  }
  if (hasTime) {
    validateTimeOptions(options);
    return 'time';
  }
  if (hasIssues) {
    return 'issues';
  }
  if (hasPagination) {
    return 'range';
  }
  return 'all';
}

function pageSegments(segments: Segment[], options: SegmentListOptions): Segment[] {
  const offset = options.offset ?? 0;
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  return segments.slice(offset, Number.isFinite(limit) ? offset + limit : undefined);
}

function listAroundIds(segments: Segment[], ids: string[], around: number): Segment[] {
  const indexes = new Set<number>();
  for (const id of ids) {
    const index = segments.findIndex((segment) => segment.id === id);
    if (index === -1) {
      throw new Error(`segment not found: ${id}`);
    }
    for (let selected = Math.max(0, index - around); selected <= index + around; selected += 1) {
      indexes.add(selected);
    }
  }
  return segments.filter((_, index) => indexes.has(index));
}

function listByIds(segments: Segment[], ids: string[]): Segment[] {
  const byId = new Map(segments.map((segment) => [segment.id, segment]));
  return ids.map((id) => {
    const segment = byId.get(id);
    if (!segment) {
      throw new Error(`segment not found: ${id}`);
    }
    return segment;
  });
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

function listByValidationIssues(
  segments: Segment[],
  filters: Set<SegmentIssueFilter>,
  issues: ValidationIssue[],
  level: IssueLevel = 'warning'
): Segment[] {
  const matchingIds = new Set(
    issues
      .filter((issue) => isAtOrAboveLevel(issue.level, level))
      .filter((issue) => isSegmentIssueFilter(issue.code) && filters.has(issue.code))
      .filter((issue) => issue.segmentId)
      .map((issue) => issue.segmentId!)
  );
  return segments.filter((segment) => matchingIds.has(segment.id));
}

function isAtOrAboveLevel(issueLevel: IssueLevel, threshold: IssueLevel): boolean {
  return levelRank(issueLevel) <= levelRank(threshold);
}

function levelRank(level: IssueLevel): number {
  if (level === 'fatal') {
    return 0;
  }
  return level === 'error' ? 1 : 2;
}

function isSegmentIssueFilter(code: string): code is SegmentIssueFilter {
  return (SEGMENT_ISSUE_FILTERS as readonly string[]).includes(code);
}
