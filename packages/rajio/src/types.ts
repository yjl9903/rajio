export const STAGES = [
  'audio',
  'transcript_raw',
  'transcript_work',
  'translation_work',
  'export'
] as const;

export type StageName = (typeof STAGES)[number];

export const CURRENT_STAGES = [...STAGES, 'done'] as const;

export type CurrentStageName = (typeof CURRENT_STAGES)[number];

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
  current_stage: CurrentStageName;
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
  chunking?: AudioChunkOptions;
}

export const SKIPPABLE_ISSUE_CODES = [
  'ja_line_hard_limit',
  'zh_line_hard_limit',
  'ja_line_break_can_merge_soft',
  'zh_line_break_can_merge_soft',
  'ja_line_break_hard_limit',
  'zh_line_break_hard_limit',
  'duration_too_short',
  'duration_too_long',
  'ja_reading_speed_limit',
  'zh_reading_speed_limit',
  'subtitle_gap_too_short',
  'ja_common_punctuation',
  'zh_common_punctuation',
  'ja_terminal_punctuation',
  'zh_terminal_punctuation',
  'ja_punctuation_only_line',
  'zh_punctuation_only_line',
  'ja_repeated_punctuation',
  'zh_repeated_punctuation'
] as const;

export type SkippableIssueCode = (typeof SKIPPABLE_ISSUE_CODES)[number];

export interface SegmentSkipCheck {
  code: SkippableIssueCode;
  reason: string;
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
  skip_checks?: SegmentSkipCheck[];
}

export interface SegmentsFile {
  version: 1;
  source: {
    kind: 'transcript' | 'translation';
    generated_at: string;
  };
  segments: Segment[];
}

export const ISSUE_LEVELS = ['fatal', 'error', 'warning'] as const;

export type IssueLevel = (typeof ISSUE_LEVELS)[number];

export interface ValidationIssue {
  level: IssueLevel;
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
