import path from 'node:path';

import { Codex } from '@openai/codex-sdk';
import { execa } from 'execa';
import OpenAI from 'openai';

import { version as packageVersion } from '../package.json' with { type: 'json' };
import type { Session } from './session/index.js';
import { TRANSCRIPTION_MODEL } from './workflow/transcription.js';
import { pathExists } from './utils/fs.js';
import { readRuntimeConfig } from './utils/env.js';
import type { RuntimeConfig } from './types.js';
import { taggedLogger } from './utils/logger.js';

const REQUIRED_NODE_MAJOR = 24;
const CHECK_TIMEOUT_MS = 10000;
const doctorLogger = taggedLogger('doctor');

export type DoctorStatus = 'pass' | 'warn' | 'fail';

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  message: string;
  detail?: string;
}

export interface DoctorResult {
  ok: boolean;
  checks: DoctorCheck[];
}

export interface DoctorDeps {
  execa?: typeof execa;
  listProviderModels?: (runtime: RuntimeConfig) => Promise<string[]>;
  createCodex?: (runtime: RuntimeConfig) => void;
  nodeVersion?: string;
}

export interface DoctorOptions {
  cwd?: string;
  deps?: DoctorDeps;
}

export async function runDoctor(
  session: Session,
  options: DoctorOptions = {}
): Promise<DoctorResult> {
  const cwd = options.cwd ?? process.cwd();
  const sessionDir = session.dir;
  const deps = options.deps ?? {};
  const checks: DoctorCheck[] = [];

  const envFiles = await collectEnvFiles(cwd, sessionDir);
  const runtime = await readRuntimeConfig({ cwd, sessionDir });

  checks.push(envFilesCheck(envFiles));
  checks.push(apiKeyCheck(runtime));
  checks.push(baseUrlCheck(runtime));
  checks.push(nodeCheck(deps.nodeVersion ?? process.versions.node));
  checks.push(await commandVersionCheck('ffmpeg', runtime.ffmpegBin, deps));
  checks.push(await commandVersionCheck('ffprobe', runtime.ffprobeBin, deps));
  checks.push(await providerCheck(runtime, deps));
  checks.push(codexCheck(runtime, deps));

  return {
    ok: checks.every((check) => check.status !== 'fail'),
    checks
  };
}

export function printDoctorChecks(checks: DoctorCheck[]): void {
  for (const check of checks) {
    const message = `${check.name}: ${check.message}`;
    if (check.status === 'pass') {
      doctorLogger.success(message);
    } else if (check.status === 'warn') {
      doctorLogger.warn(message);
    } else {
      doctorLogger.error(message);
    }
    if (check.detail) {
      for (const line of check.detail.split(/\r?\n/).filter(Boolean)) {
        doctorLogger.info(`  ${line}`);
      }
    }
  }
}

async function collectEnvFiles(cwd: string, sessionDir: string): Promise<string[]> {
  const candidates = [path.join(cwd, '.env')];
  const sessionEnv = path.join(sessionDir, '.env');
  if (path.resolve(sessionEnv) !== path.resolve(candidates[0]!)) {
    candidates.push(sessionEnv);
  }

  const files: string[] = [];
  for (const filePath of candidates) {
    if (await pathExists(filePath)) {
      files.push(filePath);
    }
  }
  return files;
}

function envFilesCheck(envFiles: string[]): DoctorCheck {
  if (envFiles.length === 0) {
    return {
      name: '.env',
      status: 'warn',
      message: 'No .env file found; using process environment only.'
    };
  }
  return {
    name: '.env',
    status: 'pass',
    message: `Loaded ${envFiles.length} .env file${envFiles.length === 1 ? '' : 's'}.`,
    detail: envFiles.join('\n')
  };
}

function apiKeyCheck(runtime: RuntimeConfig): DoctorCheck {
  if (!runtime.openaiApiKey) {
    return {
      name: 'OPENAI_API_KEY',
      status: 'fail',
      message: 'OPENAI_API_KEY is not set.'
    };
  }
  return {
    name: 'OPENAI_API_KEY',
    status: 'pass',
    message: 'OPENAI_API_KEY is set.'
  };
}

function baseUrlCheck(runtime: RuntimeConfig): DoctorCheck {
  if (!runtime.openaiBaseUrl) {
    return {
      name: 'OPENAI_BASE_URL',
      status: 'pass',
      message: 'OPENAI_BASE_URL is not set; using OpenAI default.'
    };
  }
  return {
    name: 'OPENAI_BASE_URL',
    status: 'pass',
    message: `Using ${runtime.openaiBaseUrl}.`
  };
}

function nodeCheck(nodeVersion: string): DoctorCheck {
  const major = Number(nodeVersion.split('.')[0]);
  if (!Number.isInteger(major) || major < REQUIRED_NODE_MAJOR) {
    return {
      name: 'node',
      status: 'fail',
      message: `Node.js v${nodeVersion} is too old; rajio requires >=${REQUIRED_NODE_MAJOR}.`
    };
  }
  return {
    name: 'node',
    status: 'pass',
    message: `Node.js v${nodeVersion} satisfies >=${REQUIRED_NODE_MAJOR}.`
  };
}

async function commandVersionCheck(
  name: 'ffmpeg' | 'ffprobe',
  command: string,
  deps: DoctorDeps
): Promise<DoctorCheck> {
  try {
    const runner = deps.execa ?? execa;
    const result = await runner(command, ['-version'], { timeout: CHECK_TIMEOUT_MS });
    const firstLine = result.stdout
      .split(/\r?\n/)
      .find((line) => line.trim())
      ?.trim();
    return {
      name,
      status: 'pass',
      message: firstLine ? `${command}: ${firstLine}` : `${command} is executable.`
    };
  } catch (error) {
    return {
      name,
      status: 'fail',
      message: `${command} is not usable.`,
      detail: formatError(error)
    };
  }
}

async function providerCheck(runtime: RuntimeConfig, deps: DoctorDeps): Promise<DoctorCheck> {
  if (!runtime.openaiApiKey) {
    return {
      name: 'provider',
      status: 'fail',
      message: 'Skipped provider connectivity check because OPENAI_API_KEY is missing.'
    };
  }

  try {
    const models = await (deps.listProviderModels ?? listProviderModels)(runtime);
    if (models.includes(TRANSCRIPTION_MODEL)) {
      return {
        name: 'provider',
        status: 'pass',
        message: `Provider is reachable and lists ${TRANSCRIPTION_MODEL}.`
      };
    }
    return {
      name: 'provider',
      status: 'warn',
      message: `Provider is reachable, but ${TRANSCRIPTION_MODEL} was not listed.`,
      detail: models.slice(0, 20).join('\n')
    };
  } catch (error) {
    return {
      name: 'provider',
      status: 'fail',
      message: 'Provider connectivity check failed.',
      detail: formatError(error)
    };
  }
}

function codexCheck(runtime: RuntimeConfig, deps: DoctorDeps): DoctorCheck {
  if (!runtime.openaiApiKey) {
    return {
      name: 'codex',
      status: 'fail',
      message: 'Skipped Codex check because OPENAI_API_KEY is missing.'
    };
  }

  try {
    (deps.createCodex ?? createCodex)(runtime);
    return {
      name: 'codex',
      status: 'pass',
      message: `@openai/codex-sdk is installed and initialized for rajio ${packageVersion}.`
    };
  } catch (error) {
    return {
      name: 'codex',
      status: 'fail',
      message: 'Codex SDK check failed.',
      detail: formatError(error)
    };
  }
}

async function listProviderModels(runtime: RuntimeConfig): Promise<string[]> {
  const client = new OpenAI({
    apiKey: runtime.openaiApiKey,
    baseURL: runtime.openaiBaseUrl,
    timeout: CHECK_TIMEOUT_MS,
    maxRetries: 0
  });
  const page = await client.models.list();
  return page.data.map((model) => model.id);
}

function createCodex(runtime: RuntimeConfig): void {
  new Codex({
    apiKey: runtime.openaiApiKey,
    baseUrl: runtime.openaiBaseUrl
  });
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
