export const STAGES = [
  'audio',
  'transcript_raw',
  'transcript_work',
  'translation_work',
  'export'
] as const;

export type StageName = (typeof STAGES)[number];

export const MANUAL_STAGES = ['transcript_work', 'translation_work'] as const;

export type ManualStageName = (typeof MANUAL_STAGES)[number];

export const STAGE_STATUSES = [
  'pending',
  'running',
  'done',
  'waiting',
  'committed',
  'dirty',
  'failed'
] as const;

export type StageStatus = (typeof STAGE_STATUSES)[number];

export interface StageState {
  status: StageStatus;
  started_at?: string;
  completed_at?: string;
  error?: string;
  [key: string]: unknown;
}

export interface SessionAudioChunk {
  audio: string;
  start: number;
  end: number;
  size: number;
  sha256: string;
}

export interface SessionState {
  schema_version: 1;
  session_id: string;
  created_at: string;
  updated_at: string;
  current_stage: StageName;
  input: {
    description?: string;
    media?: string;
    media_sha256?: string;
  };
  stages: Record<StageName, StageState>;
}

export interface DescriptionInfo {
  path?: string;
  body: string;
  frontmatter: {
    media?: string;
    title?: string;
    url?: string;
    published_at?: string;
    [key: string]: unknown;
  };
}

export interface RuntimeConfig {
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  ffmpegBin: string;
  ffprobeBin: string;
}

export interface AudioChunkOptions {
  targetSeconds?: number;
  boundarySearchSeconds?: number;
  silenceNoiseDb?: number;
  silenceDurationSeconds?: number;
}

export interface ResolvedAudioChunkOptions {
  targetSeconds: number;
  boundarySearchSeconds: number;
  silenceNoiseDb: number;
  silenceDurationSeconds: number;
}

export interface AudioChunkingMetadata {
  strategy: 'silence_or_time';
  requested_target_seconds: number;
  effective_target_seconds: number;
  boundary_search_seconds: number;
  silence_noise_db: number;
  silence_duration_seconds: number;
  max_seconds: number;
  max_bytes: number;
}

export interface CliOptions {
  media?: string;
  continue: 'until-manual' | 'step';
  commit: boolean;
  agent: 'codex' | false | undefined;
  full: boolean;
  reset?: StageName;
  verbose: boolean;
  chunking?: AudioChunkOptions;
}

export interface Segment {
  id: string;
  start: number;
  end: number;
  speaker: string;
  ja: string;
  zh?: string;
  notes?: string;
  flags?: string[];
}

export interface SegmentsFile {
  version: 1;
  source: {
    kind: 'transcript' | 'translation';
    generated_at: string;
  };
  segments: Segment[];
}

export interface ValidationIssue {
  level: 'error' | 'warning';
  code: string;
  message: string;
  segmentId?: string;
}

export interface StageRunnerDeps {
  transcribe?: (input: {
    audioPath: string;
    mediaPath: string;
    description: DescriptionInfo;
    runtime: RuntimeConfig;
  }) => Promise<unknown>;
}
