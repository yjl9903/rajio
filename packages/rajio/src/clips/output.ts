import { stringWidth } from 'breadc';

import { logger } from '../utils/logger.js';
import type { ClipListRow } from './types.js';

export type ClipOutputFormat = 'human' | 'csv' | 'json';

export interface ClipOutputWriter {
  isTTY?: boolean;
  write(chunk: string): unknown;
}

export interface ClipOutput {
  format: ClipOutputFormat;
  writer: ClipOutputWriter;
  jsonPretty: boolean;
}

const columns = ['id', 'label', 'start', 'end', 'duration', 'status', 'segments'] as const;

export function prepareClipOutput(options: {
  json?: boolean;
  writer?: ClipOutputWriter;
}): ClipOutput {
  const writer = options.writer ?? process.stdout;
  const format = options.json ? 'json' : writer.isTTY ? 'human' : 'csv';
  if (format !== 'human') {
    logger.level = Number.NEGATIVE_INFINITY;
  }
  return { format, writer, jsonPretty: format === 'json' && Boolean(writer.isTTY) };
}

export function printClipList(rows: ClipListRow[], output: ClipOutput): void {
  output.writer.write(`${formatClipList(rows, output.format, { pretty: output.jsonPretty })}\n`);
}

export function formatClipList(
  rows: ClipListRow[],
  format: ClipOutputFormat,
  options: { pretty?: boolean } = {}
): string {
  if (format === 'json') {
    return formatJson({ clips: rows }, options.pretty);
  }
  if (format === 'csv') {
    return formatCsv(rows);
  }
  return formatHumanTable(rows);
}

function formatCsv(rows: ClipListRow[]): string {
  return [
    columns.join(','),
    ...rows.map((row) => columns.map((column) => escapeCsvField(row[column])).join(','))
  ].join('\n');
}

function formatHumanTable(rows: ClipListRow[]): string {
  const displayRows = rows.map(toDisplayRow);
  const widths = Object.fromEntries(
    columns.map((column) => [
      column,
      Math.max(column.length, ...displayRows.map((row) => displayLength(row[column])))
    ])
  ) as Record<(typeof columns)[number], number>;

  const header = columns.map((column) => padRight(column.toUpperCase(), widths[column])).join('  ');
  const separator = columns.map((column) => '-'.repeat(widths[column])).join('  ');
  const body = displayRows.map((row) =>
    columns.map((column) => padRight(row[column], widths[column])).join('  ')
  );
  return [header, separator, ...body].join('\n');
}

function toDisplayRow(row: ClipListRow): Record<(typeof columns)[number], string> {
  const usesHours = Math.round(row.end) >= 60 * 60;
  return {
    id: row.id,
    label: row.label,
    start: formatTime(row.start, usesHours),
    end: formatTime(row.end, usesHours),
    duration: formatDuration(row.duration),
    status: row.status,
    segments: String(row.segments)
  };
}

function escapeCsvField(value: string | number): string {
  const text = String(value);
  if (!/[",\r\n]/.test(text)) {
    return text;
  }
  return `"${text.replaceAll('"', '""')}"`;
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

function formatDuration(seconds: number): string {
  return seconds.toFixed(seconds % 1 === 0 ? 0 : 3);
}

function padTimePart(value: number): string {
  return String(value).padStart(2, '0');
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
