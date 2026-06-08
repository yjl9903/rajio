import { randomUUID } from 'node:crypto';
import { readdir, readFile, rm, stat } from 'node:fs/promises';
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
  SessionAudioChunk,
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
    'patches',
    'clips',
    'output'
  ];

  readonly dir: string;
  readonly description: DescriptionInfo;
  readonly mediaPath: string;
  state: SessionState;

  private constructor(input: {
    dir: string;
    description: DescriptionInfo;
    mediaPath: string;
    state: SessionState;
  }) {
    this.dir = input.dir;
    this.description = input.description;
    this.mediaPath = input.mediaPath;
    this.state = input.state;
  }

  static async loadOrCreate(target: string, mediaOverride?: string): Promise<Session> {
    return Session.loadResolved(await resolveSessionTarget(target, mediaOverride), true);
  }

  static async load(target: string, mediaOverride?: string): Promise<Session> {
    return Session.loadResolved(await resolveExistingSessionTarget(target, mediaOverride), false);
  }

  private static async loadResolved(
    resolved: ResolvedSessionTarget,
    saveIfCreated: boolean
  ): Promise<Session> {
    const sessionPath = path.join(resolved.dir, SESSION_FILE);
    const exists = await pathExists(sessionPath);
    if (!exists && saveIfCreated) {
      await assertMediaFileExists(resolved.mediaPath);
    }
    const session = new Session({
      ...resolved,
      state: exists
        ? normalizeSession(parseSession(await readFile(sessionPath, 'utf8')))
        : createSessionState(resolved, new Date())
    });
    if (!exists && saveIfCreated) {
      await session.save();
    }
    return session;
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

  resolve(value: string): string {
    return fromSessionRelative(this.dir, value);
  }

  artifact(...parts: string[]): string {
    return path.join(this.dir, ...parts);
  }

  stage(stage: StageName): StageState {
    return this.state.stages[stage];
  }

  updateStage(stage: StageName, patch: Partial<StageState>): StageState {
    const next = {
      ...this.state.stages[stage],
      ...patch
    };
    this.state.stages[stage] = next;
    return next;
  }

  audioChunks(): SessionAudioChunk[] {
    return normalizeSessionAudioChunks(this.stage('audio').chunks);
  }

  setMediaHash(hash: string): void {
    this.state.input.media_sha256 = hash;
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

  async refreshMediaState(): Promise<boolean> {
    const expectedHash =
      typeof this.state.input.media_sha256 === 'string'
        ? this.state.input.media_sha256
        : typeof this.stage('audio').media_sha256 === 'string'
          ? this.stage('audio').media_sha256
          : undefined;
    if (!expectedHash) {
      return false;
    }

    const currentHash = await sha256File(this.mediaPath);
    if (currentHash === expectedHash) {
      return false;
    }

    this.state.input.media_sha256 = undefined;
    for (const stage of STAGES) {
      this.state.stages[stage] = { status: 'pending' };
    }
    this.state.current_stage = 'audio';
    return true;
  }

  markRunning(stage: StageName): void {
    this.updateStage(stage, {
      status: 'running',
      started_at: new Date().toISOString(),
      error: undefined
    });
    this.state.current_stage = stage;
  }

  markDone(stage: StageName): void {
    this.updateStage(stage, {
      status: 'done',
      completed_at: new Date().toISOString(),
      error: undefined
    });
  }

  markFailed(stage: StageName, error: unknown): void {
    this.updateStage(stage, {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error)
    });
    this.state.current_stage = stage;
  }
}

function normalizeSessionAudioChunks(value: unknown): SessionAudioChunk[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const chunks: SessionAudioChunk[] = [];
  for (const item of value) {
    const chunk = item as Partial<SessionAudioChunk>;
    const start = Number(chunk.start);
    const end = Number(chunk.end);
    if (
      typeof chunk.audio !== 'string' ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      !Number.isFinite(chunk.size ?? NaN) ||
      typeof chunk.sha256 !== 'string' ||
      end < start
    ) {
      return [];
    }
    chunks.push({
      audio: chunk.audio,
      start,
      end,
      size: chunk.size as number,
      sha256: chunk.sha256
    });
  }
  return chunks;
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
    return resolveDirectoryTarget(dir, mediaOverride);
  }

  return {
    dir,
    description: await readDescription(undefined),
    mediaPath: mediaOverride ? resolveCliPath(mediaOverride) : ''
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
  dir: string;
  description: DescriptionInfo;
  mediaPath: string;
}

async function resolveSessionTarget(
  target: string,
  mediaOverride?: string
): Promise<ResolvedSessionTarget> {
  const absoluteTarget = path.resolve(target);
  const targetStat = await stat(absoluteTarget);

  if (targetStat.isDirectory()) {
    return resolveDirectoryTarget(absoluteTarget, mediaOverride);
  }

  if (path.basename(absoluteTarget) === SESSION_FILE) {
    return resolveDirectoryTarget(path.dirname(absoluteTarget), mediaOverride);
  }

  if (isMarkdownPath(absoluteTarget)) {
    const description = await readDescription(absoluteTarget);
    const dir = path.dirname(absoluteTarget);
    const mediaPath = resolveMediaPath(dir, description, mediaOverride);
    return { dir, description, mediaPath };
  }

  if (isMediaPath(absoluteTarget)) {
    const dir = path.dirname(absoluteTarget);
    const descriptionPath = await findSingleDescription(dir);
    const description = await readDescription(descriptionPath);
    const mediaPath = mediaOverride ? resolveCliPath(mediaOverride) : absoluteTarget;
    return { dir, description, mediaPath };
  }

  throw new Error(`Unsupported target type: ${target}`);
}

async function resolveDirectoryTarget(
  dir: string,
  mediaOverride: string | undefined
): Promise<ResolvedSessionTarget> {
  const sessionPath = path.join(dir, SESSION_FILE);
  const session = (await pathExists(sessionPath))
    ? parseSession(await readFile(sessionPath, 'utf8'))
    : undefined;
  const descriptionPath =
    typeof session?.input?.description === 'string'
      ? fromSessionRelative(dir, session.input.description)
      : await findSingleDescription(dir);
  const description = await readDescription(descriptionPath);
  const mediaPathFromSession =
    typeof session?.input?.media === 'string'
      ? fromSessionRelative(dir, session.input.media)
      : undefined;
  const mediaPath = mediaOverride
    ? resolveCliPath(mediaOverride)
    : mediaPathFromSession
      ? mediaPathFromSession
      : resolveMediaPath(dir, description, undefined, await findSingleMedia(dir));
  return { dir, description, mediaPath };
}

function resolveMediaPath(
  dir: string,
  description: DescriptionInfo,
  mediaOverride: string | undefined,
  fallbackMedia?: string
): string {
  if (mediaOverride) {
    return resolveCliPath(mediaOverride);
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

async function findSingleDescription(dir: string): Promise<string | undefined> {
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
  return undefined;
}

async function findSingleMedia(dir: string): Promise<string | undefined> {
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
  return undefined;
}

function isMarkdownPath(filePath: string): boolean {
  return MARKDOWN_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function isMediaPath(filePath: string): boolean {
  return MEDIA_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function resolveCliPath(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(value);
}

async function assertMediaFileExists(mediaPath: string): Promise<void> {
  try {
    const mediaStat = await stat(mediaPath);
    if (mediaStat.isFile()) {
      return;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  throw new Error(`Media file not found: ${mediaPath}`);
}

function createSessionState(resolved: ResolvedSessionTarget, now: Date): SessionState {
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

  if (resolved.description.path) {
    state.input.description = toSessionRelative(resolved.dir, resolved.description.path);
  }
  state.input.media = toSessionRelative(resolved.dir, resolved.mediaPath);

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
