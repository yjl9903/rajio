import path from 'node:path';

import type { UnknownOptionMiddleware, breadc } from 'breadc';

import { readRuntimeConfig } from '../utils/env.js';
import { fromSessionRelative, pathExists } from '../utils/fs.js';
import { castNumber } from '../utils/cast.js';
import { Session } from '../session/index.js';
import { readSegmentsFile } from '../segments/index.js';
import { prepareSegmentOutput, printSegments } from '../segments/output.js';
import { resolveAudioChunkOptions } from '../audio/index.js';
import { resolveClipTranscriptionConfig } from '../transcription/config.js';
import { listClips, readClipFile } from './list.js';
import { prepareClipOutput, printClipList } from './output.js';
import { transcribeClip } from './transcribe.js';

type RajioApp = ReturnType<typeof breadc>;
const rejectUnknownOption: UnknownOptionMiddleware = (_context, key) => {
  throw new Error(`Unknown option: --${key}`);
};

export function registerClipCommands(app: RajioApp): void {
  app
    .command('clips transcribe <target>', 'Transcribe a source media time range as a review clip')
    .option('--start <seconds>', 'clip start time in seconds', { cast: castNumber })
    .option('--end <seconds>', 'clip end time in seconds', { cast: castNumber })
    .option('--label <name>', 'optional clip label')
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
    .option('--transcription-provider <provider>', 'transcription provider')
    .option('--transcription-model <model>', 'transcription model')
    .option('--transcription-segmenter <segmenter>', 'transcription segmenter')
    .allowUnknownOption(rejectUnknownOption)
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
    .command('clips list <target>', 'List review clips')
    .option('--json', 'print JSON output')
    .allowUnknownOption(rejectUnknownOption)
    .action(async (target, options) => {
      const output = prepareClipOutput({ json: Boolean(options.json) });
      const session = await Session.load(target);
      printClipList(await listClips(session), output);
    });

  app
    .command('clips show <target> <id>', 'Print clip transcript segments')
    .option('--json', 'print JSON output')
    .allowUnknownOption(rejectUnknownOption)
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
