import { readFile } from 'node:fs/promises';

import type { UnknownOptionMiddleware, breadc } from 'breadc';

import type { Segment } from '../types.js';
import { applySegmentPatch, parseSegmentPatch, summarizeSegmentPatchResult } from './apply.js';
import {
  deleteSegment,
  editSegment,
  loadSegmentEditContext,
  mergeSegments,
  persistSegmentEdit,
  splitSegment,
  type SegmentEditStage
} from './edit.js';
import { SEGMENT_ISSUE_FILTERS, listSegments } from './list.js';
import type { SegmentIssueFilter } from './list.js';
import { prepareSegmentOutput, printSegmentPatchStats, printSegments } from './output.js';

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
        issues: options.issues
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
      const result = applySegmentPatch(context.file, patch);
      if (!options.dryRun) {
        await persistSegmentEdit(context);
      }
      if (!options.verbose) {
        printSegmentPatchStats(summarizeSegmentPatchResult(patch), output);
        return;
      }
      printSegments(result.affected, output, {
        totalDuration: getTotalDuration(context.file.segments)
      });
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
        zh: options.zh
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
