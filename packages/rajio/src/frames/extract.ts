import path from 'node:path';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';

import { execa } from 'execa';

import { Session } from '../session/index.js';
import { readRuntimeConfig } from '../utils/env.js';
import { mediaDurationFromMetadata, probeMediaMetadata } from '../audio/index.js';

export interface FrameRequest {
  times: number[];
  end?: number;
}

export interface FrameResult {
  output_dir: string;
  frames: { time: number; path: string }[];
}

export function resolveFrameRequest(options: {
  at?: number[];
  start?: number;
  end?: number;
  count?: number;
}): FrameRequest {
  const { at, start, end, count } = options;
  if (at !== undefined) {
    if (start !== undefined || end !== undefined || count !== undefined) {
      throw new Error('--at cannot be combined with --start, --end, or --count.');
    }
    const times = [...new Set(at)];
    if (times.length < 1 || times.length > 24) {
      throw new Error('--at requires 1 to 24 distinct time points.');
    }
    if (times.some((time) => !Number.isFinite(time) || time < 0)) {
      throw new Error('--at requires finite, non-negative seconds.');
    }
    return { times };
  }
  if (start === undefined || end === undefined || count === undefined) {
    throw new Error('Provide --at or all of --start, --end, and --count.');
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
    throw new Error(
      '--start must be non-negative and --end must be finite and greater than --start.'
    );
  }
  if (!Number.isInteger(count) || count < 1 || count > 24) {
    throw new Error('--count must be an integer from 1 to 24.');
  }
  return {
    times: Array.from({ length: count }, (_, i) => start + ((i + 0.5) / count) * (end - start)),
    end
  };
}

export async function extractFrames(target: string, request: FrameRequest): Promise<FrameResult> {
  const absoluteTarget = path.resolve(target);
  const targetStat = await stat(absoluteTarget);
  let root = path.dirname(absoluteTarget);
  let mediaPath = absoluteTarget;
  if (targetStat.isDirectory() || path.basename(absoluteTarget) === 'session.toml') {
    root = targetStat.isDirectory() ? absoluteTarget : root;
    const sessionPath = path.join(root, 'session.toml');
    if (!(await stat(sessionPath).catch(() => undefined))?.isFile()) {
      throw new Error(`An existing session.toml is required: ${root}`);
    }
    const session = await Session.load(sessionPath);
    mediaPath = session.mediaPath;
  } else if (/\.(md|markdown)$/i.test(absoluteTarget)) {
    throw new Error(
      'frames accepts an existing session directory, session.toml, or local video file.'
    );
  }
  if (!(await stat(mediaPath)).isFile()) {
    throw new Error(`Media must be a local file: ${mediaPath}`);
  }

  const runtime = await readRuntimeConfig({ cwd: process.cwd(), sessionDir: root });
  let metadata: unknown;
  try {
    metadata = await probeMediaMetadata(runtime.ffprobeBin, mediaPath);
  } catch (error) {
    throw new Error(`Could not probe media ${mediaPath}: ${errorMessage(error)}`);
  }
  const streams = isRecord(metadata) && Array.isArray(metadata.streams) ? metadata.streams : [];
  const video = streams.find((stream: unknown) => {
    if (!isRecord(stream) || stream.codec_type !== 'video') return false;
    const disposition = isRecord(stream.disposition) ? stream.disposition : {};
    return !disposition.attached_pic && !disposition.timed_thumbnails && !disposition.still_image;
  });
  if (!video) {
    throw new Error(`No usable video stream (excluding cover art and thumbnails): ${mediaPath}`);
  }
  const duration = mediaDurationFromMetadata(metadata);
  if (duration !== undefined) {
    const outside = request.times.find((time) => time >= duration);
    if (outside !== undefined) {
      throw new Error(
        `Requested time ${outside} seconds must be less than media duration ${duration}.`
      );
    }
    if (request.end !== undefined && request.end > duration) {
      throw new Error(`--end must not exceed media duration ${duration} seconds.`);
    }
  }

  const framesDir = path.join(root, 'frames');
  await mkdir(framesDir, { recursive: true });
  const outputDir = await mkdtemp(path.join(framesDir, 'capture-'));
  const frames: FrameResult['frames'] = [];
  try {
    for (const [index, time] of request.times.entries()) {
      const outputPath = path.join(outputDir, `frame-${String(index + 1).padStart(3, '0')}.png`);
      try {
        await execa(runtime.ffmpegBin, [
          '-nostdin',
          '-hide_banner',
          '-loglevel',
          'error',
          '-ss',
          time.toLocaleString('en-US', { useGrouping: false, maximumSignificantDigits: 21 }),
          '-i',
          mediaPath,
          '-map',
          '0:V:0',
          '-vf',
          "scale=w='max(1,round(iw*sar))':h=ih,setsar=1",
          '-frames:v',
          '1',
          '-fps_mode',
          'passthrough',
          '-update',
          '1',
          outputPath
        ]);
      } catch (error) {
        throw new Error(
          `Could not extract video frame at requested time ${time} seconds: ${errorMessage(error)}`
        );
      }
      const output = await stat(outputPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw new Error(
          `Could not verify video frame at requested time ${time} seconds: ${errorMessage(error)}`
        );
      });
      if (!output?.isFile() || output.size === 0) {
        throw new Error(
          `No video frame was produced at requested time ${time} seconds: ${mediaPath}`
        );
      }
      frames.push({ time, path: outputPath });
    }
  } catch (error) {
    try {
      await rm(outputDir, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new Error(
        `${errorMessage(error)}\nCould not remove batch directory ${outputDir}: ${errorMessage(cleanupError)}`
      );
    }
    throw error;
  }
  return { output_dir: outputDir, frames };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
