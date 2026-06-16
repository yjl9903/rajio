import { readdir } from 'node:fs/promises';
import path from 'node:path';

import type { ConsolaInstance } from 'consola';

import { fromSessionRelative, pathExists, sha256File, toSessionRelative } from '../utils/fs.js';
import type { Session } from './index.js';
import {
  formatValidationIssueForProfile,
  readSegmentsFile,
  validateSegments
} from '../segments/index.js';
import {
  CURRENT_STAGES,
  STAGES,
  STAGE_STATUSES,
  type CurrentStageName,
  type IssueLevel,
  type Segment,
  type StageName,
  type StageState
} from '../types.js';
import { taggedLogger } from '../utils/logger.js';

const checkLogger = taggedLogger('check');
const VALID_STAGE_STATUSES = new Set(STAGE_STATUSES);
const AUTOMATIC_STAGES = new Set<StageName>(['audio', 'transcript_raw', 'export']);

export interface CheckIssue {
  file: string;
  stage?: StageName;
  level: IssueLevel;
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

export type CheckIssueLevelFilter = IssueLevel;
export type CheckStageFilter =
  | 'audio'
  | 'transcript'
  | 'transcript_raw'
  | 'transcript_work'
  | 'translation'
  | 'translation_work'
  | 'export';
export type CheckLanguageFilter = 'ja' | 'zh';

export interface CheckFilterOptions {
  level?: CheckIssueLevelFilter;
  stage?: CheckStageFilter;
  language?: CheckLanguageFilter;
  currentStage?: CurrentStageName;
}

export interface CheckScope {
  level: CheckIssueLevelFilter;
  stage?: StageName;
  language?: CheckLanguageFilter;
  description: string;
  hint?: string;
}

interface CheckQaTarget {
  stage?: StageName;
  language?: CheckLanguageFilter;
}

export async function checkRajio(session: Session): Promise<CheckResult> {
  const issues: CheckIssue[] = [];
  const checkedSegments = new Set<string>();

  if (await pathExists(session.path)) {
    await checkSession(session, issues, checkedSegments);
  } else {
    issues.push({
      file: session.path,
      level: 'fatal',
      code: 'missing_session',
      message: 'Missing session.toml.'
    });
  }

  const segmentFiles = await findSegmentFiles(session.dir);
  for (const filePath of segmentFiles) {
    await checkSegments(filePath, issues, {}, checkedSegments);
  }

  return {
    ok: !hasBlockingIssue(issues),
    issues
  };
}

export function printCheckIssues(
  issues: CheckIssue[],
  options: {
    verbose: boolean;
    scope?: CheckScope;
    scopeLabel?: 'check' | 'commit';
    printScopeWhenEmpty?: boolean;
    logger?: ConsolaInstance;
    json?: boolean;
    sessionDir?: string;
    writer?: { isTTY?: boolean; write(chunk: string): unknown };
  }
): void {
  if (options.json) {
    printCheckJson(
      issues,
      {
        verbose: options.verbose,
        sessionDir: options.sessionDir,
        scope: options.scope,
        pretty: Boolean((options.writer ?? process.stdout).isTTY)
      },
      options.writer ?? process.stdout
    );
    return;
  }

  const logger = options.logger ?? checkLogger;
  if (options.scope && (issues.length > 0 || options.printScopeWhenEmpty !== false)) {
    logger.info(formatCheckScopeMessage(options.scope, options.scopeLabel ?? 'check'));
  }
  if (options.verbose) {
    for (const issue of sortCheckIssues(issues)) {
      printCheckIssue(issue, logger);
    }
    return;
  }

  for (const summary of summarizeCheckIssues(issues)) {
    const message = formatCheckSummary(summary);
    if (isBlockingLevel(summary.level)) {
      logger.error(message);
    } else {
      logger.warn(message);
    }
  }
}

export function filterCheckIssues(
  issues: CheckIssue[],
  options: CheckFilterOptions = {}
): CheckIssue[] {
  const level = options.level ?? 'warning';
  const target = resolveCheckQaTarget(options);
  return issues.filter((issue) => {
    if (!isAtOrAboveLevel(issue.level, level)) {
      return false;
    }
    if (issue.level === 'fatal') {
      return true;
    }
    return matchesQaTarget(issue, target);
  });
}

export function resolveCheckScope(
  options: CheckFilterOptions = {},
  context: { command?: 'check' | 'commit'; target?: string } = {}
): CheckScope {
  const level = options.level ?? 'warning';
  const target = resolveCheckQaTarget(options);
  const description = formatCheckScopeDescription(target);
  const hint = formatCheckScopeHint(target, context);
  return {
    level,
    stage: target.stage,
    language: target.language,
    description,
    hint
  };
}

export function formatCheckJson(
  issues: CheckIssue[],
  options: { verbose?: boolean; sessionDir?: string; scope?: CheckScope; pretty?: boolean } = {}
): string {
  const output: {
    ok: boolean;
    scope?: CheckScope;
    counts: ReturnType<typeof countIssues>;
    summary: CheckIssueJsonSummary[];
    issues?: Array<{
      file: string;
      stage?: StageName;
      level: CheckIssue['level'];
      code?: string;
      message: string;
      segmentId?: string;
      segment?: CheckIssueSegmentContext;
    }>;
  } = {
    ok: !hasBlockingIssue(issues),
    scope: options.scope,
    counts: countIssues(issues),
    summary: summarizeCheckIssuesForJson(issues, options)
  };

  if (options.verbose) {
    output.issues = sortCheckIssues(issues).map((issue) => ({
      file: issue.file,
      stage: issue.stage,
      level: issue.level,
      code: issue.code,
      message: issue.message,
      segmentId: issue.segmentId,
      segment: issue.segment
    }));
  }

  return formatJson(output, options.pretty);
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
      level: 'fatal',
      code: 'invalid_schema_version',
      message: 'schema_version must be 1.'
    });
  }
  if (!CURRENT_STAGES.includes(state.current_stage)) {
    issues.push({
      file: session.path,
      level: 'fatal',
      code: 'invalid_current_stage',
      message: `Invalid current_stage: ${String(state.current_stage)}.`
    });
  }
  if (!state.input || typeof state.input !== 'object') {
    issues.push({
      file: session.path,
      level: 'fatal',
      code: 'missing_input',
      message: 'Missing [input] table.'
    });
  }
  if (!state.stages || typeof state.stages !== 'object') {
    issues.push({
      file: session.path,
      level: 'fatal',
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
        level: 'fatal',
        code: 'missing_stage',
        message: `Missing [stages.${stage}] table.`
      });
      continue;
    }
    if (!VALID_STAGE_STATUSES.has(stageState.status)) {
      issues.push({
        file: session.path,
        stage,
        level: 'fatal',
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
          level: 'fatal',
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
          level: 'fatal',
          code: 'missing_audio_chunks',
          message: 'audio stage is missing detailed chunk metadata.'
        });
        continue;
      }
      const chunks = session.audioChunks();
      if (chunks.length === 0) {
        issues.push({
          file: session.path,
          stage,
          level: 'fatal',
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
            level: 'fatal',
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
              level: 'fatal',
              code: 'audio_chunk_hash_mismatch',
              message: `audio chunk hash mismatch: ${chunk.audio} (chunk ${index + 1}).`
            });
          }
        } catch (error) {
          issues.push({
            file: session.path,
            stage,
            level: 'fatal',
            code: 'audio_chunk_hash_error',
            message: formatError(error)
          });
        }
      }
    }
  }
  checkFailedCurrentAutomaticStage(session, issues);
  checkTerminalDoneConsistency(session, issues);
}

function shouldValidateAudioChunks(stageState: StageState): boolean {
  return (
    Array.isArray(stageState.chunks) ||
    typeof stageState.audio === 'string' ||
    typeof stageState.chunks_dir === 'string'
  );
}

function checkFailedCurrentAutomaticStage(session: Session, issues: CheckIssue[]): void {
  const stage = session.state.current_stage;
  if (stage === 'done') {
    return;
  }
  if (!AUTOMATIC_STAGES.has(stage)) {
    return;
  }

  const stageState = session.state.stages[stage];
  if (stageState?.status !== 'failed') {
    return;
  }

  const reason =
    typeof stageState.error === 'string' && stageState.error.trim() ? stageState.error : undefined;
  issues.push({
    file: session.path,
    stage,
    level: 'fatal',
    code: 'failed_stage',
    message: reason ? `${stage} failed: ${reason}` : `${stage} failed.`
  });
}

function checkTerminalDoneConsistency(session: Session, issues: CheckIssue[]): void {
  if (session.state.current_stage !== 'done') {
    return;
  }

  const exportStage = session.state.stages.export;
  if (!exportStage || exportStage.status === 'done') {
    return;
  }

  issues.push({
    file: session.path,
    stage: 'export',
    level: 'fatal',
    code: 'incomplete_terminal_stage',
    message: `current_stage is done but export status is ${String(exportStage.status)}.`
  });
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
  issues.push(...(await checkSegmentsFile(filePath, options)));
}

export async function checkSegmentsFile(
  filePath: string,
  options: { requireZh?: boolean; strict?: boolean } = {}
): Promise<CheckIssue[]> {
  try {
    const file = await readSegmentsFile(filePath);
    const requireZh = options.requireZh ?? file.source.kind === 'translation';
    const strict = options.strict ?? !isRawTranscriptSegmentsPath(filePath);
    const stage = inferStageFromPath(filePath);
    const profile = stage === 'translation_work' ? 'translation_work' : 'default';
    return validateSegments(file, { requireZh, strict }).map((issue) => {
      const segment = issue.segmentId
        ? buildSegmentContext(file.segments, issue.segmentId)
        : undefined;
      const formattedIssue = formatValidationIssueForProfile(issue, {
        profile
      });
      return {
        file: filePath,
        stage,
        level: formattedIssue.level,
        code: issue.code,
        message: formattedIssue.message,
        segmentId: issue.segmentId,
        segment
      };
    });
  } catch (error) {
    return [
      {
        file: filePath,
        stage: inferStageFromPath(filePath),
        level: 'fatal',
        code: 'segments_parse_error',
        message: formatError(error)
      }
    ];
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
  if (isBlockingLevel(issue.level)) {
    logger.error(message);
  } else {
    logger.warn(message);
  }
}

interface CheckIssueSummary {
  file: string;
  stage?: StageName;
  level: IssueLevel;
  code: string;
  count: number;
  message: string;
  examples: CheckIssue[];
}

interface CheckIssueJsonSummary {
  file: string;
  level: IssueLevel;
  code: string;
  count: number;
  message: string;
  examples?: Array<{ id: string }>;
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

function summarizeCheckIssuesForJson(
  issues: CheckIssue[],
  options: { sessionDir?: string } = {}
): CheckIssueJsonSummary[] {
  const groups = new Map<string, CheckIssueJsonSummary>();
  for (const issue of sortCheckIssues(issues)) {
    const code = issue.code ?? 'uncategorized';
    const file = formatCheckJsonFile(issue.file, options.sessionDir);
    const key = `${issue.level}\0${code}\0${file}`;
    const summary = groups.get(key) ?? {
      file,
      level: issue.level,
      code,
      count: 0,
      message: issue.message
    };
    summary.count += 1;

    const id = issue.segment?.id ?? issue.segmentId;
    if (id && (summary.examples?.length ?? 0) < 3) {
      summary.examples = [...(summary.examples ?? []), { id }];
    }

    groups.set(key, summary);
  }
  return Array.from(groups.values()).sort(compareJsonSummaries);
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

function printCheckJson(
  issues: CheckIssue[],
  options: { verbose?: boolean; sessionDir?: string; scope?: CheckScope; pretty?: boolean },
  writer: { isTTY?: boolean; write(chunk: string): unknown }
): void {
  writer.write(`${formatCheckJson(issues, options)}\n`);
}

function countIssues(issues: CheckIssue[]): { fatal: number; error: number; warning: number } {
  return {
    fatal: issues.filter((issue) => issue.level === 'fatal').length,
    error: issues.filter((issue) => issue.level === 'error').length,
    warning: issues.filter((issue) => issue.level === 'warning').length
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

function compareJsonSummaries(a: CheckIssueJsonSummary, b: CheckIssueJsonSummary): number {
  return (
    compareLevel(a.level, b.level) || a.file.localeCompare(b.file) || a.code.localeCompare(b.code)
  );
}

function compareLevel(a: CheckIssue['level'], b: CheckIssue['level']): number {
  return levelRank(a) - levelRank(b);
}

function levelRank(level: CheckIssue['level']): number {
  if (level === 'fatal') {
    return 0;
  }
  return level === 'error' ? 1 : 2;
}

function isAtOrAboveLevel(issueLevel: IssueLevel, threshold: IssueLevel): boolean {
  return levelRank(issueLevel) <= levelRank(threshold);
}

function isBlockingLevel(level: IssueLevel): boolean {
  return level === 'fatal' || level === 'error';
}

function hasBlockingIssue(issues: CheckIssue[]): boolean {
  return issues.some((issue) => isBlockingLevel(issue.level));
}

function resolveCheckQaTarget(options: CheckFilterOptions): CheckQaTarget {
  const stage = options.stage
    ? resolveExplicitStageQaTarget(options.stage)
    : resolveCurrentStageQaTarget(options.currentStage);
  if (!stage) {
    return {};
  }

  if (stage === 'transcript_work') {
    if (options.language === 'zh') {
      throw new Error('transcript check supports only --language ja.');
    }
    return { stage, language: 'ja' };
  }

  return { stage, language: options.language ?? 'zh' };
}

function formatCheckScopeMessage(scope: CheckScope, label: 'check' | 'commit'): string {
  const levelText = scope.level === 'warning' ? '' : `, level ${scope.level}`;
  const hintText = scope.hint ? ` ${scope.hint}` : '';
  return `${label} scope: ${scope.description}${levelText}.${hintText}`;
}

function formatCheckScopeDescription(target: CheckQaTarget): string {
  if (target.stage && target.language) {
    return `${target.stage} ${target.language} QA`;
  }
  return 'session/workflow integrity';
}

function formatCheckScopeHint(
  target: CheckQaTarget,
  context: { command?: 'check' | 'commit'; target?: string }
): string | undefined {
  if (target.stage !== 'translation_work' || target.language !== 'zh') {
    return undefined;
  }
  if (context.command === 'commit') {
    return `Run rajio check ${context.target ?? '<session>'} --stage translation --language ja to inspect Japanese QA.`;
  }
  return 'Use --language ja to inspect Japanese QA.';
}

function resolveExplicitStageQaTarget(stage: CheckStageFilter): StageName | undefined {
  if (stage === 'transcript' || stage === 'transcript_work') {
    return 'transcript_work';
  }
  if (stage === 'translation' || stage === 'translation_work') {
    return 'translation_work';
  }
  return undefined;
}

function resolveCurrentStageQaTarget(stage: CurrentStageName | undefined): StageName | undefined {
  if (stage === 'transcript_work') {
    return 'transcript_work';
  }
  if (stage === 'translation_work' || stage === 'export' || stage === 'done') {
    return 'translation_work';
  }
  return undefined;
}

function matchesQaTarget(issue: CheckIssue, target: CheckQaTarget): boolean {
  if (!target.stage || !target.language || issue.stage !== target.stage || !issue.code) {
    return false;
  }
  if (isLanguageNeutralQaCode(issue.code)) {
    return true;
  }
  if (target.language === 'ja') {
    return issue.code.startsWith('ja_');
  }
  return issue.code.startsWith('zh_');
}

function isLanguageNeutralQaCode(code: string): boolean {
  return code.startsWith('duration_') || code.startsWith('subtitle_gap_');
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

function formatCheckJsonFile(file: string, sessionDir: string | undefined): string {
  return sessionDir ? toSessionRelative(sessionDir, file) : file;
}

function formatJson(value: unknown, pretty: boolean | undefined): string {
  return pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
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
