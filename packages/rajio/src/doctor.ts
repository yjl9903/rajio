import path from 'node:path';

import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import { Codex } from '@openai/codex-sdk';
import { execa } from 'execa';
import OpenAI from 'openai';

import { version as packageVersion } from '../package.json' with { type: 'json' };
import type { Session } from './session/index.js';
import { pathExists } from './utils/fs.js';
import { readRuntimeConfig } from './utils/env.js';
import type { RuntimeConfig } from './types.js';
import { taggedLogger } from './utils/logger.js';

const REQUIRED_NODE_MAJOR = 24;
const CHECK_TIMEOUT_MS = 10000;
const NPM_RAJIO_LATEST_URL = 'https://registry.npmjs.org/rajio/latest';
const ELEVENLABS_PROBE_TRANSCRIPT_ID = 'rajio-doctor-probe';

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
  checkElevenLabs?: (runtime: RuntimeConfig) => Promise<void>;
  checkOpenAI?: (runtime: RuntimeConfig) => Promise<void>;
  createCodex?: (runtime: RuntimeConfig) => void;
  getLatestRajioVersion?: () => Promise<string>;
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

  checks.push(await cliVersionCheck(deps));
  checks.push(nodeCheck(deps.nodeVersion ?? process.versions.node));
  checks.push(...envFilesChecks(envFiles));
  checks.push(baseUrlCheck(runtime));
  checks.push(await elevenLabsConnectivityCheck(runtime, deps));
  checks.push(await openAIConnectivityCheck(runtime, deps));
  checks.push(await commandVersionCheck('ffmpeg', runtime.ffmpegBin, deps));
  checks.push(await commandVersionCheck('ffprobe', runtime.ffprobeBin, deps));
  checks.push(codexCheck(runtime, deps));

  return {
    ok: checks.every((check) => check.status !== 'fail'),
    checks
  };
}

export function printDoctorChecks(checks: DoctorCheck[]): void {
  const logger = taggedLogger('doctor');
  for (const check of checks) {
    const message = `${check.name}: ${check.message}`;
    if (check.status === 'pass') {
      logger.success(message);
    } else if (check.status === 'warn') {
      logger.warn(message);
    } else {
      logger.error(message);
    }
    if (check.detail) {
      for (const line of check.detail.split(/\r?\n/).filter(Boolean)) {
        logger.info(`  ${line}`);
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

async function cliVersionCheck(deps: DoctorDeps): Promise<DoctorCheck> {
  try {
    const latestVersion = await (deps.getLatestRajioVersion ?? getLatestRajioVersion)();
    const comparison = compareSemverCore(packageVersion, latestVersion);
    if (comparison === undefined) {
      return {
        name: 'rajio',
        status: 'warn',
        message: `v${packageVersion}; update check failed`,
        detail: `Invalid version returned by npm registry: ${latestVersion}`
      };
    }
    if (comparison < 0) {
      return {
        name: 'rajio',
        status: 'warn',
        message: `v${packageVersion} is outdated; latest is v${latestVersion}`
      };
    }
    return {
      name: 'rajio',
      status: 'pass',
      message: `v${packageVersion} is up to date`
    };
  } catch (error) {
    return {
      name: 'rajio',
      status: 'warn',
      message: `v${packageVersion}; update check failed`,
      detail: formatError(error)
    };
  }
}

function envFilesChecks(envFiles: string[]): DoctorCheck[] {
  if (envFiles.length === 0) {
    return [];
  }
  return envFiles.map((filePath) => ({
    name: '.env',
    status: 'pass',
    message: `Loaded ${filePath}`
  }));
}

async function openAIConnectivityCheck(
  runtime: RuntimeConfig,
  deps: DoctorDeps
): Promise<DoctorCheck> {
  if (!runtime.openaiApiKey) {
    return {
      name: 'openai',
      status: 'warn',
      message: 'OPENAI_API_KEY is not set; manual AI stages will not work'
    };
  }
  try {
    await (deps.checkOpenAI ?? checkOpenAIConnectivity)(runtime);
    return {
      name: 'openai',
      status: 'pass',
      message: 'OpenAI API is reachable'
    };
  } catch (error) {
    return {
      name: 'openai',
      status: 'warn',
      message: 'OpenAI API check failed',
      detail: formatError(error)
    };
  }
}

async function elevenLabsConnectivityCheck(
  runtime: RuntimeConfig,
  deps: DoctorDeps
): Promise<DoctorCheck> {
  if (!runtime.elevenlabsApiKey) {
    return {
      name: 'transcription',
      status: 'fail',
      message: 'ELEVENLABS_API_KEY is not set'
    };
  }
  try {
    await (deps.checkElevenLabs ?? checkElevenLabsConnectivity)(runtime);
    return {
      name: 'transcription',
      status: 'pass',
      message: 'ElevenLabs Speech-to-Text API is reachable'
    };
  } catch (error) {
    return {
      name: 'transcription',
      status: 'fail',
      message: 'ElevenLabs API check failed',
      detail: formatError(error)
    };
  }
}

function baseUrlCheck(runtime: RuntimeConfig): DoctorCheck {
  if (!runtime.openaiBaseUrl) {
    return {
      name: '.env',
      status: 'pass',
      message: 'OPENAI_BASE_URL is not set; using OpenAI default'
    };
  }
  return {
    name: '.env',
    status: 'pass',
    message: `OPENAI_BASE_URL uses ${runtime.openaiBaseUrl}`
  };
}

function nodeCheck(nodeVersion: string): DoctorCheck {
  const major = Number(nodeVersion.split('.')[0]);
  if (!Number.isInteger(major) || major < REQUIRED_NODE_MAJOR) {
    return {
      name: 'node',
      status: 'fail',
      message: `Node.js v${nodeVersion} is too old; rajio requires >=${REQUIRED_NODE_MAJOR}`
    };
  }
  return {
    name: 'node',
    status: 'pass',
    message: `Node.js v${nodeVersion} satisfies >=${REQUIRED_NODE_MAJOR}`
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
      message: firstLine ? firstLine : `${command} is executable`
    };
  } catch (error) {
    return {
      name,
      status: 'fail',
      message: `${command} is not usable`,
      detail: formatError(error)
    };
  }
}

function codexCheck(runtime: RuntimeConfig, deps: DoctorDeps): DoctorCheck {
  if (!runtime.openaiApiKey) {
    return {
      name: 'codex',
      status: 'warn',
      message: 'Skipped Codex check because OPENAI_API_KEY is missing'
    };
  }

  try {
    (deps.createCodex ?? createCodex)(runtime);
    return {
      name: 'codex',
      status: 'pass',
      message: '@openai/codex-sdk is installed and initialized'
    };
  } catch (error) {
    return {
      name: 'codex',
      status: 'warn',
      message: 'Codex SDK check failed',
      detail: formatError(error)
    };
  }
}

async function getLatestRajioVersion(): Promise<string> {
  const response = await fetch(NPM_RAJIO_LATEST_URL, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS)
  });
  if (!response.ok) {
    throw new Error(`npm registry responded with ${response.status} ${response.statusText}`);
  }
  const data = (await response.json()) as { version?: unknown };
  if (typeof data.version !== 'string') {
    throw new Error('npm registry response is missing version');
  }
  return data.version;
}

function createCodex(runtime: RuntimeConfig): void {
  new Codex({
    apiKey: runtime.openaiApiKey,
    baseUrl: runtime.openaiBaseUrl
  });
}

async function checkOpenAIConnectivity(runtime: RuntimeConfig): Promise<void> {
  const client = new OpenAI({
    apiKey: runtime.openaiApiKey,
    baseURL: runtime.openaiBaseUrl,
    timeout: CHECK_TIMEOUT_MS
  });
  await client.models.list();
}

async function checkElevenLabsConnectivity(runtime: RuntimeConfig): Promise<void> {
  const client = new ElevenLabsClient({ apiKey: runtime.elevenlabsApiKey });
  try {
    await client.speechToText.transcripts.get(ELEVENLABS_PROBE_TRANSCRIPT_ID, {
      timeoutInSeconds: CHECK_TIMEOUT_MS / 1000
    });
  } catch (error) {
    if (isElevenLabsProbeSuccessError(error)) {
      return;
    }
    throw error;
  }
}

export function isElevenLabsProbeSuccessError(error: unknown): boolean {
  return isHttpStatus(error, 404) || isElevenLabsInvalidUidError(error);
}

function isElevenLabsInvalidUidError(error: unknown): boolean {
  const body = getErrorBody(error);
  const detail = isRecord(body) ? body.detail : undefined;
  if (!isRecord(detail)) {
    return false;
  }
  return detail.status === 'invalid_uid' || detail.code === 'invalid_uid';
}

function getErrorBody(error: unknown): unknown {
  if (isRecord(error)) {
    return error.body;
  }
  return undefined;
}

function isHttpStatus(error: unknown, statusCode: number): boolean {
  if (!isRecord(error)) {
    return false;
  }
  return error.statusCode === statusCode;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  );
}

function compareSemverCore(left: string, right: string): number | undefined {
  const leftParts = parseSemverCore(left);
  const rightParts = parseSemverCore(right);
  if (!leftParts || !rightParts) {
    return undefined;
  }
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index]! !== rightParts[index]!) {
      return leftParts[index]! - rightParts[index]!;
    }
  }
  return 0;
}

function parseSemverCore(version: string): [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (!match) {
    return undefined;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
