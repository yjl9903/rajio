import { readdir } from 'node:fs/promises';
import path from 'node:path';

import type { ConsolaInstance } from 'consola';

import { fromSessionRelative, pathExists, sha256File } from '../utils/fs.js';
import type { Session } from './index.js';
import { readSegmentsFile, validateSegments } from '../segments/index.js';
import { STAGES, STAGE_STATUSES, type Segment, type StageName, type StageState } from '../types.js';
import { taggedLogger } from '../utils/logger.js';

const checkLogger = taggedLogger('check');
const VALID_STAGE_STATUSES = new Set(STAGE_STATUSES);

export interface CheckIssue {
  file: string;
  stage?: StageName;
  level: 'error' | 'warning';
  code?: string;
  message: string;
  segmentId?: string;
  segment?: CheckIssueSegmentContext;
}

export interface CheckIssueSegmentContext {
  id: string;
  start: number;
  end: number;
  duration: number;
  previousId?: string;
  nextId?: string;
  jaChars: number;
  zhChars?: number;
  text: string;
}

export interface CheckResult {
  ok: boolean;
  issues: CheckIssue[];
}

export type CheckIssueLevelFilter = 'all' | 'error' | 'warning';
export type CheckStageFilter =
  | 'audio'
  | 'transcript'
  | 'transcript_raw'
  | 'transcript_work'
  | 'translation'
  | 'translation_work'
  | 'export';

export async function checkRajio(session: Session): Promise<CheckResult> {
  const issues: CheckIssue[] = [];
  const checkedSegments = new Set<string>();

  if (await pathExists(session.path)) {
    await checkSession(session, issues, checkedSegments);
  } else {
    issues.push({
      file: session.path,
      level: 'error',
      code: 'missing_session',
      message: 'Missing session.toml.'
    });
  }

  const segmentFiles = await findSegmentFiles(session.dir);
  for (const filePath of segmentFiles) {
    await checkSegments(filePath, issues, {}, checkedSegments);
  }

  return {
    ok: !issues.some((issue) => issue.level === 'error'),
    issues
  };
}

export function printCheckIssues(
  issues: CheckIssue[],
  options: {
    verbose: boolean;
    logger?: ConsolaInstance;
    json?: boolean;
    writer?: { write(chunk: string): unknown };
  }
): void {
  if (options.json) {
    printCheckJson(issues, options.writer ?? process.stdout);
    return;
  }

  const logger = options.logger ?? checkLogger;
  if (options.verbose) {
    for (const issue of sortCheckIssues(issues)) {
      printCheckIssue(issue, logger);
    }
    return;
  }

  for (const summary of summarizeCheckIssues(issues)) {
    const message = formatCheckSummary(summary);
    if (summary.level === 'error') {
      logger.error(message);
    } else {
      logger.warn(message);
    }
  }
}

export function filterCheckIssues(
  issues: CheckIssue[],
  options: { level?: CheckIssueLevelFilter; stage?: CheckStageFilter } = {}
): CheckIssue[] {
  return issues.filter((issue) => {
    if (options.level && options.level !== 'all' && issue.level !== options.level) {
      return false;
    }
    if (options.stage && !matchesStageFilter(issue, options.stage)) {
      return false;
    }
    return true;
  });
}

export function formatCheckJson(issues: CheckIssue[]): string {
  return JSON.stringify(
    {
      ok: !issues.some((issue) => issue.level === 'error'),
      counts: countIssues(issues),
      summary: summarizeCheckIssues(issues),
      issues: sortCheckIssues(issues).map((issue) => ({
        file: issue.file,
        stage: issue.stage,
        level: issue.level,
        code: issue.code,
        message: issue.message,
        segmentId: issue.segmentId,
        segment: issue.segment
      }))
    },
    null,
    2
  );
}

async function checkSession(
  session: Session,
  issues: CheckIssue[],
  checkedSegments: Set<string>
): Promise<void> {
  const state = session.state;
  if (state.schema_version !== 1) {
    issues.push({
      file: session.path,
      level: 'error',
      code: 'invalid_schema_version',
      message: 'schema_version must be 1.'
    });
  }
  if (!STAGES.includes(state.current_stage)) {
    issues.push({
      file: session.path,
      level: 'error',
      code: 'invalid_current_stage',
      message: `Invalid current_stage: ${String(state.current_stage)}.`
    });
  }
  if (!state.input || typeof state.input !== 'object') {
    issues.push({
      file: session.path,
      level: 'error',
      code: 'missing_input',
      message: 'Missing [input] table.'
    });
  }
  if (!state.stages || typeof state.stages !== 'object') {
    issues.push({
      file: session.path,
      level: 'error',
      code: 'missing_stages',
      message: 'Missing [stages] table.'
    });
    return;
  }

  for (const stage of STAGES) {
    const stageState = state.stages[stage];
    if (!stageState) {
      issues.push({
        file: session.path,
        stage,
        level: 'error',
        code: 'missing_stage',
        message: `Missing [stages.${stage}] table.`
      });
      continue;
    }
    if (!VALID_STAGE_STATUSES.has(stageState.status)) {
      issues.push({
        file: session.path,
        stage,
        level: 'error',
        code: 'invalid_stage_status',
        message: `Invalid status for ${stage}: ${String(stageState.status)}.`
      });
    }
    if (typeof stageState.segments === 'string') {
      const segmentsPath = fromSessionRelative(session.dir, stageState.segments);
      if (!(await pathExists(segmentsPath))) {
        issues.push({
          file: session.path,
          stage,
          level: 'error',
          code: 'missing_segments_file',
          message: `Referenced segments file does not exist: ${stageState.segments}.`
        });
      } else {
        await checkSegments(segmentsPath, issues, {}, checkedSegments);
      }
    }
    if (
      stage === 'audio' &&
      stageState.status === 'done' &&
      shouldValidateAudioChunks(stageState)
    ) {
      if (!Array.isArray(stageState.chunks)) {
        issues.push({
          file: session.path,
          stage,
          level: 'error',
          code: 'missing_audio_chunks',
          message: 'audio stage is missing detailed chunk metadata.'
        });
        continue;
      }
      const chunks = session.audioChunks();
      const expectedCount = Number(stageState.chunk_count ?? chunks.length);
      if (expectedCount > 0 && expectedCount !== chunks.length) {
        issues.push({
          file: session.path,
          stage,
          level: 'error',
          code: 'audio_chunk_count_mismatch',
          message: `audio chunk count mismatch: expected ${expectedCount}, got ${chunks.length}.`
        });
      }
      if (chunks.length === 0) {
        issues.push({
          file: session.path,
          stage,
          level: 'error',
          code: 'missing_audio_chunks',
          message: 'audio stage is missing detailed chunk metadata.'
        });
      }
      for (const [index, chunk] of chunks.entries()) {
        const chunkPath = fromSessionRelative(session.dir, chunk.audio);
        if (!(await pathExists(chunkPath))) {
          issues.push({
            file: session.path,
            stage,
            level: 'error',
            code: 'missing_audio_chunk_file',
            message: `audio chunk file does not exist: ${chunk.audio} (chunk ${index + 1}).`
          });
          continue;
        }
        try {
          const current = await sha256File(chunkPath);
          if (chunk.sha256 !== current) {
            issues.push({
              file: session.path,
              stage,
              level: 'error',
              code: 'audio_chunk_hash_mismatch',
              message: `audio chunk hash mismatch: ${chunk.audio} (chunk ${index + 1}).`
            });
          }
        } catch (error) {
          issues.push({
            file: session.path,
            stage,
            level: 'error',
            code: 'audio_chunk_hash_error',
            message: formatError(error)
          });
        }
      }
    }
  }
}

function shouldValidateAudioChunks(stageState: StageState): boolean {
  return (
    Array.isArray(stageState.chunks) ||
    typeof stageState.audio === 'string' ||
    typeof stageState.chunks_dir === 'string' ||
    typeof stageState.chunk_count === 'number'
  );
}

async function checkSegments(
  filePath: string,
  issues: CheckIssue[],
  options: { requireZh?: boolean; strict?: boolean } = {},
  checkedSegments?: Set<string>
): Promise<void> {
  const normalizedPath = path.resolve(filePath);
  if (checkedSegments?.has(normalizedPath)) {
    return;
  }
  checkedSegments?.add(normalizedPath);

  try {
    const file = await readSegmentsFile(filePath);
    const requireZh = options.requireZh ?? file.source.kind === 'translation';
    const strict = options.strict ?? !isRawTranscriptSegmentsPath(filePath);
    for (const issue of validateSegments(file, { requireZh, strict })) {
      const segment = issue.segmentId
        ? buildSegmentContext(file.segments, issue.segmentId)
        : undefined;
      issues.push({
        file: filePath,
        stage: inferStageFromPath(filePath),
        level: issue.level,
        code: issue.code,
        message: issue.message,
        segmentId: issue.segmentId,
        segment
      });
    }
  } catch (error) {
    issues.push({
      file: filePath,
      stage: inferStageFromPath(filePath),
      level: 'error',
      code: 'segments_parse_error',
      message: formatError(error)
    });
  }
}

function isRawTranscriptSegmentsPath(filePath: string): boolean {
  const parts = path.normalize(filePath).split(path.sep);
  return (
    parts.at(-3) === 'transcript' && parts.at(-2) === 'raw' && parts.at(-1) === 'segments.toml'
  );
}

function inferStageFromPath(filePath: string): StageName | undefined {
  const parts = path.normalize(filePath).split(path.sep);
  const root = parts.at(-3);
  const phase = parts.at(-2);
  if (root === 'transcript' && phase === 'raw') {
    return 'transcript_raw';
  }
  if (root === 'transcript' && phase === 'work') {
    return 'transcript_work';
  }
  if (root === 'translation' && phase === 'work') {
    return 'translation_work';
  }
  return undefined;
}

function buildSegmentContext(
  segments: Segment[],
  segmentId: string
): CheckIssueSegmentContext | undefined {
  const index = segments.findIndex((segment) => segment.id === segmentId);
  if (index < 0) {
    return undefined;
  }
  const segment = segments[index]!;
  return {
    id: segment.id,
    start: segment.start,
    end: segment.end,
    duration: segment.end - segment.start,
    previousId: segments[index - 1]?.id,
    nextId: segments[index + 1]?.id,
    jaChars: countTextChars(segment.ja),
    zhChars: segment.zh === undefined ? undefined : countTextChars(segment.zh),
    text: summarizeSegmentText(segment)
  };
}

function printCheckIssue(issue: CheckIssue, logger: ConsolaInstance): void {
  const message = `${issue.file}: ${issue.message}${formatIssueContext(issue)}`;
  if (issue.level === 'error') {
    logger.error(message);
  } else {
    logger.warn(message);
  }
}

interface CheckIssueSummary {
  file: string;
  stage?: StageName;
  level: 'error' | 'warning';
  code: string;
  count: number;
  message: string;
  examples: CheckIssue[];
}

function summarizeCheckIssues(issues: CheckIssue[]): CheckIssueSummary[] {
  const groups = new Map<string, CheckIssueSummary>();
  for (const issue of sortCheckIssues(issues)) {
    const code = issue.code ?? 'uncategorized';
    const key = `${issue.level}\0${code}\0${issue.file}\0${issue.stage ?? ''}`;
    const summary = groups.get(key) ?? {
      file: issue.file,
      stage: issue.stage,
      level: issue.level,
      code,
      count: 0,
      message: issue.message,
      examples: []
    };
    summary.count += 1;
    if (summary.examples.length < 5) {
      summary.examples.push(issue);
    }
    groups.set(key, summary);
  }
  return Array.from(groups.values()).sort(compareSummaries);
}

function formatCheckSummary(summary: CheckIssueSummary): string {
  const label = summary.count === 1 ? 'issue' : 'issues';
  const stage = summary.stage ? ` [${summary.stage}]` : '';
  const examples = summary.examples
    .map((issue) => formatIssueExample(issue))
    .filter(Boolean)
    .join('; ');
  const examplesText = examples ? ` Examples: ${examples}.` : '';
  return `${summary.file}${stage}: ${summary.count} ${summary.level} ${label} (${summary.code}). ${summary.message}${examplesText} Use --verbose for details.`;
}

function formatIssueExample(issue: CheckIssue): string {
  if (!issue.segment) {
    return issue.segmentId ? `id=${issue.segmentId}` : '';
  }
  return [
    `id=${issue.segment.id}`,
    `time=${formatTimeRange(issue.segment)}`,
    `duration=${formatSeconds(issue.segment.duration)}`,
    `chars=${formatTextLengths(issue.segment)}`,
    `adjacent=${issue.segment.previousId ?? '-'}|${issue.segment.nextId ?? '-'}`,
    `text="${issue.segment.text}"`
  ].join(' ');
}

function formatIssueContext(issue: CheckIssue): string {
  const example = formatIssueExample(issue);
  return example ? ` (${example})` : '';
}

function printCheckJson(issues: CheckIssue[], writer: { write(chunk: string): unknown }): void {
  writer.write(`${formatCheckJson(issues)}\n`);
}

function countIssues(issues: CheckIssue[]): { errors: number; warnings: number } {
  return {
    errors: issues.filter((issue) => issue.level === 'error').length,
    warnings: issues.filter((issue) => issue.level === 'warning').length
  };
}

function sortCheckIssues(issues: CheckIssue[]): CheckIssue[] {
  return [...issues].sort(compareIssues);
}

function compareIssues(a: CheckIssue, b: CheckIssue): number {
  return (
    compareLevel(a.level, b.level) ||
    a.file.localeCompare(b.file) ||
    (a.stage ?? '').localeCompare(b.stage ?? '') ||
    (a.code ?? '').localeCompare(b.code ?? '') ||
    compareSegmentContext(a.segment, b.segment) ||
    (a.segmentId ?? '').localeCompare(b.segmentId ?? '')
  );
}

function compareSummaries(a: CheckIssueSummary, b: CheckIssueSummary): number {
  return (
    compareLevel(a.level, b.level) ||
    a.file.localeCompare(b.file) ||
    (a.stage ?? '').localeCompare(b.stage ?? '') ||
    a.code.localeCompare(b.code)
  );
}

function compareLevel(a: CheckIssue['level'], b: CheckIssue['level']): number {
  return levelRank(a) - levelRank(b);
}

function levelRank(level: CheckIssue['level']): number {
  return level === 'error' ? 0 : 1;
}

function compareSegmentContext(
  a: CheckIssueSegmentContext | undefined,
  b: CheckIssueSegmentContext | undefined
): number {
  if (!a && !b) {
    return 0;
  }
  if (!a) {
    return 1;
  }
  if (!b) {
    return -1;
  }
  return a.start - b.start || a.end - b.end || a.id.localeCompare(b.id);
}

function matchesStageFilter(issue: CheckIssue, stage: CheckStageFilter): boolean {
  if (stage === 'transcript') {
    return issue.stage === 'transcript_raw' || issue.stage === 'transcript_work';
  }
  if (stage === 'translation') {
    return issue.stage === 'translation_work';
  }
  return issue.stage === stage;
}

function summarizeSegmentText(segment: Segment): string {
  return truncateText([segment.ja, segment.zh].filter((value) => value?.trim()).join(' / '), 48);
}

function truncateText(value: string, limit: number): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  const chars = Array.from(compact);
  if (chars.length <= limit) {
    return compact;
  }
  return `${chars.slice(0, limit - 3).join('')}...`;
}

function formatTextLengths(segment: CheckIssueSegmentContext): string {
  return segment.zhChars === undefined
    ? `ja:${segment.jaChars}`
    : `ja:${segment.jaChars},zh:${segment.zhChars}`;
}

function countTextChars(value: string): number {
  return Array.from(value.replace(/\s/g, '')).length;
}

function formatTimeRange(segment: CheckIssueSegmentContext): string {
  return `${formatSeconds(segment.start)}-${formatSeconds(segment.end)}`;
}

function formatSeconds(value: number): string {
  return `${formatNumber(value)}s`;
}

function formatNumber(value: number): string {
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

async function findSegmentFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const dir of ['transcript', 'translation']) {
    const dirPath = path.join(root, dir);
    if (await pathExists(dirPath)) {
      await collectSegments(dirPath, found);
    }
  }
  return found.sort((a, b) => a.localeCompare(b));
}

async function collectSegments(dir: string, found: string[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectSegments(entryPath, found);
    } else if (entry.isFile() && entry.name === 'segments.toml') {
      found.push(entryPath);
    }
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
