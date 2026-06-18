import { readFile } from 'node:fs/promises';

import type { UnknownOptionMiddleware, breadc } from 'breadc';

import type { IssueLevel, ManualStageName, Segment } from '../types.js';
import type { CheckIssue, CheckLanguageFilter, CheckRange, CheckScope } from '../session/check.js';
import {
  checkSegmentsData,
  filterCheckIssues,
  formatCheckJson,
  printCheckIssues
} from '../session/check.js';
import {
  applySegmentPatch,
  parseSegmentPatch,
  summarizeSegmentPatchResult,
  type SegmentPatch,
  type SegmentPatchResultStats
} from './apply.js';
import {
  deleteSegment,
  editSegment,
  loadSegmentEditContext,
  mergeSegments,
  persistSegmentEdit,
  splitSegment,
  type SegmentEditStage
} from './edit.js';
import { validateSegments } from './index.js';
import { SEGMENT_ISSUE_FILTERS, listSegments } from './list.js';
import type { SegmentIssueFilter } from './list.js';
import {
  formatSegments,
  prepareSegmentOutput,
  printSegments,
  type SegmentOutputIssue
} from './output.js';

type RajioApp = ReturnType<typeof breadc>;
const segmentIssuesHelp = SEGMENT_ISSUE_FILTERS.join(',');
const rejectUnknownOption: UnknownOptionMiddleware = (_context, key) => {
  throw new Error(`Unknown option: --${key}`);
};

export function registerSegmentCommands(app: RajioApp): void {
  app
    .command('segments list <target>', 'List editable segments for the current manual stage')
    .option('--stage <stage>', 'manual stage: transcript or translation', {
      cast: castSegmentStage
    })
    .option('--id <id>', 'filter by segment id')
    .option('--around <count>', 'with one --id, include this many neighboring segments', {
      cast: castCount
    })
    .option('--offset <count>', 'start listing at zero-based segment offset', { cast: castCount })
    .option('--limit <count>', 'maximum number of segments to list', { cast: castCount })
    .option('--start <seconds>', 'list segments whose start time is at or after this time', {
      cast: castNumber
    })
    .option('--end <seconds>', 'list segments whose start time is before this time', {
      cast: castNumber
    })
    .option('--issues <issues>', `filter by issue types: ${segmentIssuesHelp}`, {
      cast: castIssues
    })
    .option('--level <level>', 'with --issues, filter by level: fatal, error, or warning', {
      cast: castIssueLevel
    })
    .option('--json', 'print JSON output')
    .allowUnknownOption(rejectUnknownOption)
    .action(async (target, options) => {
      rejectUnexpectedArguments(options);
      const output = prepareSegmentOutput({ json: Boolean(options.json) });
      const context = await loadSegmentEditContext({
        sessionTarget: target,
        stage: options.stage
      });
      const segments = listSegments(context.file.segments, {
        id: options.id,
        around: options.around,
        offset: options.offset,
        limit: options.limit,
        start: options.start,
        end: options.end,
        issues: options.issues,
        level: options.level,
        validationIssues:
          options.issues === undefined
            ? undefined
            : validateSegments(context.file, { requireZh: context.stage === 'translation_work' })
      });
      printSegments(segments, output, {
        totalDuration: getTotalDuration(context.file.segments),
        stats: getSegmentStats(context.file.segments, segments)
      });
    });

  app
    .command(
      'segments apply <target> [file]',
      'Apply a TOML patch of batch edit, split, merge, and delete operations'
    )
    .option('--stage <stage>', 'manual stage: transcript or translation', {
      cast: castSegmentStage
    })
    .option('--dry-run', 'validate the patch without writing segments.toml')
    .option('--verbose', 'print affected segment rows')
    .option('--json', 'print JSON output')
    .allowUnknownOption(rejectUnknownOption)
    .action(async (target, file, options) => {
      const output = prepareSegmentOutput({ json: Boolean(options.json) });
      const context = await loadSegmentEditContext({
        sessionTarget: target,
        stage: options.stage
      });
      const patch = parseSegmentPatch(await readPatchInput(file));
      const beforeSegments = context.file.segments;
      const result = applySegmentPatch(context.file, patch);
      const stats = summarizeSegmentPatchResult(patch);
      const range = resolveApplyCheckRange(patch, result.affected);
      const languages = resolveApplyCheckLanguages(context.stage, patch);
      const scope = applyCheckScope(context.stage, languages);
      if (!options.dryRun) {
        await persistSegmentEdit(context);
      }
      const issues = filterApplyCheckIssues({
        filePath: context.filePath,
        file: context.file,
        stage: context.stage,
        languages,
        range,
        includeSegmentIds:
          patch.start === undefined && patch.end === undefined
            ? collectApplyCheckSegmentIds(beforeSegments, context.file.segments, result.affected)
            : undefined
      });
      const issuesBySegment = groupIssuesBySegment(issues);
      const affectedSegmentIds = new Set(result.affected.map((segment) => segment.id));
      const verboseSegments = options.verbose
        ? collectApplyVerboseSegments(context.file.segments, result.affected, issuesBySegment)
        : undefined;
      if (options.json) {
        printApplyJson({
          output,
          dryRun: Boolean(options.dryRun),
          stats,
          range,
          scope,
          issues,
          segments: verboseSegments,
          affectedSegmentIds,
          issuesBySegment,
          sessionDir: context.session.dir
        });
      } else if (options.verbose) {
        output.writer.write(
          `${formatSegments(verboseSegments ?? [], output.format, {
            totalDuration: getTotalDuration(context.file.segments),
            issuesBySegment,
            affectedSegmentIds
          })}\n`
        );
      } else {
        output.writer.write(`${formatApplySummary(stats, Boolean(options.dryRun))}\n`);
        printCheckIssues(issues, {
          verbose: false,
          logger: outputLogger(output.writer) as never,
          scope,
          range
        });
        if (!hasBlockingIssues(issues)) {
          output.writer.write('check passed.\n');
        }
      }
    });

  app
    .command('segments edit <target> <id>', 'Edit fields on one segment')
    .option('--stage <stage>', 'manual stage: transcript or translation', {
      cast: castSegmentStage
    })
    .option('--start <seconds>', 'segment start time in seconds', { cast: castNumber })
    .option('--end <seconds>', 'segment end time in seconds', { cast: castNumber })
    .option('--speaker <speaker>', 'segment speaker')
    .option('--ja <text>', 'Japanese subtitle text')
    .option('--zh <text>', 'Chinese subtitle text')
    .option('--clear-skip-checks', 'remove skip_checks annotations from this segment')
    .option('--dry-run', 'validate and print the edited segment without writing segments.toml')
    .option('--json', 'print JSON output')
    .allowUnknownOption(rejectUnknownOption)
    .action(async (target, id, options) => {
      const output = prepareSegmentOutput({ json: Boolean(options.json) });
      const context = await loadSegmentEditContext({
        sessionTarget: target,
        stage: options.stage
      });
      const segment = editSegment(context.file, id, {
        start: options.start,
        end: options.end,
        speaker: options.speaker,
        ja: options.ja,
        zh: options.zh,
        clearSkipChecks: Boolean(options.clearSkipChecks)
      });
      await persistUnlessDryRun(context, Boolean(options.dryRun));
      printSegments([segment], output, { totalDuration: getTotalDuration(context.file.segments) });
    });

  app
    .command('segments split <target> <id>', 'Split one segment into two adjacent segments')
    .option('--stage <stage>', 'manual stage: transcript or translation', {
      cast: castSegmentStage
    })
    .option('--at <seconds>', 'split gap midpoint in seconds', { cast: castNumber })
    .option('--gap <seconds>', 'gap to insert around the split midpoint in seconds', {
      cast: castNumber
    })
    .option('--id1 <id>', 'first segment id')
    .option('--id2 <id>', 'second segment id')
    .option('--ja1 <text>', 'first Japanese subtitle text')
    .option('--ja2 <text>', 'second Japanese subtitle text')
    .option('--speaker1 <speaker>', 'first segment speaker')
    .option('--speaker2 <speaker>', 'second segment speaker')
    .option('--zh1 <text>', 'first Chinese subtitle text')
    .option('--zh2 <text>', 'second Chinese subtitle text')
    .option('--dry-run', 'validate and print the split segments without writing segments.toml')
    .option('--json', 'print JSON output')
    .allowUnknownOption(rejectUnknownOption)
    .action(async (target, id, options) => {
      const output = prepareSegmentOutput({ json: Boolean(options.json) });
      const context = await loadSegmentEditContext({
        sessionTarget: target,
        stage: options.stage
      });
      const segments = splitSegment(context.file, id, {
        at: requireNumberOption(options.at, '--at'),
        id1: requireOption(options.id1, '--id1'),
        id2: requireOption(options.id2, '--id2'),
        ja1: requireOption(options.ja1, '--ja1'),
        ja2: requireOption(options.ja2, '--ja2'),
        speaker1: options.speaker1,
        speaker2: options.speaker2,
        zh1: options.zh1,
        zh2: options.zh2,
        gap: options.gap
      });
      await persistUnlessDryRun(context, Boolean(options.dryRun));
      printSegments(segments, output, { totalDuration: getTotalDuration(context.file.segments) });
    });

  app
    .command('segments merge <target> <id1> <id2>', 'Merge two adjacent segments')
    .option('--stage <stage>', 'manual stage: transcript or translation', {
      cast: castSegmentStage
    })
    .option('--id <id>', 'merged segment id')
    .option('--ja <text>', 'merged Japanese subtitle text')
    .option('--speaker <speaker>', 'merged segment speaker')
    .option('--zh <text>', 'merged Chinese subtitle text')
    .option('--dry-run', 'validate and print the merged segment without writing segments.toml')
    .option('--json', 'print JSON output')
    .allowUnknownOption(rejectUnknownOption)
    .action(async (target, id1, id2, options) => {
      const output = prepareSegmentOutput({ json: Boolean(options.json) });
      const context = await loadSegmentEditContext({
        sessionTarget: target,
        stage: options.stage
      });
      const segment = mergeSegments(context.file, id1, id2, {
        id: requireOption(options.id, '--id'),
        ja: requireOption(options.ja, '--ja'),
        speaker: options.speaker,
        zh: options.zh
      });
      await persistUnlessDryRun(context, Boolean(options.dryRun));
      printSegments([segment], output, { totalDuration: getTotalDuration(context.file.segments) });
    });

  app
    .command('segments delete <target> <id>', 'Delete one segment')
    .option('--stage <stage>', 'manual stage: transcript or translation', {
      cast: castSegmentStage
    })
    .option('--dry-run', 'validate and print the deleted segment without writing segments.toml')
    .option('--json', 'print JSON output')
    .allowUnknownOption(rejectUnknownOption)
    .action(async (target, id, options) => {
      const output = prepareSegmentOutput({ json: Boolean(options.json) });
      const context = await loadSegmentEditContext({
        sessionTarget: target,
        stage: options.stage
      });
      const segment = deleteSegment(context.file, id);
      const totalDuration = getTotalDuration([...context.file.segments, segment]);
      await persistUnlessDryRun(context, Boolean(options.dryRun));
      printSegments([segment], output, { totalDuration });
    });
}

function resolveApplyCheckRange(patch: SegmentPatch, affected: Segment[]): CheckRange {
  if (patch.start !== undefined && patch.end !== undefined) {
    return { start: patch.start, end: patch.end };
  }
  return {
    start: Math.min(...affected.map((segment) => segment.start)),
    end: Math.max(...affected.map((segment) => segment.end))
  };
}

function resolveApplyCheckLanguages(
  stage: ManualStageName,
  patch: SegmentPatch
): CheckLanguageFilter[] {
  if (stage === 'transcript_work') {
    return ['ja'];
  }

  const languages = new Set<CheckLanguageFilter>();
  for (const operation of patch.operations) {
    if (operation.op === 'edit') {
      if (operation.ja !== undefined) {
        languages.add('ja');
      }
      if (operation.zh !== undefined) {
        languages.add('zh');
      }
      for (const skip of operation.skip_checks ?? []) {
        if (skip.code.startsWith('ja_')) {
          languages.add('ja');
        } else if (skip.code.startsWith('zh_')) {
          languages.add('zh');
        }
      }
    } else if (operation.op === 'split') {
      languages.add('ja');
      if (operation.replacements.some((segment) => segment.zh !== undefined)) {
        languages.add('zh');
      }
    } else if (operation.op === 'merge') {
      languages.add('ja');
      if (operation.zh !== undefined) {
        languages.add('zh');
      }
    }
  }
  return languages.size > 0 ? Array.from(languages).sort() : ['zh'];
}

function filterApplyCheckIssues(input: {
  filePath: string;
  file: { source: { kind: 'transcript' | 'translation' }; segments: Segment[] };
  stage: ManualStageName;
  languages: CheckLanguageFilter[];
  range: CheckRange;
  includeSegmentIds?: Set<string>;
}): CheckIssue[] {
  const allIssues = checkSegmentsData(input.filePath, input.file);
  const issues = input.languages.flatMap((language) =>
    filterCheckIssues(allIssues, {
      currentStage: input.stage,
      language
    }).filter((issue) => matchesApplyCheckScope(issue, input.range, input.includeSegmentIds))
  );
  return dedupeIssues(issues);
}

function matchesApplyCheckScope(
  issue: CheckIssue,
  range: CheckRange,
  includeSegmentIds: Set<string> | undefined
): boolean {
  if (issue.segmentId && includeSegmentIds?.has(issue.segmentId)) {
    return true;
  }
  if (!issue.segment) {
    return issue.level === 'fatal';
  }
  return issue.segment.end > range.start && issue.segment.start < range.end;
}

function collectApplyCheckSegmentIds(
  beforeSegments: Segment[],
  currentSegments: Segment[],
  affected: Segment[]
): Set<string> {
  const ids = new Set(affected.map((segment) => segment.id));
  addNeighborSegmentIds(ids, beforeSegments);
  addNeighborSegmentIds(ids, currentSegments);
  return ids;
}

function addNeighborSegmentIds(ids: Set<string>, segments: Segment[]): void {
  const affectedIds = new Set(ids);
  for (const [index, segment] of segments.entries()) {
    if (!affectedIds.has(segment.id)) {
      continue;
    }
    const previous = segments[index - 1];
    const next = segments[index + 1];
    if (previous) {
      ids.add(previous.id);
    }
    if (next) {
      ids.add(next.id);
    }
  }
}

function applyCheckScope(stage: ManualStageName, languages: CheckLanguageFilter[]): CheckScope {
  return {
    level: 'warning',
    stage,
    languages,
    description: `${stage} ${languages.join('+')} QA`
  };
}

function dedupeIssues(issues: CheckIssue[]): CheckIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = [
      issue.file,
      issue.stage ?? '',
      issue.level,
      issue.code ?? '',
      issue.segmentId ?? '',
      issue.message
    ].join('\0');
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function groupIssuesBySegment(issues: CheckIssue[]): Map<string, SegmentOutputIssue[]> {
  const groups = new Map<string, SegmentOutputIssue[]>();
  for (const issue of issues) {
    if (!issue.segmentId) {
      continue;
    }
    groups.set(issue.segmentId, [
      ...(groups.get(issue.segmentId) ?? []),
      { level: issue.level, code: issue.code, message: issue.message }
    ]);
  }
  return groups;
}

function collectApplyVerboseSegments(
  currentSegments: Segment[],
  affected: Segment[],
  issuesBySegment: Map<string, SegmentOutputIssue[]>
): Segment[] {
  const rows: Segment[] = [];
  const seen = new Set<string>();
  const push = (segment: Segment) => {
    if (!seen.has(segment.id)) {
      rows.push(segment);
      seen.add(segment.id);
    }
  };
  affected.forEach(push);
  currentSegments.filter((segment) => issuesBySegment.has(segment.id)).forEach(push);
  return rows;
}

function printApplyJson(input: {
  output: ReturnType<typeof prepareSegmentOutput>;
  dryRun: boolean;
  stats: SegmentPatchResultStats;
  range: CheckRange;
  scope: CheckScope;
  issues: CheckIssue[];
  segments?: Segment[];
  affectedSegmentIds: Set<string>;
  issuesBySegment: Map<string, SegmentOutputIssue[]>;
  sessionDir: string;
}): void {
  const check = JSON.parse(
    formatCheckJson(input.issues, {
      verbose: input.segments !== undefined,
      sessionDir: input.sessionDir,
      scope: input.scope,
      range: input.range,
      countIssues: input.issues,
      pretty: false
    })
  ) as Record<string, unknown>;
  const output = {
    apply: {
      dry_run: input.dryRun,
      stats: input.stats
    },
    check,
    ...(input.segments
      ? {
          segments: input.segments.map((segment) =>
            segmentJson(segment, input.issuesBySegment, input.affectedSegmentIds)
          )
        }
      : {})
  };
  input.output.writer.write(`${JSON.stringify(output, null, input.output.jsonPretty ? 2 : 0)}\n`);
}

function segmentJson(
  segment: Segment,
  issuesBySegment: Map<string, SegmentOutputIssue[]>,
  affectedSegmentIds: Set<string>
) {
  return {
    id: segment.id,
    start: segment.start,
    end: segment.end,
    speaker: segment.speaker,
    ja: segment.ja,
    zh: segment.zh ?? '',
    affected: affectedSegmentIds.has(segment.id),
    issues: issuesBySegment.get(segment.id) ?? []
  };
}

function formatApplySummary(stats: SegmentPatchResultStats, dryRun: boolean): string {
  const prefix = dryRun ? 'dry-run apply' : 'apply';
  return `${prefix}: ${stats.edits} ${plural(stats.edits, 'edit')}, ${stats.splits} ${plural(
    stats.splits,
    'split'
  )}, ${stats.merges} ${plural(stats.merges, 'merge')}, ${stats.deletes} ${plural(
    stats.deletes,
    'delete'
  )}.`;
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

function outputLogger(writer: { write(chunk: string): unknown }) {
  const write = (message: string) => writer.write(`${message}\n`);
  return { info: write, warn: write, error: write };
}

function hasBlockingIssues(issues: CheckIssue[]): boolean {
  return issues.some((issue) => issue.level === 'fatal' || issue.level === 'error');
}

async function persistUnlessDryRun(
  context: Awaited<ReturnType<typeof loadSegmentEditContext>>,
  dryRun: boolean
): Promise<void> {
  if (!dryRun) {
    await persistSegmentEdit(context);
  }
}

function getTotalDuration(segments: Segment[]): number {
  return Math.max(0, ...segments.map((segment) => segment.end).filter(Number.isFinite));
}

function getSegmentStats(allSegments: Segment[], listedSegments: Segment[]) {
  const translated = allSegments.filter((segment) => segment.zh?.trim()).length;
  return {
    total: allSegments.length,
    listed: listedSegments.length,
    translated,
    untranslated: allSegments.length - translated
  };
}

function castSegmentStage(value: string | undefined): SegmentEditStage | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === 'transcript' || value === 'translation') {
    return value;
  }
  throw new Error('--stage must be "transcript" or "translation".');
}

function castNumber(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`expected a number, got: ${value}`);
  }
  return number;
}

function castCount(value: string | undefined): number | undefined {
  const number = castNumber(value);
  if (number !== undefined && !Number.isInteger(number)) {
    throw new Error(`expected an integer, got: ${value}`);
  }
  return number;
}

function castIssues(value: string | undefined): SegmentIssueFilter[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const issues = value
    .split(',')
    .map((issue) => issue.trim())
    .filter(Boolean);
  const allowed = new Set<string>(SEGMENT_ISSUE_FILTERS);
  for (const issue of issues) {
    if (!allowed.has(issue)) {
      throw new Error(`--issues must be a comma-separated list of ${segmentIssuesHelp}.`);
    }
  }
  return issues as SegmentIssueFilter[];
}

function castIssueLevel(value: string | undefined): IssueLevel | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === 'fatal' || value === 'error' || value === 'warning') {
    return value;
  }
  throw new Error('--level must be "fatal", "error", or "warning".');
}

function requireOption(value: string | undefined, name: string): string {
  if (value === undefined) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function requireNumberOption(value: number | undefined, name: string): number {
  if (value === undefined) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function rejectUnexpectedArguments(options: { '--'?: string[] }): void {
  if (options['--']?.length) {
    throw new Error(`Unexpected argument: ${options['--'][0]}`);
  }
}

async function readPatchInput(file: string | undefined): Promise<string> {
  if (file) {
    return readFile(file, 'utf8');
  }
  return readStdin();
}

async function readStdin(): Promise<string> {
  process.stdin.setEncoding('utf8');
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  return input;
}
