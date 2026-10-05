import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { TextDecoder } from 'node:util';

import type { breadc } from 'breadc';
import { numberInput, countInput, manualStageInput, issueLevelInput } from '../utils/cast.js';

import type { ManualStageName, Segment } from '../types.js';
import type { CheckIssue, CheckLanguageFilter, CheckRange, CheckScope } from '../session/check.js';
import {
  checkSegmentsData,
  filterCheckIssues,
  formatCheckJson,
  printCheckIssues
} from '../session/check.js';
import {
  applySegmentPatchWithOptions,
  parseSegmentPatch,
  summarizeSegmentPatchResult,
  type SegmentPatch,
  type SegmentPatchResultStats
} from './apply.js';
import {
  deleteSegment,
  editSegment,
  insertSegment,
  loadSegmentEditContext,
  mergeSegments,
  persistSegmentEdit,
  splitSegment
} from './edit.js';
import { validateSegments } from './index.js';
import { SEGMENT_ISSUE_FILTERS, listSegments } from './list.js';
import {
  formatSegments,
  prepareSegmentOutput,
  printSegments,
  type SegmentOutputIssue
} from './output.js';

type RajioApp = ReturnType<typeof breadc>;
const segmentIssuesHelp = SEGMENT_ISSUE_FILTERS.join(',');
const idsInput = z
  .string()
  .transform((value) => value.split(',').map((id) => id.trim()))
  .pipe(
    z.array(z.string().min(1, '--id must be a comma-separated list of non-empty segment ids.'))
  );
const issuesInput = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((issue) => issue.trim())
      .filter(Boolean)
  )
  .pipe(
    z.array(
      z.enum(SEGMENT_ISSUE_FILTERS, {
        error: `--issues must be a comma-separated list of ${segmentIssuesHelp}.`
      })
    )
  );
const disallowedPatchControlCharacter = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;

export function registerSegmentCommands(app: RajioApp): void {
  app
    .command('segments list', {
      summary: `List editable segments for the current manual stage`,
      details:
        'Choose one filter: --id, --start/--end, or --issues. Pagination may be used alone or with --issues.',
      examples: [
        {
          comment: 'List transcript work segments as JSON.',
          command: 'rajio segments list /path/to/session --stage transcript --json'
        },
        {
          comment: 'Read three neighboring segments on each side of the requested ids.',
          command:
            'rajio segments list /path/to/session --stage transcript --id 12,15,19 --around 3'
        },
        {
          comment: 'Read segments starting in the 600–660 second range.',
          command: 'rajio segments list /path/to/session --stage transcript --start 600 --end 660'
        },
        {
          comment: 'Page through Chinese hard line-length issues after filtering.',
          command:
            'rajio segments list /path/to/session --stage translation --issues zh_line_hard_limit --level error --offset 100 --limit 50'
        }
      ]
    })
    .argument(
      '<target>',
      'Existing session directory, session.toml, description markdown file, or media file.'
    )
    .option(
      '--stage <stage>',
      'transcript reads transcript/work/segments.toml; translation reads translation/work/segments.toml. If omitted, use the current manual stage; error outside transcript_work or translation_work.',
      {
        cast: manualStageInput
      }
    )
    .option(
      '--id <ids>',
      'Comma-separated segment ids in requested order. Entries must be non-empty and trimmed; ids cannot contain commas.',
      { cast: idsInput }
    )
    .option(
      '--around <count>',
      'With --id, include this many neighboring segments on each side, deduplicated in timeline order. Non-negative integer.',
      {
        cast: countInput
      }
    )
    .option(
      '--offset <count>',
      'Zero-based offset after issue filtering. Non-negative integer. Do not combine pagination with --id, --around, or --start/--end.',
      { cast: countInput }
    )
    .option(
      '--limit <count>',
      'Maximum number of segments to list. Non-negative integer; omit to list from offset to the end.',
      { cast: countInput }
    )
    .option('--start <seconds>', 'List segments whose start is in [start, end). Requires --end.', {
      cast: numberInput
    })
    .option('--end <seconds>', 'Exclusive end of the segment-start range. Requires --start.', {
      cast: numberInput
    })
    .option(
      '--issues <issues>',
      'Comma-separated validation codes from rajio check. Use rajio check --help for issue codes. Pagination is applied after issue filtering.',
      {
        cast: issuesInput
      }
    )
    .option(
      '--level <level>',
      'With --issues, filter by severity threshold: fatal, error, or warning (default). error excludes warning-level matches. Japanese QA can match error in translation work even when rajio check reports it as warning.',
      {
        cast: issueLevelInput
      }
    )
    .option(
      '--json',
      'Print { "segments": [...], "stats": {...} }. Rows contain id, start, end, speaker, ja and zh; stats contains total, listed, translated, untranslated. listed counts returned rows; total, translated and untranslated count the entire work file. Without --json: human-readable output on TTY, CSV otherwise.'
    )
    .action(async (target, options) => {
      rejectPassthroughArguments(options);
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
    .command('segments apply', {
      summary: `Apply ordered TOML patch operations`,
      details: `Normal apply writes the patched segments, then runs patch-scoped check feedback. Blocking check issues are reported in the check output but do not change the apply command exit code. Normal apply does not roll back already-written changes.

Allowed skip_checks.code values are:

- ja_line_hard_limit, zh_line_hard_limit
- ja_line_break_can_merge_soft, zh_line_break_can_merge_soft
- ja_line_break_hard_limit, zh_line_break_hard_limit
- duration_too_short, duration_too_long
- ja_reading_speed_limit, zh_reading_speed_limit
- subtitle_gap_too_short
- ja_common_punctuation, zh_common_punctuation
- ja_terminal_punctuation, zh_terminal_punctuation
- ja_punctuation_only_line, zh_punctuation_only_line
- ja_repeated_punctuation, zh_repeated_punctuation

Patch rules:

- A patch must contain at least one [[operations]].
- A patch may include top-level name, summary, created_by, start, and end metadata. summary describes the patch content. To set an explicit check range in source-media seconds, provide both start and end. Otherwise, the range is determined from affected segments.
- Any operation may include reason and confidence; confidence must be high, medium, or low. These metadata fields are informational and do not change apply behavior.
- op = "edit" requires segment_id plus at least one changed field: start, end, speaker, ja, zh, or skip_checks.
- In an edit operation, missing skip_checks preserves existing annotations, skip_checks = [] clears annotations, and a non-empty array replaces annotations exactly. Each skip requires an allowed code and non-empty reason.
- op = "split" replaces source_id with two or more [[operations.replacements]]. gap is optional and defaults to 0.05; values below 0.05 are rejected. Replacement segments use virtual continuous timing: they must cover the original segment continuously with no gaps or overlaps, start at the original start, and end at the original end. Each internal boundary is treated as the midpoint of the inserted gap, so a boundary at 13.2 with gap = 0.05 becomes previous end = 13.175 and next start = 13.225.
- Every generated split segment must remain at least 0.5 seconds long after gap insertion.
- If a split source has zh, every replacement segment must include zh.
- Split replacements do not inherit skip_checks; add a later edit operation for each replacement that needs a fresh skip annotation.
- op = "merge" accepts two or more adjacent source ids in source_ids; merged_id and ja are required. If any source has zh, merged zh is required.
- Merged segments do not inherit skip_checks; add a later edit operation when the merged text still has an intentional QA exception.
- op = "insert" requires segment_id, start, end, speaker, and ja; translation work also requires zh. Insertions are placed by start time and are rejected if they duplicate an id, have invalid time or empty required text, or overlap an immediate neighbor.
- op = "delete" requires only segment_id.
- Current segment ids must be unique after every operation.`,
      examples: [
        {
          comment: 'Validate the patch and preview check feedback without writing changes.',
          command: 'rajio segments apply /path/to/session patch.toml --stage translation --dry-run'
        },
        {
          comment: 'Apply a TOML patch supplied directly through stdin.',
          command: `printf '%s\\n' '[[operations]]' 'op = "edit"' \\
  'segment_id = "12"' 'zh = "修正后的中文字幕"' \\
  | rajio segments apply /path/to/session --stage translation`
        },
        {
          comment: 'Preview the patch and extract remaining issues from verbose JSON.',
          command: `rajio segments apply /path/to/session patch.toml --stage translation --dry-run --verbose --json \\
  | jq '.segments[] | select(.issues | length > 0) | {id, start, end, affected, issues}'`
        },
        {
          comment: 'Patch example: save as patch.toml; adapt ids and timing to the session.',
          command: `\`\`\`toml
name = "Translation fixes"
summary = "Batch edits for the first review pass."
created_by = "worker-a"

[[operations]]
op = "edit"
reason = "Use the agreed translation for the title."
confidence = "high"
segment_id = "12"
zh = "修正后的中文字幕"

[[operations]]
op = "edit"
segment_id = "title"
[[operations.skip_checks]]
code = "zh_repeated_punctuation"
reason = "Official title spelling."

[[operations.skip_checks]]
code = "zh_line_hard_limit"
reason = "Official title should stay on one line."

[[operations]]
op = "split"
source_id = "long"
gap = 0.05

[[operations.replacements]]
segment_id = "long.1"
start = 10.0
end = 13.2
speaker = "A"
ja = "前半の日本語"
zh = "前半中文字幕"

[[operations.replacements]]
segment_id = "long.2"
start = 13.2
end = 16.0
speaker = "A"
ja = "後半の日本語"
zh = "后半中文字幕"

[[operations]]
op = "merge"
source_ids = ["13.1", "13.2"]
merged_id = "13"
speaker = "A,B"
ja = "結合した日本語"
zh = "合并后的中文字幕"

[[operations]]
op = "insert"
segment_id = "13.5"
start = 16.2
end = 17.0
speaker = "A"
ja = "追加された字幕"
zh = "新增字幕"

[[operations]]
op = "delete"
segment_id = "14"
\`\`\``
        }
      ]
    })
    .argument(
      '<target>',
      'Existing session directory, session.toml, description markdown file, or media file.'
    )
    .argument('[file]', 'TOML patch file; omit only when supplying stdin in the same command.')
    .option(
      '--stage <stage>',
      'transcript edits transcript/work/segments.toml; translation edits translation/work/segments.toml. If omitted, use the current manual stage; error outside transcript_work or translation_work.',
      {
        cast: manualStageInput
      }
    )
    .option(
      '--dry-run',
      'Simulate applying the patch without writing segments.toml. Default output prints an operation summary and a check summary; --verbose previews segment rows instead. With --json, summaries are always included.'
    )
    .option(
      '--verbose',
      'Print affected segments plus segments with remaining issues in the check scope. Without --json, rows replace the summaries and have AFFECTED and ISSUES columns. With --json, rows are added to the summaries; each row has affected, and issues only when problems remain.'
    )
    .option(
      '--json',
      'Print apply and check objects. apply contains dry_run and operation stats; check contains ok, range, scope, counts and summary. Add --verbose to include segments.'
    )
    .action(async (target, file, options) => {
      rejectApplyPatchAsTarget(target, file);
      const output = prepareSegmentOutput({ json: Boolean(options.json) });
      const context = await loadSegmentEditContext({
        sessionTarget: target,
        stage: options.stage
      });
      const patch = parseSegmentPatch(await readPatchInput(file));
      const beforeSegments = context.file.segments;
      const result = applySegmentPatchWithOptions(context.file, patch, {
        requireZhForInserts: context.stage === 'translation_work'
      });
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
          output.writer.write(`check passed.
`);
        }
      }
    });

  app
    .command('segments edit', {
      summary: `Edit fields on one segment`,
      details:
        'At least one editable field or --clear-skip-checks is required. Ordinary edits preserve existing skip_checks.',
      examples: [
        {
          comment: 'Correct Japanese text, speaker, and timing on one segment.',
          command: `rajio segments edit /path/to/session 12 --stage transcript \\
  --start 10.2 --end 13.4 --speaker A --ja "修正した日本語"`
        },
        {
          comment: 'Preview a Chinese text edit without writing changes.',
          command: `rajio segments edit /path/to/session 12 --stage translation \\
  --zh "修正后的中文字幕" --dry-run`
        },
        {
          comment: 'Remove stale skip_checks annotations from one segment.',
          command: 'rajio segments edit /path/to/session 12 --stage translation --clear-skip-checks'
        }
      ]
    })
    .argument(
      '<target>',
      'Existing session directory, session.toml, description markdown file, or media file.'
    )
    .argument('<id>', 'Nonempty, trimmed segment id without commas.')
    .option(
      '--stage <stage>',
      'transcript edits transcript/work/segments.toml; translation edits translation/work/segments.toml. If omitted, use the current manual stage; error outside transcript_work or translation_work.',
      {
        cast: manualStageInput
      }
    )
    .option('--start <seconds>', 'segment start time in seconds', { cast: numberInput })
    .option('--end <seconds>', 'segment end time in seconds', { cast: numberInput })
    .option('--speaker <speaker>', 'segment speaker')
    .option('--ja <text>', 'Japanese subtitle text')
    .option('--zh <text>', 'Chinese subtitle text')
    .option('--clear-skip-checks', 'Remove stale skip_checks annotations from this segment.')
    .option('--dry-run', 'Preview the edited segment without writing segments.toml.')
    .option(
      '--json',
      'Print { "segments": [...] } with id, start, end, speaker, ja, and zh. Without --json: human-readable output on TTY, CSV otherwise.'
    )
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
    .command('segments insert', {
      summary: `Insert one segment by timeline position`,
      details:
        'The new segment is placed before the first existing segment with a later start time, or appended at the end. Inserts are rejected when they duplicate an id, have invalid time or empty required text, or overlap an immediate neighbor.',
      examples: [
        {
          comment: 'Insert a Japanese segment by timeline position.',
          command: `rajio segments insert /path/to/session 12.5 --stage transcript \\
  --start 42.0 --end 43.2 --speaker A --ja "追加された字幕"`
        },
        {
          comment: 'Preview a bilingual insertion in translation work.',
          command: `rajio segments insert /path/to/session 12.5 --stage translation \\
  --start 42.0 --end 43.2 --speaker A \\
  --ja "追加された字幕" --zh "新增字幕" --dry-run`
        }
      ]
    })
    .argument(
      '<target>',
      'Existing session directory, session.toml, description markdown file, or media file.'
    )
    .argument('<id>', 'Nonempty, trimmed segment id without commas.')
    .option(
      '--stage <stage>',
      'transcript edits transcript/work/segments.toml; translation edits translation/work/segments.toml. If omitted, use the current manual stage; error outside transcript_work or translation_work.',
      {
        cast: manualStageInput
      }
    )
    .option('--start <seconds>', 'Required segment start time in seconds.', { cast: numberInput })
    .option('--end <seconds>', 'Required segment end time in seconds.', { cast: numberInput })
    .option('--speaker <speaker>', 'Required segment speaker.')
    .option('--ja <text>', 'Required Japanese subtitle text.')
    .option('--zh <text>', 'Chinese subtitle text; required for translation work.')
    .option('--dry-run', 'Preview the inserted segment without writing segments.toml.')
    .option(
      '--json',
      'Print { "segments": [...] } with id, start, end, speaker, ja, and zh. Without --json: human-readable output on TTY, CSV otherwise.'
    )
    .action(async (target, id, options) => {
      const output = prepareSegmentOutput({ json: Boolean(options.json) });
      const context = await loadSegmentEditContext({
        sessionTarget: target,
        stage: options.stage
      });
      const segment = insertSegment(context.file, {
        id,
        start: requireNumberOption(options.start, '--start'),
        end: requireNumberOption(options.end, '--end'),
        speaker: requireOption(options.speaker, '--speaker'),
        ja: requireOption(options.ja, '--ja'),
        zh: options.zh,
        requireZh: context.stage === 'translation_work'
      });
      await persistUnlessDryRun(context, Boolean(options.dryRun));
      printSegments([segment], output, { totalDuration: getTotalDuration(context.file.segments) });
    });

  app
    .command('segments split', {
      summary: `Split one segment into two adjacent segments`,
      details:
        'Both generated segments must remain at least 0.5 seconds long. New segments do not inherit skip_checks; use segments apply to add reviewed exceptions or split into more than two segments.',
      examples: [
        {
          comment: 'Split a segment at the gap midpoint with separate text and speakers.',
          command: `rajio segments split /path/to/session 12 --stage transcript \\
  --at 11.8 --gap 0.05 --id1 12.1 --id2 12.2 \\
  --ja1 "前半の日本語" --ja2 "後半の日本語" \\
  --speaker1 A --speaker2 B`
        }
      ]
    })
    .argument(
      '<target>',
      'Existing session directory, session.toml, description markdown file, or media file.'
    )
    .argument('<id>', 'Nonempty, trimmed segment id without commas.')
    .option(
      '--stage <stage>',
      'transcript edits transcript/work/segments.toml; translation edits translation/work/segments.toml. If omitted, use the current manual stage; error outside transcript_work or translation_work.',
      {
        cast: manualStageInput
      }
    )
    .option(
      '--at <seconds>',
      'Required midpoint of the inserted gap. First segment ends at at - gap / 2; second starts at at + gap / 2.',
      { cast: numberInput }
    )
    .option(
      '--gap <seconds>',
      'Gap to insert around the midpoint. Default 0.05; values below 0.05 are rejected.',
      {
        cast: numberInput
      }
    )
    .option(
      '--id1 <id>',
      'Required first segment id; must differ from id2 and not conflict with other ids.'
    )
    .option(
      '--id2 <id>',
      'Required second segment id; must differ from id1 and not conflict with other ids.'
    )
    .option('--ja1 <text>', 'Required first Japanese subtitle text.')
    .option('--ja2 <text>', 'Required second Japanese subtitle text.')
    .option('--speaker1 <speaker>', 'First segment speaker; defaults to the source speaker.')
    .option('--speaker2 <speaker>', 'Second segment speaker; defaults to the source speaker.')
    .option('--zh1 <text>', 'First Chinese subtitle text; required when the source has zh.')
    .option('--zh2 <text>', 'Second Chinese subtitle text; required when the source has zh.')
    .option('--dry-run', 'Preview the split segments without writing segments.toml.')
    .option(
      '--json',
      'Print { "segments": [...] } with id, start, end, speaker, ja, and zh. Without --json: human-readable output on TTY, CSV otherwise.'
    )
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
    .command('segments merge', {
      summary: `Merge two adjacent segments`,
      details:
        'The two source ids must be adjacent in file order. The merged segment does not inherit skip_checks; use segments apply to add reviewed exceptions or merge more than two segments.',
      examples: [
        {
          comment: 'Merge two adjacent segments with reviewed text and a combined speaker.',
          command: `rajio segments merge /path/to/session 12.1 12.2 --stage transcript \\
  --id 12 --ja "結合した日本語" --speaker A,B`
        }
      ]
    })
    .argument(
      '<target>',
      'Existing session directory, session.toml, description markdown file, or media file.'
    )
    .argument('<id1>', 'Nonempty, trimmed segment id without commas.')
    .argument('<id2>', 'Nonempty, trimmed segment id without commas.')
    .option(
      '--stage <stage>',
      'transcript edits transcript/work/segments.toml; translation edits translation/work/segments.toml. If omitted, use the current manual stage; error outside transcript_work or translation_work.',
      {
        cast: manualStageInput
      }
    )
    .option(
      '--id <id>',
      'Required merged segment id. Must not conflict with another id except the two sources.'
    )
    .option('--ja <text>', 'Required merged Japanese subtitle text.')
    .option(
      '--speaker <speaker>',
      'Merged speaker; defaults to a comma-separated de-duplicated list of source speakers.'
    )
    .option('--zh <text>', 'Merged Chinese subtitle text; required if either source has zh.')
    .option('--dry-run', 'Preview the merged segment without writing segments.toml.')
    .option(
      '--json',
      'Print { "segments": [...] } with id, start, end, speaker, ja, and zh. Without --json: human-readable output on TTY, CSV otherwise.'
    )
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
    .command('segments delete', {
      summary: `Delete one segment`,
      details:
        'Prints the removed row. Use this only for semantically empty filler or unwanted subtitle units, not for uncertain ASR text that should be corrected or merged.',
      examples: [
        {
          comment: 'Remove a semantically empty or unwanted subtitle unit.',
          command: 'rajio segments delete /path/to/session 13 --stage transcript'
        }
      ]
    })
    .argument(
      '<target>',
      'Existing session directory, session.toml, description markdown file, or media file.'
    )
    .argument('<id>', 'Nonempty, trimmed segment id without commas.')
    .option(
      '--stage <stage>',
      'transcript edits transcript/work/segments.toml; translation edits translation/work/segments.toml. If omitted, use the current manual stage; error outside transcript_work or translation_work.',
      {
        cast: manualStageInput
      }
    )
    .option('--dry-run', 'Preview the deleted segment without writing segments.toml.')
    .option(
      '--json',
      'Print { "segments": [...] } with id, start, end, speaker, ja, and zh. Without --json: human-readable output on TTY, CSV otherwise.'
    )
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
    } else if (operation.op === 'insert') {
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
  )}, ${stats.merges} ${plural(stats.merges, 'merge')}, ${stats.inserts} ${plural(
    stats.inserts,
    'insert'
  )}, ${stats.deletes} ${plural(stats.deletes, 'delete')}.`;
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

function rejectPassthroughArguments(options: { '--'?: string[] }): void {
  if (options['--']?.length) {
    throw new Error(`Unexpected argument: ${options['--'][0]}`);
  }
}

function rejectApplyPatchAsTarget(target: string, file: string | undefined): void {
  if (file !== undefined || target.split(/[\\/]/u).at(-1) === 'session.toml') {
    return;
  }
  if (target.toLowerCase().endsWith('.toml')) {
    throw new Error(
      [
        'segments apply is missing a session target.',
        'Use: rajio segments apply <target> <patch.toml> [options]',
        `Received patch path as <target>: ${target}`
      ].join(`
`)
    );
  }
}

async function readPatchInput(file: string | undefined): Promise<string> {
  if (file) {
    return decodePatchInput(await readFile(file), `patch file ${file}`);
  }
  return decodePatchInput(await readStdinBytes(), 'patch stdin input');
}

function decodePatchInput(input: Uint8Array, source: string): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(input);
  } catch {
    throw new Error(`${source} must be valid UTF-8.`);
  }
  if (text.includes('\uFFFD')) {
    throw new Error(`${source} contains suspicious replacement character U+FFFD.`);
  }
  const match = text.match(disallowedPatchControlCharacter);
  if (match) {
    const code = match[0]!.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0');
    throw new Error(`${source} contains disallowed control character U+${code}.`);
  }
  return text;
}

async function readStdinBytes(): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}
