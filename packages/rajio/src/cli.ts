import { fileURLToPath } from 'node:url';

import { breadc } from 'breadc';
import { z } from 'zod';
import { numberInput, issueLevelInput } from './utils/cast.js';

import { registerClipCommands } from './clips/commands.js';
import { registerFrameCommands } from './frames/commands.js';
import { printDoctorChecks, runDoctor } from './doctor.js';
import { rajioDescription, rajioVersion } from './package.js';
import { registerSegmentCommands } from './segments/commands.js';
import {
  checkRajio,
  filterCheckIssues,
  printCheckIssues,
  resolveCheckScope,
  type CheckFilterOptions
} from './session/check.js';
import { Session } from './session/index.js';
import type { CliOptions } from './types.js';
import { STAGES } from './types.js';
import { installBrokenPipeHandler } from './utils/broken-pipe.js';
import { formatCliError } from './utils/cli-error.js';
import { taggedLogger, wrapConsoleLogger } from './utils/logger.js';
import { runRajio } from './workflow/index.js';
import { resolveAudioChunkOptions } from './audio/index.js';

installBrokenPipeHandler();

const app = breadc('rajio', {
  version: rajioVersion,
  description: {
    description: `${rajioDescription}\n\nRun or resume a rajio subtitle session.

For agent workflow and review instructions, read the bundled skill:
${fileURLToPath(new URL('../skills/rajio/SKILL.md', import.meta.url))}

For new sessions, description markdown can set a transcription mapping (provider, model, segmenter) in YAML frontmatter. CLI values override frontmatter; fields absent from both use provider defaults. When switching provider, also specify a matching model. See rajio doctor --help for credentials and tool configuration.

When runtime configuration is needed, rajio loads .env from the command cwd, then from the resolved session directory. Later files override earlier values.`,
    examples: [
      {
        comment: 'Run automatic stages until the next manual stage.',
        command: 'rajio /path/to/session --continue=until-manual'
      },
      {
        comment: 'Commit reviewed manual work and continue to the next manual stage.',
        command: 'rajio /path/to/session --commit --continue=until-manual'
      },
      {
        comment: 'Preserve audio and rerun transcription with new raw checkpoints.',
        command: 'rajio /path/to/session --reset transcript_raw'
      },
      {
        comment: 'Switch an existing session to OpenAI and rerun transcription.',
        command:
          'rajio /path/to/session --reset transcript_raw --transcription-provider openai --transcription-model whisper-1'
      }
    ]
  }
});

app.use(async (_context, next) => {
  wrapConsoleLogger();
  return next();
});

app
  .command('', 'Run or resume a rajio subtitle session')
  .argument(
    '<target>',
    'Session directory, session.toml, description markdown file, or media file. Existing sessions require rajio_version to match the running CLI version. New directory targets initialize from a single description markdown or media file. Ambiguous directories error. Description targets use their parent directory and resolve media frontmatter relative to the markdown file. Media targets use their parent directory and the media file.'
  )
  .option(
    '--media <path>',
    'Invocation-only media override. Saved in session.toml for a new session; existing sessions keep [input].media. A changed media hash invalidates the workflow back to audio.'
  )
  .option(
    '--continue <mode>',
    'until-manual runs automatic stages until the next manual stage (default). step runs at most one automatic stage.',
    {
      default: 'until-manual' as const,
      cast: z.enum(['until-manual', 'step'])
    }
  )
  .option(
    '--commit',
    'Validate and commit the current manual stage, recording the work file hash in session.toml, then continue according to --continue.'
  )
  .option(
    '--reset <stage>',
    `Reset the selected stage and all downstream stages to pending, then rerun them. Rerunning may overwrite existing work files and outputs.
audio: re-extract audio, rerun transcription, invalidate downstream work.
transcript_raw: preserve audio metadata, clear raw checkpoints, rerun ASR and invalidate downstream work.
transcript_work: preserve raw transcript and regenerate transcript/work/segments.toml.
translation_work: preserve clean committed transcript work and regenerate translation/work/segments.toml.
export: preserve clean committed translation work and regenerate outputs.
If media changed, reset audio first.`,
    {
      cast: z.enum(STAGES)
    }
  )
  .option(
    '--chunk-target <seconds>',
    'Target local audio chunk length. Default 600; minimum 60. Target plus boundary search must be at most 1350 seconds.',
    {
      cast: numberInput
    }
  )
  .option(
    '--chunk-boundary-search <seconds>',
    'Seconds around the target cut point to search for silence. Default 90; range 0..300.',
    {
      cast: numberInput
    }
  )
  .option('--chunk-silence-noise <db>', 'ffmpeg silencedetect noise threshold. Default -35.', {
    cast: numberInput
  })
  .option(
    '--chunk-silence-duration <seconds>',
    'ffmpeg silencedetect minimum silence duration. Default 0.4; must be non-negative.',
    {
      cast: numberInput
    }
  )
  .option(
    '--transcription-provider <provider>',
    'ASR provider: elevenlabs (default for new sessions) or openai. Existing sessions reuse their configuration; changes require --reset transcript_raw. When switching provider, also set --transcription-model. ElevenLabs uses the full extracted audio; OpenAI uses local chunks. Audio is uploaded to the configured provider.'
  )
  .option(
    '--transcription-model <model>',
    'Supported model: scribe_v2 for ElevenLabs or whisper-1 for OpenAI. Omit to reuse the configured model, or the provider default for a new configuration.'
  )
  .option(
    '--transcription-segmenter <segmenter>',
    'Transcription segmenter. Only integrated is supported (default).'
  )
  .action(async (target, options) => {
    const chunking = {
      targetSeconds: options.chunkTarget,
      boundarySearchSeconds: options.chunkBoundarySearch,
      silenceNoiseDb: options.chunkSilenceNoise,
      silenceDurationSeconds: options.chunkSilenceDuration
    };
    resolveAudioChunkOptions(chunking);
    const cliOptions: CliOptions = {
      media: options.media,
      continue: options.continue,
      commit: options.commit,
      reset: options.reset,
      chunking,
      transcription: {
        provider: options.transcriptionProvider,
        model: options.transcriptionModel,
        segmenter: options.transcriptionSegmenter
      }
    };
    const session = await Session.loadOrCreate(target, cliOptions.media);
    await runRajio(session, cliOptions);
  });

registerSegmentCommands(app);
registerClipCommands(app);
registerFrameCommands(app);

app
  .command('check', {
    summary: `Validate session.toml and segments.toml files`,
    details: `rajio check validates session.toml and segments.toml files under transcript/ and translation/, then displays global fatal issues plus subtitle QA for the target stage/language.

Output:

- Default human output groups repeated issues by severity, code, and file. Summary lines are compact issue indexes; use the hint's segments list --issues <code> command for matching segment rows.
- fatal means data/file/schema/timeline/workflow integrity and cannot be skipped.
- error means subtitle QA hard issue; it blocks commit/export unless the exact issue code is listed in that segment's skip_checks with a reason.
- warning means subtitle QA soft issue for review only.
- A skipped error is omitted from output; stale or mistyped skips report fatal unused_skip_check.
- translation_work reports inherited Japanese subtitle QA hard rules as warnings in the ja language view. Chinese subtitle QA hard rules remain error, and data integrity problems remain fatal.

Issue Codes:

rajio check reports these validation codes. segments list --issues accepts the same codes for segment-scoped issues; add --level error when you need only hard matches for codes that can be either warning or error.

  - Data integrity (duplicate ids, invalid time, overlap): duplicate_id, invalid_time, overlap
  - Required text (required Japanese or Chinese text is empty): empty_ja, empty_zh
  - Line length (line exceeds soft or hard character limit): ja_line_soft_limit, ja_line_hard_limit, zh_line_soft_limit, zh_line_hard_limit
  - Line breaks (text has unnecessary or too many line breaks): ja_line_break_can_merge_soft, ja_line_break_can_merge_hard, ja_line_break_soft_limit, ja_line_break_hard_limit, zh_line_break_can_merge_soft, zh_line_break_can_merge_hard, zh_line_break_soft_limit, zh_line_break_hard_limit
  - Subtitle duration (segment is too short or too long): duration_too_short, duration_too_long
  - Reading speed (text is too dense for the duration): ja_reading_speed_limit, zh_reading_speed_limit
  - Adjacent gap (gap from previous segment is too short): subtitle_gap_too_short, subtitle_gap_short
  - Common punctuation (ordinary comma/period punctuation appears): ja_common_punctuation, zh_common_punctuation hard QA errors
  - Terminal punctuation (line ends with ordinary sentence mark): ja_terminal_punctuation, zh_terminal_punctuation hard QA errors
  - Repeated punctuation (repeated question/exclamation punctuation): ja_repeated_punctuation, zh_repeated_punctuation hard QA errors from 2 marks
  - Punctuation-only line (a line contains only punctuation): ja_punctuation_only_line, zh_punctuation_only_line hard QA errors
  - Skip annotations (stale per-segment skip metadata): unused_skip_check

Exit behavior:

- If any displayed issue is fatal or error, process exit code is 1.
- If no displayed fatal or error remains, the command exits successfully, even if unfiltered issues existed outside the selected stage/language/level.`,
    examples: [
      {
        comment: 'Check the current stage for blocking issues as JSON.',
        command: 'rajio check /path/to/session --level error --json'
      },
      {
        comment: 'Inspect Chinese QA for translation segments overlapping 120–180 seconds.',
        command: 'rajio check /path/to/session --stage translation --start 120 --end 180 --verbose'
      },
      {
        comment: 'Inspect inherited Japanese QA in translation work.',
        command: 'rajio check /path/to/session --stage translation --language ja'
      }
    ]
  })
  .argument(
    '<target>',
    'Existing session directory, session.toml, description markdown file, or media file.'
  )
  .option(
    '--verbose',
    'Print every issue. With --json, each issue contains file, optional stage, level, optional code, message, optional segmentId and segment context: timing, adjacent ids, text lengths and preview.'
  )
  .option(
    '--json',
    'Print summary JSON: ok, scope, optional range, counts, and summary. ok and summary follow the selected level; counts includes all severities in the selected scope. Add --verbose for full issues. Summary entries contain file, level, code, count, message and examples.'
  )
  .option(
    '--start <seconds>',
    'Filter segment QA to segments overlapping [start, end). Requires --end. Non-segment fatal issues are still shown.',
    {
      cast: numberInput
    }
  )
  .option(
    '--end <seconds>',
    'End of the QA range in source-media seconds. Requires --start and must be greater than start.',
    {
      cast: numberInput
    }
  )
  .option(
    '--level <level>',
    'Severity threshold (default warning): warning shows fatal, error, warning; error shows fatal and error; fatal shows only fatal.',
    {
      cast: issueLevelInput
    }
  )
  .option(
    '--language <language>',
    'ja or zh. Transcript work defaults to ja and rejects zh; translation work defaults to zh and can inspect inherited Japanese QA with ja. Duration and adjacent-gap QA appear in either language view.',
    {
      cast: z.enum(['ja', 'zh'])
    }
  )
  .option(
    '--stage <stage>',
    'transcript or transcript_work checks Japanese work; translation or translation_work checks translation work. Explicit audio, transcript_raw, or export checks only global fatal issues. If omitted, use the current stage; current export/done checks translation work.',
    {
      cast: z.enum([
        'audio',
        'transcript',
        'transcript_raw',
        'transcript_work',
        'translation',
        'translation_work',
        'export'
      ])
    }
  )
  .action(async (target, options) => {
    const session = await Session.load(target);
    const range = resolveCheckRange(options.start, options.end);
    const result = await checkRajio(session);
    const filterOptions: CheckFilterOptions = {
      level: options.level,
      stage: options.stage,
      language: options.language,
      range,
      currentStage: session.currentStage
    };
    const scope = resolveCheckScope(filterOptions);
    const issues = filterCheckIssues(result.issues, filterOptions);
    const countIssues = filterCheckIssues(result.issues, { ...filterOptions, level: 'warning' });
    printCheckIssues(issues, {
      verbose: Boolean(options.verbose),
      json: Boolean(options.json),
      sessionDir: session.dir,
      scope,
      range,
      countIssues,
      target
    });
    if (issues.some((issue) => issue.level === 'fatal' || issue.level === 'error')) {
      process.exitCode = 1;
      return;
    }
    if (!options.json) {
      taggedLogger('check').success('check passed.');
    }
  });

function resolveCheckRange(
  start: number | undefined,
  end: number | undefined
): { start: number; end: number } | undefined {
  if (start === undefined && end === undefined) {
    return undefined;
  }
  if (start === undefined || end === undefined) {
    throw new Error('--start and --end must be provided together.');
  }
  if (end <= start) {
    throw new Error('--end must be greater than --start.');
  }
  return { start, end };
}

app
  .command('doctor', {
    summary: `Check environment, provider, ffmpeg, and Node.js`,
    details: `rajio doctor <target> loads the target session config and checks the selected transcription provider:

- ElevenLabs transcription requires ELEVENLABS_API_KEY. The check intentionally sends an invalid request to test connectivity with the key.
- OpenAI-compatible transcription requires OPENAI_API_KEY and checks the configured OpenAI-compatible API.
- Only the selected transcription provider is checked; ElevenLabs transcription does not require OPENAI_API_KEY.

It also checks CLI version/update status, .env loading, ffmpeg, ffprobe, and Node.js. If any check fails, process exit code is 1.

OPENAI_BASE_URL optionally overrides the OpenAI-compatible API base URL. FFMPEG_PATH and FFPROBE_PATH optionally override the binaries. Existing sessions require session.toml rajio_version to match the running CLI version.`,
    examples: [
      {
        comment: 'Check the selected provider, environment, and local tools.',
        command: 'rajio doctor /path/to/session'
      }
    ]
  })
  .argument(
    '<target>',
    'Existing session directory, session.toml, description markdown file, or media file.'
  )
  .action(async (target) => {
    const session = await Session.load(target);
    const result = await runDoctor(session);
    printDoctorChecks(result.checks);
    if (!result.ok) {
      process.exitCode = 1;
      return;
    }
    taggedLogger('doctor').success('doctor passed.');
  });

app
  .command('clean', {
    summary: `Clean generated session artifacts`,
    details: `rajio clean removes these generated session artifacts:

- session.toml
- audio/
- transcript/
- translation/
- output/

It does not remove description.md, source media files, or clips/.`,
    examples: [
      {
        comment: 'Discard generated workflow artifacts; keep source media and clips.',
        command: 'rajio clean /path/to/session'
      }
    ]
  })
  .argument(
    '<target>',
    'Existing session directory, session.toml, description markdown file, or media file.'
  )
  .action(async (target) => {
    const session = await Session.load(target);
    const removed = await session.clean();
    process.stdout.write(`${session.dir}\n`);
    process.stdout.write(`removed: ${removed.length > 0 ? removed.join(', ') : 'none'}\n`);
  });

const argv = process.argv.slice(2);

await app.run(argv).catch((error) => {
  process.stderr.write(`${formatCliError(error, argv)}\n`);
  process.exitCode = 1;
});
