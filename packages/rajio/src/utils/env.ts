import path from 'node:path';

import dotenv from 'dotenv';

import { pathExists } from './fs.js';
import type { RuntimeConfig } from '../types.js';

export async function readRuntimeConfig(input: {
  cwd: string;
  sessionDir: string;
}): Promise<RuntimeConfig> {
  await loadEnvFile(path.join(input.cwd, '.env'));
  if (path.resolve(input.sessionDir) !== path.resolve(input.cwd)) {
    await loadEnvFile(path.join(input.sessionDir, '.env'));
  }
  return {
    openaiApiKey: process.env.OPENAI_API_KEY,
    openaiBaseUrl: process.env.OPENAI_BASE_URL,
    elevenlabsApiKey: process.env.ELEVENLABS_API_KEY,
    ffmpegBin: process.env.RAJIO_FFMPEG_BIN || 'ffmpeg',
    ffprobeBin: process.env.RAJIO_FFPROBE_BIN || 'ffprobe'
  };
}

async function loadEnvFile(filePath: string): Promise<void> {
  if (!(await pathExists(filePath))) {
    return;
  }
  dotenv.config({ path: filePath, override: true, quiet: true });
}
