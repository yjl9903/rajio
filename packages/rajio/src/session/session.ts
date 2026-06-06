import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { parse, stringify } from 'smol-toml';

import { readDescription } from '../session/description.js';
import {
  fromSessionRelative,
  pathExists,
  sha256File,
  toSessionRelative,
  writeFileAtomic
} from '../utils/fs.js';
import type {
  DescriptionInfo,
  ManualStageName,
  SessionState,
  StageName,
  StageState
} from '../types.js';
import { MANUAL_STAGES, STAGES } from '../types.js';

const SESSION_FILE = 'session.toml';

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown']);
const MEDIA_EXTENSIONS = new Set([
  '.aac',
  '.aiff',
  '.flac',
  '.m4a',
  '.mkv',
  '.mov',
  '.mp3',
  '.mp4',
  '.mpeg',
  '.mpga',
  '.ogg',
  '.wav',
  '.webm'
]);

export class Session {
  private static readonly cleanArtifacts = [
    SESSION_FILE,
    'audio',
    'transcript',
    'translation',
    'output'
  ];

  readonly dir: string;
  readonly target: string;
  readonly description: DescriptionInfo;
  readonly mediaPath: string;
  readonly mediaOverride?: string;
  state: SessionState;

  private constructor(input: {
    dir: string;
    target: string;
    description: DescriptionInfo;
    mediaPath: string;
    mediaOverride?: string;
    state: SessionState;
  }) {
    this.dir = input.dir;
    this.target = input.target;
    this.description = input.description;
    this.mediaPath = input.mediaPath;
    this.mediaOverride = input.mediaOverride;
    this.state = input.state;
  }

  static async loadOrCreate(target: string, mediaOverride?: string): Promise<Session> {
    const resolved = await resolveSessionTarget(target, mediaOverride);
    const sessionPath = path.join(resolved.dir, SESSION_FILE);
    const exists = await pathExists(sessionPath);
    const state = exists
      ? normalizeSession(parseSession(await readFile(sessionPath, 'utf8')))
      : createSessionState(resolved, new Date());
    const session = new Session({
      ...resolved,
      state
    });
    if (!exists) {
      await session.save();
    }
    return session;
  }

  static async load(target: string, mediaOverride?: string): Promise<Session> {
    const resolved = await resolveExistingSessionTarget(target, mediaOverride);
    const sessionPath = path.join(resolved.dir, SESSION_FILE);
    const state = (await pathExists(sessionPath))
      ? normalizeSession(parseSession(await readFile(sessionPath, 'utf8')))
      : createSessionState(resolved, new Date());
    return new Session({
      ...resolved,
      state
    });
  }

  async clean(): Promise<string[]> {
    const removed: string[] = [];

    for (const artifact of Session.cleanArtifacts) {
      const artifactPath = path.join(this.dir, artifact);
      const existed = await pathExists(artifactPath);
      await rm(artifactPath, { recursive: true, force: true });
      if (existed) {
        removed.push(artifact);
      }
    }

    return removed;
  }

  get path(): string {
    return path.join(this.dir, SESSION_FILE);
  }

  get currentStage(): StageName {
    return this.state.current_stage;
  }

  set currentStage(stage: StageName) {
    this.state.current_stage = stage;
  }

  async reloadDescription(): Promise<DescriptionInfo> {
    if (this.state.input.description) {
      return readDescription(this.resolve(this.state.input.description));
    }
    return this.description;
  }

  resolve(value: string): string {
    return fromSessionRelative(this.dir, value);
  }

  relative(value: string): string {
    return toSessionRelative(this.dir, value);
  }

  artifact(...parts: string[]): string {
    return path.join(this.dir, ...parts);
  }

  async ensureDir(...parts: string[]): Promise<string> {
    const dir = this.artifact(...parts);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  stage(stage: StageName): StageState {
    return this.state.stages[stage];
  }

  setStage(stage: StageName, state: StageState): void {
    this.state.stages[stage] = state;
  }

  async save(): Promise<void> {
    this.state.updated_at = new Date().toISOString();
    await writeFileAtomic(this.path, stringify(this.state));
  }

  async refreshDirtyState(): Promise<void> {
    for (const stage of MANUAL_STAGES) {
      const state = this.state.stages[stage];
      if (state.status !== 'committed') {
        continue;
      }
      if (typeof state.segments !== 'string' || typeof state.segments_sha256 !== 'string') {
        continue;
      }
      const segmentsPath = this.resolve(state.segments);
      if (!(await pathExists(segmentsPath))) {
        state.status = 'dirty';
        continue;
      }
      const currentHash = await sha256File(segmentsPath);
      if (currentHash !== state.segments_sha256) {
        state.status = 'dirty';
      }
    }
  }

  async refreshMediaState(): Promise<void> {
    const expectedHash =
      typeof this.state.input.media_sha256 === 'string'
        ? this.state.input.media_sha256
        : typeof this.stage('audio').media_sha256 === 'string'
          ? this.stage('audio').media_sha256
          : undefined;
    if (!expectedHash) {
      return;
    }

    const currentHash = await sha256File(this.mediaPath);
    if (currentHash === expectedHash) {
      return;
    }

    this.state.input.media_sha256 = undefined;
    for (const stage of STAGES) {
      this.state.stages[stage] = { status: 'pending' };
    }
    this.state.current_stage = 'audio';
  }

  async assertCommittedClean(stage: ManualStageName): Promise<StageState> {
    await this.refreshDirtyState();
    const state = this.state.stages[stage];
    if (state.status !== 'committed') {
      throw new Error(
        `${stage} must be committed before continuing; current status is ${state.status}.`
      );
    }
    return state;
  }

  markRunning(stage: StageName): void {
    this.state.stages[stage] = {
      ...this.state.stages[stage],
      status: 'running',
      started_at: new Date().toISOString(),
      error: undefined
    };
    this.state.current_stage = stage;
  }

  markFailed(stage: StageName, error: unknown): void {
    this.state.stages[stage] = {
      ...this.state.stages[stage],
      status: 'failed',
      error: error instanceof Error ? error.message : String(error)
    };
    this.state.current_stage = stage;
  }
}

async function resolveExistingSessionTarget(
  target: string,
  mediaOverride?: string
): Promise<ResolvedSessionTarget> {
  const absoluteTarget = path.resolve(target);
  const targetStat = await stat(absoluteTarget);
  const dir = targetStat.isDirectory() ? absoluteTarget : path.dirname(absoluteTarget);
  const sessionPath = path.join(dir, SESSION_FILE);

  if (await pathExists(sessionPath)) {
    return resolveDirectoryTarget(dir, target, mediaOverride);
  }

  return {
    target,
    dir,
    description: await readDescription(undefined),
    mediaPath: mediaOverride ? path.resolve(dir, mediaOverride) : '',
    mediaOverride
  };
}

function createInitialStages(): Record<StageName, StageState> {
  return {
    audio: { status: 'pending' },
    transcript_raw: { status: 'pending' },
    transcript_work: { status: 'pending' },
    translation_work: { status: 'pending' },
    export: { status: 'pending' }
  };
}

interface ResolvedSessionTarget {
  target: string;
  dir: string;
  description: DescriptionInfo;
  mediaPath: string;
  mediaOverride?: string;
}

async function resolveSessionTarget(
  target: string,
  mediaOverride?: string
): Promise<ResolvedSessionTarget> {
  const absoluteTarget = path.resolve(target);
  const targetStat = await stat(absoluteTarget);

  if (targetStat.isDirectory()) {
    return resolveDirectoryTarget(absoluteTarget, target, mediaOverride);
  }

  if (path.basename(absoluteTarget) === SESSION_FILE) {
    return resolveDirectoryTarget(path.dirname(absoluteTarget), target, mediaOverride);
  }

  if (isMarkdownPath(absoluteTarget)) {
    const description = await readDescription(absoluteTarget);
    const dir = path.dirname(absoluteTarget);
    const mediaPath = resolveMediaPath(dir, description, mediaOverride);
    return { target, dir, description, mediaPath, mediaOverride };
  }

  if (isMediaPath(absoluteTarget)) {
    const dir = path.dirname(absoluteTarget);
    const descriptionPath = await findSingleDescription(dir, false);
    const description = await readDescription(descriptionPath);
    const mediaPath = mediaOverride ? path.resolve(dir, mediaOverride) : absoluteTarget;
    return { target, dir, description, mediaPath, mediaOverride };
  }

  throw new Error(`Unsupported target type: ${target}`);
}

async function resolveDirectoryTarget(
  dir: string,
  target: string,
  mediaOverride: string | undefined
): Promise<ResolvedSessionTarget> {
  const sessionPath = path.join(dir, SESSION_FILE);
  const session = (await pathExists(sessionPath))
    ? parseSession(await readFile(sessionPath, 'utf8'))
    : undefined;
  const descriptionPath =
    typeof session?.input?.description === 'string'
      ? fromSessionRelative(dir, session.input.description)
      : await findSingleDescription(dir, !session);
  const description = await readDescription(descriptionPath);
  const mediaPathFromSession =
    typeof session?.input?.media === 'string'
      ? fromSessionRelative(dir, session.input.media)
      : undefined;
  const mediaPath = mediaOverride
    ? path.resolve(dir, mediaOverride)
    : mediaPathFromSession
      ? mediaPathFromSession
      : resolveMediaPath(dir, description, undefined, await findSingleMedia(dir, !descriptionPath));
  return { target, dir, description, mediaPath, mediaOverride };
}

function resolveMediaPath(
  dir: string,
  description: DescriptionInfo,
  mediaOverride: string | undefined,
  fallbackMedia?: string
): string {
  if (mediaOverride) {
    return path.resolve(dir, mediaOverride);
  }
  if (description.frontmatter.media) {
    const baseDir = description.path ? path.dirname(description.path) : dir;
    return path.resolve(baseDir, description.frontmatter.media);
  }
  if (fallbackMedia) {
    return fallbackMedia;
  }
  throw new Error(
    'Media file is required. Provide a media target, description frontmatter media, or --media.'
  );
}

async function findSingleDescription(dir: string, required: boolean): Promise<string | undefined> {
  const entries = await readdir(dir, { withFileTypes: true });
  const markdowns = entries
    .filter((entry) => entry.isFile() && isMarkdownPath(entry.name))
    .map((entry) => path.join(dir, entry.name));

  if (markdowns.length === 1) {
    return markdowns[0];
  }
  if (markdowns.length > 1) {
    throw new Error(`Multiple description markdown files found in ${dir}`);
  }
  if (required) {
    return undefined;
  }
  return undefined;
}

async function findSingleMedia(dir: string, required: boolean): Promise<string | undefined> {
  const entries = await readdir(dir, { withFileTypes: true });
  const mediaFiles = entries
    .filter((entry) => entry.isFile() && isMediaPath(entry.name))
    .map((entry) => path.join(dir, entry.name));

  if (mediaFiles.length === 1) {
    return mediaFiles[0];
  }
  if (mediaFiles.length > 1) {
    throw new Error(`Multiple media files found in ${dir}`);
  }
  if (required) {
    throw new Error(`No media file found in ${dir}`);
  }
  return undefined;
}

function isMarkdownPath(filePath: string): boolean {
  return MARKDOWN_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function isMediaPath(filePath: string): boolean {
  return MEDIA_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function createSessionState(target: ResolvedSessionTarget, now: Date): SessionState {
  const createdAt = now.toISOString();
  const state: SessionState = {
    schema_version: 1,
    session_id: createSessionId(now),
    created_at: createdAt,
    updated_at: createdAt,
    current_stage: 'audio',
    input: {},
    stages: createInitialStages()
  };

  if (target.description.path) {
    state.input.description = toSessionRelative(target.dir, target.description.path);
  }
  state.input.media = toSessionRelative(target.dir, target.mediaPath);

  return state;
}

function createSessionId(now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
  return `${stamp}-${randomUUID().slice(0, 8)}`;
}

function parseSession(content: string): SessionState {
  return parse(content) as unknown as SessionState;
}

function normalizeSession(session: SessionState): SessionState {
  if (session.schema_version !== 1) {
    throw new Error(`Unsupported session schema version: ${String(session.schema_version)}`);
  }
  session.stages = { ...createInitialStages(), ...session.stages };
  if (!STAGES.includes(session.current_stage)) {
    throw new Error(`Invalid current_stage: ${String(session.current_stage)}`);
  }
  for (const stage of STAGES) {
    if (session.stages[stage].status === 'running') {
      session.stages[stage].status = 'failed';
      session.stages[stage].error = 'Stage was interrupted before completion.';
    }
  }
  return session;
}
