import { breadc } from 'breadc';

import { version, description } from '../package.json' with { type: 'json' };
import { registerClipCommands } from './clips/commands.js';
import { printDoctorChecks, runDoctor } from './doctor.js';
import { registerSegmentCommands } from './segments/commands.js';
import { checkRajio, filterCheckIssues, printCheckIssues } from './session/check.js';
import { Session } from './session/index.js';
import type { CliOptions } from './types.js';
import { STAGES } from './types.js';
import { installBrokenPipeHandler } from './utils/broken-pipe.js';
import { castNumber } from './utils/cast.js';
import { formatCliError } from './utils/cli-error.js';
import { taggedLogger, wrapConsoleLogger } from './utils/logger.js';
import { runRajio } from './workflow/index.js';
import { resolveAudioChunkOptions } from './workflow/stages/audio.js';

installBrokenPipeHandler();
wrapConsoleLogger();

const app = breadc('rajio', { version, description });
const checkLogger = taggedLogger('check');
const doctorLogger = taggedLogger('doctor');
const cleanLogger = taggedLogger('clean');
const cliLogger = taggedLogger('cli');

app
  .command('<target>', 'Run or resume a rajio subtitle session')
  .option('--media <path>', 'override media path for this invocation')
  .option('--continue <mode>', 'continue mode: until-manual or step', {
    default: 'until-manual' as const,
    cast: (value) => {
      if (value !== 'until-manual' && value !== 'step') {
        throw new Error('--continue must be "until-manual" or "step".');
      }
      return value;
    }
  })
  .option('--commit', 'commit current manual stage')
  .option('--verbose', 'print every warning instead of summarizing repetitive warnings')
  .option(
    '--reset <stage>',
    'regenerate from stage: audio, transcript_raw, transcript_work, translation_work, or export',
    {
      cast: (value) => {
        if (value === undefined) {
          return undefined;
        }
        if (STAGES.includes(value as (typeof STAGES)[number])) {
          return value as (typeof STAGES)[number];
        }
        throw new Error(`--reset must be one of: ${STAGES.join(', ')}.`);
      }
    }
  )
  .option('--agent <agent>', 'batch automation only, run agent for manual stage: codex or false', {
    cast: (value) => {
      if (value === undefined) {
        return undefined;
      }
      if (value === 'false') {
        return false;
      }
      if (value !== 'codex') {
        throw new Error('--agent currently supports only "codex" or "false".');
      }
      return value;
    }
  })
  .option('--full', 'run all remaining stages automatically')
  .option('--chunk-target <seconds>', 'target local audio chunk length in seconds', {
    cast: castNumber
  })
  .option('--chunk-boundary-search <seconds>', 'seconds around target to search for silence', {
    cast: castNumber
  })
  .option('--chunk-silence-noise <db>', 'ffmpeg silencedetect noise threshold in dB', {
    cast: castNumber
  })
  .option('--chunk-silence-duration <seconds>', 'ffmpeg silencedetect minimum silence duration', {
    cast: castNumber
  })
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
      agent: options.agent,
      full: options.full,
      reset: options.reset,
      verbose: Boolean(options.verbose),
      chunking
    };
    const session = await Session.loadOrCreate(target, cliOptions.media);
    await runRajio(session, cliOptions);
  });

registerSegmentCommands(app);
registerClipCommands(app);

app
  .command('check <target>', 'Validate session.toml and segments.toml files')
  .option('--verbose', 'print every issue')
  .option('--json', 'print JSON output')
  .option('--level <level>', 'filter issues by level: all, error, or warning', {
    cast: (value) => {
      if (value === undefined) {
        return 'all';
      }
      if (value === 'all' || value === 'error' || value === 'warning') {
        return value;
      }
      throw new Error('--level must be "all", "error", or "warning".');
    }
  })
  .option(
    '--stage <stage>',
    'filter issues by stage: transcript, translation, transcript_raw, transcript_work, translation_work, audio, or export',
    {
      cast: (value) => {
        if (value === undefined) {
          return undefined;
        }
        if (
          value === 'audio' ||
          value === 'transcript' ||
          value === 'transcript_raw' ||
          value === 'transcript_work' ||
          value === 'translation' ||
          value === 'translation_work' ||
          value === 'export'
        ) {
          return value;
        }
        throw new Error(
          '--stage must be "audio", "transcript", "transcript_raw", "transcript_work", "translation", "translation_work", or "export".'
        );
      }
    }
  )
  .action(async (target, options) => {
    const session = await Session.load(target);
    const result = await checkRajio(session);
    const issues = filterCheckIssues(result.issues, {
      level: options.level,
      stage: options.stage
    });
    printCheckIssues(issues, {
      verbose: Boolean(options.verbose),
      json: Boolean(options.json),
      sessionDir: session.dir
    });
    if (issues.some((issue) => issue.level === 'error')) {
      process.exitCode = 1;
      return;
    }
    if (!options.json) {
      checkLogger.success('check passed.');
    }
  });

app
  .command('doctor <target>', 'Check environment, provider, Codex, ffmpeg, and Node.js')
  .action(async (target) => {
    const session = await Session.load(target);
    const result = await runDoctor(session);
    printDoctorChecks(result.checks);
    if (!result.ok) {
      process.exitCode = 1;
      return;
    }
    doctorLogger.success('doctor passed.');
  });

app.command('clean <target>', 'Clean generated session artifacts').action(async (target) => {
  const session = await Session.loadOrCreate(target);
  const removed = await session.clean();
  if (removed.length === 0) {
    cleanLogger.info(`nothing to clean in ${session.dir}.`);
    return;
  }
  cleanLogger.success(`cleaned ${removed.join(', ')} from ${session.dir}.`);
});

app.run(process.argv.slice(2)).catch((error) => {
  cliLogger.error(formatCliError(error));
  process.exitCode = 1;
});
