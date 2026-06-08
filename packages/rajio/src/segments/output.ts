import { stringWidth } from 'breadc';

import type { Segment } from '../types.js';
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
  jsonPretty?: boolean;
}

export interface SegmentOutputStats {
  total: number;
  listed: number;
  translated: number;
  untranslated: number;
}

const columns = ['id', 'start', 'end', 'speaker', 'ja', 'zh'] as const;

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

export function formatSegments(
  segments: Segment[],
  format: SegmentOutputFormat,
  options: SegmentPrintOptions = {}
): string {
  if (format === 'json') {
    return formatJson(
      {
        segments: segments.map(toSegmentRow),
        ...(options.stats ? { stats: options.stats } : {})
      },
      options.jsonPretty
    );
  }
  const usesHours = shouldUseHours(segments, options.totalDuration);
  if (format === 'csv') {
    return formatCsv(segments);
  }
  return formatHumanTable(segments, usesHours, options.stats);
}

function toSegmentRow(segment: Segment): Record<(typeof columns)[number], string | number> {
  return {
    id: segment.id,
    start: segment.start,
    end: segment.end,
    speaker: segment.speaker,
    ja: segment.ja,
    zh: segment.zh ?? ''
  };
}

function formatCsv(segments: Segment[]): string {
  return [
    columns.join(','),
    ...segments.map((segment) =>
      columns.map((column) => escapeCsvField(toSegmentRow(segment)[column])).join(',')
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
  stats: SegmentOutputStats | undefined
): string {
  const rows = segments.map((segment) => toDisplaySegmentRow(segment, usesHours));
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
  usesHours: boolean
): Record<(typeof columns)[number], string> {
  return {
    id: segment.id,
    start: formatTime(segment.start, usesHours),
    end: formatTime(segment.end, usesHours),
    speaker: segment.speaker,
    ja: escapeHumanText(segment.ja),
    zh: escapeHumanText(segment.zh ?? '')
  };
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
