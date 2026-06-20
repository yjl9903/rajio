import { stringWidth } from 'breadc';

import type { IssueLevel, Segment } from '../types.js';
import { logger } from '../utils/logger.js';

export type SegmentOutputFormat = 'human' | 'csv' | 'json';

export interface SegmentOutputWriter {
  isTTY?: boolean;
  write(chunk: string): unknown;
}

export interface SegmentOutput {
  format: SegmentOutputFormat;
  writer: SegmentOutputWriter;
  jsonPretty: boolean;
}

export interface SegmentOutputOptions {
  json?: boolean;
  writer?: SegmentOutputWriter;
}

export interface SegmentPrintOptions {
  totalDuration?: number;
  stats?: SegmentOutputStats;
  issuesBySegment?: Map<string, SegmentOutputIssue[]>;
  affectedSegmentIds?: Set<string>;
  jsonPretty?: boolean;
}

export interface SegmentOutputIssue {
  level: IssueLevel;
  code?: string;
  message: string;
}

export interface SegmentOutputStats {
  total: number;
  listed: number;
  translated: number;
  untranslated: number;
}

export interface SegmentPatchOutputStats {
  edits: number;
  splits: number;
  merges: number;
  inserts: number;
  deletes: number;
  total: number;
}

const baseColumns = ['id', 'start', 'end', 'speaker', 'ja', 'zh'] as const;
const affectedColumn = 'affected';
const issueColumn = 'issues';
const patchStatColumns = ['edits', 'splits', 'merges', 'inserts', 'deletes', 'total'] as const;

export function prepareSegmentOutput(options: SegmentOutputOptions): SegmentOutput {
  const writer = options.writer ?? process.stdout;
  const format = options.json ? 'json' : writer.isTTY ? 'human' : 'csv';
  if (format !== 'human') {
    logger.level = Number.NEGATIVE_INFINITY;
  }
  return { format, writer, jsonPretty: format === 'json' && Boolean(writer.isTTY) };
}

export function printSegments(
  segments: Segment[],
  output: SegmentOutput,
  options: SegmentPrintOptions = {}
): void {
  output.writer.write(
    `${formatSegments(segments, output.format, {
      ...options,
      jsonPretty: output.jsonPretty
    })}\n`
  );
}

export function printSegmentPatchStats(
  stats: SegmentPatchOutputStats,
  output: SegmentOutput
): void {
  output.writer.write(`${formatSegmentPatchStats(stats, output.format, output.jsonPretty)}\n`);
}

export function formatSegments(
  segments: Segment[],
  format: SegmentOutputFormat,
  options: SegmentPrintOptions = {}
): string {
  if (format === 'json') {
    return formatJson(
      {
        segments: segments.map((segment) =>
          toSegmentJsonRow(segment, options.issuesBySegment, options.affectedSegmentIds)
        ),
        ...(options.stats ? { stats: options.stats } : {})
      },
      options.jsonPretty
    );
  }
  const usesHours = shouldUseHours(segments, options.totalDuration);
  if (format === 'csv') {
    return formatCsv(segments, options.issuesBySegment, options.affectedSegmentIds);
  }
  return formatHumanTable(
    segments,
    usesHours,
    options.stats,
    options.issuesBySegment,
    options.affectedSegmentIds
  );
}

export function formatSegmentPatchStats(
  stats: SegmentPatchOutputStats,
  format: SegmentOutputFormat,
  jsonPretty = false
): string {
  if (format === 'json') {
    return formatJson({ stats }, jsonPretty);
  }
  if (format === 'csv') {
    return [
      patchStatColumns.join(','),
      patchStatColumns.map((column) => stats[column]).join(',')
    ].join('\n');
  }
  const values = patchStatColumns.map((column) => String(stats[column]));
  const widths = Object.fromEntries(
    patchStatColumns.map((column, index) => [
      column,
      Math.max(column.length, values[index]!.length)
    ])
  ) as Record<(typeof patchStatColumns)[number], number>;
  const header = patchStatColumns
    .map((column) => padRight(column.toUpperCase(), widths[column]))
    .join('  ');
  const separator = patchStatColumns.map((column) => '-'.repeat(widths[column])).join('  ');
  const body = patchStatColumns
    .map((column, index) => padRight(values[index]!, widths[column]))
    .join('  ');
  return [header, separator, body].join('\n');
}

function toSegmentRow(
  segment: Segment,
  issuesBySegment?: Map<string, SegmentOutputIssue[]>,
  affectedSegmentIds?: Set<string>
): Record<string, string | number> {
  const issues = issuesBySegment?.get(segment.id);
  return {
    id: segment.id,
    start: segment.start,
    end: segment.end,
    speaker: segment.speaker,
    ja: segment.ja,
    zh: segment.zh ?? '',
    ...(affectedSegmentIds
      ? { affected: affectedSegmentIds.has(segment.id) ? 'true' : 'false' }
      : {}),
    ...(issuesBySegment ? { issues: issues ? formatIssueCodes(issues) : '' } : {})
  };
}

function toSegmentJsonRow(
  segment: Segment,
  issuesBySegment?: Map<string, SegmentOutputIssue[]>,
  affectedSegmentIds?: Set<string>
): Record<(typeof baseColumns)[number], string | number> & {
  affected?: boolean;
  issues?: SegmentOutputIssue[];
} {
  const issues = issuesBySegment?.get(segment.id);
  return {
    id: segment.id,
    start: segment.start,
    end: segment.end,
    speaker: segment.speaker,
    ja: segment.ja,
    zh: segment.zh ?? '',
    ...(affectedSegmentIds ? { affected: affectedSegmentIds.has(segment.id) } : {}),
    ...(issues ? { issues } : {})
  };
}

function formatCsv(
  segments: Segment[],
  issuesBySegment?: Map<string, SegmentOutputIssue[]>,
  affectedSegmentIds?: Set<string>
): string {
  const columns = segmentColumns(issuesBySegment, affectedSegmentIds);
  return [
    columns.join(','),
    ...segments.map((segment) =>
      columns
        .map((column) =>
          escapeCsvField(toSegmentRow(segment, issuesBySegment, affectedSegmentIds)[column] ?? '')
        )
        .join(',')
    )
  ].join('\n');
}

function escapeCsvField(value: string | number): string {
  const text = String(value);
  if (!/[",\r\n]/.test(text)) {
    return text;
  }
  return `"${text.replaceAll('"', '""')}"`;
}

function formatHumanTable(
  segments: Segment[],
  usesHours: boolean,
  stats: SegmentOutputStats | undefined,
  issuesBySegment?: Map<string, SegmentOutputIssue[]>,
  affectedSegmentIds?: Set<string>
): string {
  const columns = segmentColumns(issuesBySegment, affectedSegmentIds);
  const rows = segments.map((segment) =>
    toDisplaySegmentRow(segment, usesHours, issuesBySegment, affectedSegmentIds)
  );
  const widths = Object.fromEntries(
    columns.map((column) => [
      column,
      Math.max(column.length, ...rows.map((row) => displayLength(row[column])))
    ])
  ) as Record<(typeof columns)[number], number>;

  const header = columns.map((column) => padRight(column.toUpperCase(), widths[column])).join('  ');
  const separator = columns.map((column) => '-'.repeat(widths[column])).join('  ');
  const body = rows.map((row) =>
    columns.map((column) => padRight(row[column], widths[column])).join('  ')
  );
  const footer = stats
    ? [
        `total ${stats.total}  listed ${stats.listed}  translated ${stats.translated}  untranslated ${stats.untranslated}`
      ]
    : [];
  return [header, separator, ...body, ...footer].join('\n');
}

function toDisplaySegmentRow(
  segment: Segment,
  usesHours: boolean,
  issuesBySegment?: Map<string, SegmentOutputIssue[]>,
  affectedSegmentIds?: Set<string>
): Record<string, string> {
  const issues = issuesBySegment?.get(segment.id);
  return {
    id: segment.id,
    start: formatTime(segment.start, usesHours),
    end: formatTime(segment.end, usesHours),
    speaker: segment.speaker,
    ja: escapeHumanText(segment.ja),
    zh: escapeHumanText(segment.zh ?? ''),
    ...(affectedSegmentIds
      ? { affected: affectedSegmentIds.has(segment.id) ? 'true' : 'false' }
      : {}),
    ...(issuesBySegment ? { issues: issues ? formatIssueCodes(issues) : '' } : {})
  };
}

function segmentColumns(
  issuesBySegment?: Map<string, SegmentOutputIssue[]>,
  affectedSegmentIds?: Set<string>
): string[] {
  return [
    ...baseColumns,
    ...(affectedSegmentIds ? [affectedColumn] : []),
    ...(issuesBySegment ? [issueColumn] : [])
  ];
}

function formatIssueCodes(issues: SegmentOutputIssue[]): string {
  return issues.map((issue) => issue.code ?? issue.level).join(',');
}

function shouldUseHours(segments: Segment[], totalDuration: number | undefined): boolean {
  const duration =
    totalDuration ?? Math.max(0, ...segments.map((segment) => segment.end).filter(Number.isFinite));
  return Math.round(duration) >= 60 * 60;
}

function formatTime(value: number, usesHours: boolean): string {
  const seconds = Math.max(0, Math.round(value));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  if (usesHours) {
    return `${hours}:${padTimePart(minutes)}:${padTimePart(remainingSeconds)}`;
  }
  return `${padTimePart(Math.floor(seconds / 60))}:${padTimePart(remainingSeconds)}`;
}

function padTimePart(value: number): string {
  return String(value).padStart(2, '0');
}

function escapeHumanText(value: string): string {
  return value.replaceAll('\r', '\\r').replaceAll('\n', '\\n');
}

function padRight(value: string, width: number): string {
  return `${value}${' '.repeat(Math.max(0, width - displayLength(value)))}`;
}

function displayLength(value: string): number {
  return stringWidth(value);
}

function formatJson(value: unknown, pretty: boolean | undefined): string {
  return pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
}
