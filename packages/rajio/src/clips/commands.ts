import path from 'node:path';

import type { breadc } from 'breadc';
import { numberInput } from '../utils/cast.js';

import { readRuntimeConfig } from '../utils/env.js';
import { fromSessionRelative, pathExists } from '../utils/fs.js';
import { Session } from '../session/index.js';
import { readSegmentsFile } from '../segments/index.js';
import { prepareSegmentOutput, printSegments } from '../segments/output.js';
import { resolveAudioChunkOptions } from '../audio/index.js';
import { resolveClipTranscriptionConfig } from '../transcription/config.js';
import { listClips, readClipFile } from './list.js';
import { prepareClipOutput, printClipList } from './output.js';
import { transcribeClip } from './transcribe.js';

type RajioApp = ReturnType<typeof breadc>;

export function registerClipCommands(app: RajioApp): void {
  app
    .command('clips transcribe', {
      summary: `Transcribe a source media time range as a review clip`,
      details: `Clips are sidecar retranscription artifacts for difficult source-video ranges. They do not modify workflow stage state, transcript/raw/segments.toml, or transcript/work/segments.toml.

Audio is uploaded to the configured ASR provider. Transcript times are absolute source-video times. Matching checkpoints are reused; failed or missing checkpoints are retried. Clip failures do not block the main workflow.

Clip directory shape:

clips/
  clip-120000-180000/
    clip.toml
    source.m4a
    chunks/                 # only with local chunking
    checkpoints/
      input-000.toml
      input-000.error.log
    segments.toml

If the same start/end range already has a clip directory, the command resumes that clip. Otherwise it creates a new id; if the base id is already used by a different clip, a numeric suffix is added.`,
      examples: [
        {
          comment: 'Retranscribe a difficult range as a labeled sidecar review clip.',
          command:
            'rajio clips transcribe /path/to/session --start 120 --end 180 --label noisy-overlap'
        }
      ]
    })
    .argument(
      '<target>',
      'Existing session directory, session.toml, description markdown file, or media file.'
    )
    .option(
      '--start <seconds>',
      'Required clip start in source-video seconds. Range is [start, end).',
      { cast: numberInput }
    )
    .option('--end <seconds>', 'Required exclusive clip end in source-video seconds.', {
      cast: numberInput
    })
    .option('--label <name>', 'Optional clip label.')
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
      'ASR provider: elevenlabs or openai. Defaults to the session configuration. When switching provider, also set --transcription-model. Existing clips require their original provider/model to resume. ElevenLabs uses the full extracted audio; OpenAI uses local chunks.'
    )
    .option(
      '--transcription-model <model>',
      'Supported model: scribe_v2 for ElevenLabs or whisper-1 for OpenAI. Defaults to the session configuration.'
    )
    .option(
      '--transcription-segmenter <segmenter>',
      'Transcription segmenter. Only integrated is supported (default).'
    )
    .action(async (target, options) => {
      const session = await Session.load(target);
      const runtime = await readRuntimeConfig({ cwd: process.cwd(), sessionDir: session.dir });
      const chunking = {
        targetSeconds: options.chunkTarget,
        boundarySearchSeconds: options.chunkBoundarySearch,
        silenceNoiseDb: options.chunkSilenceNoise,
        silenceDurationSeconds: options.chunkSilenceDuration
      };
      resolveAudioChunkOptions(chunking);
      await transcribeClip({
        session,
        runtime,
        transcription: resolveClipTranscriptionConfig({
          state: session.state,
          cli: {
            provider: options.transcriptionProvider,
            model: options.transcriptionModel,
            segmenter: options.transcriptionSegmenter
          }
        }),
        start: requireNumberOption(options.start, '--start'),
        end: requireNumberOption(options.end, '--end'),
        label: options.label,
        chunking
      });
    });

  app
    .command('clips list', {
      summary: `List review clips`,
      details: `Status values:

- done: clip transcript is available.
- failed: transcription has checkpoint errors.
- partial: checkpoints exist but the clip transcript is not ready.
- missing: transcript is unreadable, or no transcript or checkpoint state is available.`,
      examples: [
        {
          comment: 'List existing review clips and their checkpoint status.',
          command: 'rajio clips list /path/to/session'
        }
      ]
    })
    .argument(
      '<target>',
      'Existing session directory, session.toml, description markdown file, or media file.'
    )
    .option(
      '--json',
      'Print { "clips": [...] } with id, label, start, end, duration, status and segments. Without --json: human-readable output on TTY, CSV otherwise.'
    )
    .action(async (target, options) => {
      const output = prepareClipOutput({ json: Boolean(options.json) });
      const session = await Session.load(target);
      printClipList(await listClips(session), output);
    });

  app
    .command('clips show', {
      summary: `Print clip transcript segments`,
      details: "Prints only that clip's segments.toml rows; it does not print clip.toml metadata.",
      examples: [
        {
          comment: 'Read one clip transcript for comparison with the main work file.',
          command: 'rajio clips show /path/to/session clip-120000-180000'
        }
      ]
    })
    .argument(
      '<target>',
      'Existing session directory, session.toml, description markdown file, or media file.'
    )
    .argument('<id>', 'Review clip id from clips list.')
    .option(
      '--json',
      'Print { "segments": [...] } with id, start, end, speaker, ja, and zh. Without --json: human-readable output on TTY, CSV otherwise.'
    )
    .action(async (target, id, options) => {
      const output = prepareSegmentOutput({ json: Boolean(options.json) });
      const session = await Session.load(target);
      const clipPath = session.artifact('clips', id, 'clip.toml');
      if (!(await pathExists(clipPath))) {
        throw new Error(`clip not found: ${id}`);
      }
      const clip = await readClipFile(clipPath);
      const segmentsPath = fromSessionRelative(path.dirname(clipPath), clip.segments);
      if (!(await pathExists(segmentsPath))) {
        throw new Error(`clip segments not found: ${id}`);
      }
      const segments = await readSegmentsFile(segmentsPath);
      printSegments(segments.segments, output, {
        totalDuration: Math.max(0, ...segments.segments.map((segment) => segment.end))
      });
    });
}

function requireNumberOption(value: number | undefined, name: string): number {
  if (value === undefined) {
    throw new Error(`${name} is required.`);
  }
  return value;
}
