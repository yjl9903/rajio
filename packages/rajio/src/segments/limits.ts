export const SEGMENT_TIME_EPSILON = 1e-3;

export const SEGMENT_DURATION_LIMITS = {
  shortSoft: 0.8,
  shortHard: 0.5,
  longSoft: 7,
  longHard: 10
} as const;

export const SUBTITLE_GAP_LIMITS = {
  soft: 0.25,
  hard: 0.08
} as const;

export const DEFAULT_SPLIT_GAP_SECONDS = SUBTITLE_GAP_LIMITS.hard;
export const MIN_SPLIT_GAP_SECONDS = SUBTITLE_GAP_LIMITS.hard;
export const MIN_SPLIT_SEGMENT_SECONDS = SEGMENT_DURATION_LIMITS.shortHard;
