import type { Segment } from '../types.js';
import {
  DEFAULT_SPLIT_GAP_SECONDS,
  MIN_SPLIT_GAP_SECONDS,
  MIN_SPLIT_SEGMENT_SECONDS,
  SEGMENT_TIME_EPSILON
} from './limits.js';

export function normalizeSplitGap(value: number | undefined, label = 'gap'): number {
  const gap = value ?? DEFAULT_SPLIT_GAP_SECONDS;
  if (!Number.isFinite(gap)) {
    throw new Error(`${label} must be a finite number.`);
  }
  if (gap < MIN_SPLIT_GAP_SECONDS) {
    throw new Error(`${label} must be at least ${MIN_SPLIT_GAP_SECONDS} seconds.`);
  }
  return gap;
}

export function splitAroundMidpoint(midpoint: number, gap: number): { end: number; start: number } {
  if (!Number.isFinite(midpoint)) {
    throw new Error('split midpoint must be a finite number.');
  }
  const halfGap = gap / 2;
  return {
    end: roundSegmentTime(midpoint - halfGap),
    start: roundSegmentTime(midpoint + halfGap)
  };
}

export function assertMinimumSplitDurations(sourceId: string, segments: Segment[]): void {
  for (const segment of segments) {
    if (segment.end - segment.start < MIN_SPLIT_SEGMENT_SECONDS - SEGMENT_TIME_EPSILON) {
      throw new Error(
        `split ${sourceId} would create segment ${segment.id} shorter than ${MIN_SPLIT_SEGMENT_SECONDS} seconds.`
      );
    }
  }
}

function roundSegmentTime(value: number): number {
  return Number(value.toFixed(6));
}
