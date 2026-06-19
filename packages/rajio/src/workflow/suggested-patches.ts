import { rm } from 'node:fs/promises';
import path from 'node:path';

import { stringify } from 'smol-toml';

import type { Segment, SegmentsFile, SessionAudioChunk } from '../types.js';
import { writeFileAtomic } from '../utils/fs.js';
import {
  SEGMENT_DURATION_LIMITS as DURATION_LIMITS,
  SEGMENT_TIME_EPSILON as TIME_EPSILON,
  SUBTITLE_GAP_LIMITS as GAP_LIMITS
} from '../segments/limits.js';
import { countSubtitleTextUnits, replaceOutsideSubtitleProtectedText } from '../segments/text.js';
import type { Session } from '../session/index.js';

type PatchConfidence = 'high' | 'medium' | 'low';

interface SuggestedPatchChunk {
  index: number;
  start: number;
  end: number;
}

interface MergeOperation {
  op: 'merge';
  reason: string;
  confidence: PatchConfidence;
  source_ids: string[];
  merged_id: string;
  ja: string;
}

interface EditOperation {
  op: 'edit';
  reason: string;
  confidence: PatchConfidence;
  segment_id: string;
  start?: number;
  end?: number;
  ja?: string;
}

interface DeleteOperation {
  op: 'delete';
  reason: string;
  confidence: PatchConfidence;
  segment_id: string;
}

type SuggestedPatchOperation = MergeOperation | EditOperation | DeleteOperation;

interface LongSegmentCandidate {
  segment: Segment;
  reasons: string[];
  chars: number;
  charsPerSecond?: number;
}

const SUGGESTED_PATCH_DIR = ['transcript', 'work', 'suggested-patches'];
const PUNCTUATION_CLEANUP_PASS = '01-punctuation-cleanup';
const FRAGMENT_MERGE_PASS = '02-fragment-merge';
const BOUNDARY_RETIME_PASS = '03-boundary-retime';
const LONG_SEGMENT_PASS = '04-long-segment-candidates';

const MIN_CLUSTER_SECONDS = DURATION_LIMITS.shortHard;
const MAX_FRAGMENT_CLUSTER_SECONDS = 2;
const MAX_FLICKER_CLUSTER_SECONDS = 1.5;
const MAX_FRAGMENT_CHARS = 28;
const MAX_FLICKER_CHARS = 18;
const MIN_RETIME_GAP = -0.12;
const MAX_RETIME_GAP = GAP_LIMITS.soft;
const ORDINARY_SUBTITLE_PUNCTUATION = /[。．.,，、]+/gu;
const TERMINAL_SUBTITLE_PUNCTUATION_WITH_CLOSERS = /[。．.,，、;；:：…]+([\s"'”’）)」』】》]*)$/u;
const INLINE_WHITESPACE = /[^\S\r\n]+/g;

export async function generateTranscriptWorkSuggestedPatches(input: {
  session: Session;
  source: SegmentsFile;
}): Promise<void> {
  const outputDir = input.session.artifact(...SUGGESTED_PATCH_DIR);
  await rm(outputDir, { recursive: true, force: true });

  const chunks = resolveSuggestedPatchChunks(input.session.audioChunks(), input.source.segments);
  const punctuationCleanup = collectPunctuationCleanupOperations(input.source, chunks);
  await writeOperationPatches({
    outputDir,
    pass: PUNCTUATION_CLEANUP_PASS,
    name: 'Punctuation cleanup suggestions',
    summary: 'Remove ordinary Japanese subtitle punctuation that rajio check flags.',
    chunks,
    groups: punctuationCleanup.groups
  });

  const cleanedSource: SegmentsFile = {
    ...input.source,
    segments: punctuationCleanup.segments
  };
  const fragmentMerge = collectFragmentMergeOperations(cleanedSource, chunks);
  await writeOperationPatches({
    outputDir,
    pass: FRAGMENT_MERGE_PASS,
    name: 'Fragment merge suggestions',
    summary: 'Merge short ASR fragments that look like one subtitle unit.',
    chunks,
    groups: fragmentMerge.groups
  });

  const boundaryRetimes = collectBoundaryRetimeOperations(
    cleanedSource,
    chunks,
    fragmentMerge.touchedSegmentIds
  );
  await writeOperationPatches({
    outputDir,
    pass: BOUNDARY_RETIME_PASS,
    name: 'Boundary retime suggestions',
    summary: 'Prefer 150ms subtitle gaps and fall back to 50ms when needed.',
    chunks,
    groups: boundaryRetimes
  });

  await writeLongSegmentReports({
    outputDir,
    chunks,
    groups: collectLongSegmentCandidates(cleanedSource, chunks)
  });
}

function collectPunctuationCleanupOperations(
  source: SegmentsFile,
  chunks: SuggestedPatchChunk[]
): { groups: Map<string, SuggestedPatchOperation[]>; segments: Segment[] } {
  const groups = new Map<string, SuggestedPatchOperation[]>();
  const segments: Segment[] = [];

  for (const segment of source.segments) {
    const ja = cleanJapaneseSubtitlePunctuation(segment.ja);
    const chunk = chunkForTime(chunks, segment.start);
    if (!ja.trim()) {
      addOperation(groups, PUNCTUATION_CLEANUP_PASS, 'high', chunk, {
        op: 'delete',
        reason: 'Japanese text contains only subtitle punctuation after cleanup.',
        confidence: 'high',
        segment_id: segment.id
      });
      continue;
    }

    const cleanedSegment = ja === segment.ja ? segment : { ...segment, ja };
    segments.push(cleanedSegment);
    if (ja !== segment.ja) {
      addOperation(groups, PUNCTUATION_CLEANUP_PASS, 'high', chunk, {
        op: 'edit',
        reason: 'Remove ordinary punctuation from Japanese subtitle text.',
        confidence: 'high',
        segment_id: segment.id,
        ja
      });
    }
  }

  return { groups, segments };
}

export function cleanJapaneseSubtitlePunctuation(value: string): string {
  return value.split(/\r?\n/).map(cleanJapaneseSubtitlePunctuationLine).join('\n').trim();
}

function cleanJapaneseSubtitlePunctuationLine(value: string): string {
  return replaceOutsideSubtitleProtectedText(value, (text, isLast) => {
    let line = text;
    if (isLast) {
      let previous: string;
      do {
        previous = line;
        line = line.replace(TERMINAL_SUBTITLE_PUNCTUATION_WITH_CLOSERS, '$1');
      } while (line !== previous);
    }
    return line.replace(ORDINARY_SUBTITLE_PUNCTUATION, ' ').replace(INLINE_WHITESPACE, ' ');
  }).trim();
}

function collectFragmentMergeOperations(
  source: SegmentsFile,
  chunks: SuggestedPatchChunk[]
): { groups: Map<string, SuggestedPatchOperation[]>; touchedSegmentIds: Set<string> } {
  const groups = new Map<string, SuggestedPatchOperation[]>();
  const touchedSegmentIds = new Set<string>();

  for (let index = 0; index < source.segments.length; index += 1) {
    if (touchedSegmentIds.has(source.segments[index]!.id)) {
      continue;
    }
    const candidate =
      findSameSpeakerMergeCandidate(source.segments, chunks, index, touchedSegmentIds) ??
      findSpeakerFlickerMergeCandidate(source.segments, chunks, index, touchedSegmentIds);
    if (!candidate) {
      continue;
    }

    const operation: MergeOperation = {
      op: 'merge',
      reason: candidate.reason,
      confidence: candidate.confidence,
      source_ids: candidate.segments.map((segment) => segment.id),
      merged_id: candidate.segments[0]!.id,
      ja: candidate.segments.map((segment) => segment.ja.trim()).join('')
    };
    addOperation(groups, FRAGMENT_MERGE_PASS, candidate.confidence, candidate.chunk, operation);
    for (const segment of candidate.segments) {
      touchedSegmentIds.add(segment.id);
    }
    index += candidate.segments.length - 1;
  }

  return { groups, touchedSegmentIds };
}

function findSameSpeakerMergeCandidate(
  segments: Segment[],
  chunks: SuggestedPatchChunk[],
  startIndex: number,
  touchedSegmentIds: Set<string>
): FragmentMergeCandidate | undefined {
  return findLongestMergeCandidate(segments, chunks, startIndex, touchedSegmentIds, (candidate) => {
    const first = candidate.segments[0]!;
    if (!candidate.segments.every((segment) => segment.speaker === first.speaker)) {
      return false;
    }
    if (!candidate.segments.every((segment) => isShortFragment(segment))) {
      return false;
    }
    return {
      confidence: 'high',
      reason: 'Same-speaker adjacent short fragments form one readable subtitle unit.'
    };
  });
}

function findSpeakerFlickerMergeCandidate(
  segments: Segment[],
  chunks: SuggestedPatchChunk[],
  startIndex: number,
  touchedSegmentIds: Set<string>
): FragmentMergeCandidate | undefined {
  return findLongestMergeCandidate(segments, chunks, startIndex, touchedSegmentIds, (candidate) => {
    const speakers = new Set(candidate.segments.map((segment) => segment.speaker));
    if (speakers.size < 2) {
      return false;
    }
    if (speakerChangeCount(candidate.segments) < 2) {
      return false;
    }
    if (!candidate.segments.every((segment) => isVeryShortFragment(segment))) {
      return false;
    }
    if (candidate.duration > MAX_FLICKER_CLUSTER_SECONDS + TIME_EPSILON) {
      return false;
    }
    if (candidate.chars > MAX_FLICKER_CHARS) {
      return false;
    }
    return {
      confidence: 'low',
      reason:
        'Short adjacent fragments have rapidly changing speakers and look like diarization flicker.'
    };
  });
}

interface FragmentMergeCandidateInput {
  segments: Segment[];
  duration: number;
  chars: number;
}

interface FragmentMergeCandidate {
  segments: Segment[];
  chunk: SuggestedPatchChunk;
  confidence: PatchConfidence;
  reason: string;
}

function findLongestMergeCandidate(
  segments: Segment[],
  chunks: SuggestedPatchChunk[],
  startIndex: number,
  touchedSegmentIds: Set<string>,
  accept: (
    candidate: FragmentMergeCandidateInput
  ) => false | { confidence: PatchConfidence; reason: string }
): FragmentMergeCandidate | undefined {
  let best: FragmentMergeCandidate | undefined;

  for (let length = 2; length <= 6 && startIndex + length <= segments.length; length += 1) {
    const candidateSegments = segments.slice(startIndex, startIndex + length);
    if (candidateSegments.some((segment) => touchedSegmentIds.has(segment.id))) {
      break;
    }
    const chunk = commonChunk(candidateSegments, chunks);
    if (!chunk) {
      break;
    }
    if (!hasAdjacentMergeGaps(candidateSegments)) {
      break;
    }

    const duration = candidateSegments.at(-1)!.end - candidateSegments[0]!.start;
    const chars = candidateSegments.reduce(
      (total, segment) => total + countSubtitleTextUnits(segment.ja),
      0
    );
    if (duration < MIN_CLUSTER_SECONDS - TIME_EPSILON) {
      continue;
    }
    if (duration > MAX_FRAGMENT_CLUSTER_SECONDS + TIME_EPSILON) {
      break;
    }
    if (chars > MAX_FRAGMENT_CHARS) {
      break;
    }
    if (!candidateSegments.some((segment) => isTinyAnchor(segment))) {
      continue;
    }

    const accepted = accept({ segments: candidateSegments, duration, chars });
    if (!accepted) {
      continue;
    }
    best = {
      segments: candidateSegments,
      chunk,
      confidence: accepted.confidence,
      reason: accepted.reason
    };
  }

  return best;
}

function collectBoundaryRetimeOperations(
  source: SegmentsFile,
  chunks: SuggestedPatchChunk[],
  excludedSegmentIds: Set<string>
): Map<string, SuggestedPatchOperation[]> {
  const groups = new Map<string, SuggestedPatchOperation[]>();
  const segments = source.segments.map((segment) => ({ ...segment }));

  for (let index = 1; index < segments.length; index += 1) {
    const previous = segments[index - 1]!;
    const segment = segments[index]!;
    if (excludedSegmentIds.has(previous.id) || excludedSegmentIds.has(segment.id)) {
      continue;
    }
    if (!hasValidDuration(previous) || !hasValidDuration(segment)) {
      continue;
    }
    const chunk = commonChunk([previous, segment], chunks);
    if (!chunk) {
      continue;
    }

    const gap = segment.start - previous.end;
    if (gap < MIN_RETIME_GAP - TIME_EPSILON || gap >= MAX_RETIME_GAP - TIME_EPSILON) {
      continue;
    }

    const retime = chooseBoundaryRetime(previous, segment, gap);
    if (!retime) {
      continue;
    }

    previous.end = retime.previousEnd;
    segment.start = retime.segmentStart;
    addOperation(groups, BOUNDARY_RETIME_PASS, 'high', chunk, {
      op: 'edit',
      reason: retime.reason,
      confidence: 'high',
      segment_id: previous.id,
      end: retime.previousEnd
    });
    addOperation(groups, BOUNDARY_RETIME_PASS, 'high', chunk, {
      op: 'edit',
      reason: retime.reason,
      confidence: 'high',
      segment_id: segment.id,
      start: retime.segmentStart
    });
  }

  return groups;
}

function chooseBoundaryRetime(
  previous: Segment,
  segment: Segment,
  gap: number
): { previousEnd: number; segmentStart: number; reason: string } | undefined {
  const soft = boundaryRetimeForGap(
    previous,
    segment,
    GAP_LIMITS.soft,
    'Insert a 150ms subtitle gap at a short boundary.'
  );
  if (soft) {
    return soft;
  }
  if (gap >= GAP_LIMITS.hard - TIME_EPSILON) {
    return undefined;
  }
  return boundaryRetimeForGap(
    previous,
    segment,
    GAP_LIMITS.hard,
    'Insert a 50ms hard-minimum subtitle gap at a tight boundary.'
  );
}

function boundaryRetimeForGap(
  previous: Segment,
  segment: Segment,
  targetGap: number,
  reason: string
): { previousEnd: number; segmentStart: number; reason: string } | undefined {
  const midpoint = (previous.end + segment.start) / 2;
  const previousEnd = roundSegmentTime(midpoint - targetGap / 2);
  const segmentStart = roundSegmentTime(midpoint + targetGap / 2);
  if (
    previousEnd - previous.start < DURATION_LIMITS.shortHard - TIME_EPSILON ||
    segment.end - segmentStart < DURATION_LIMITS.shortHard - TIME_EPSILON
  ) {
    return undefined;
  }
  return { previousEnd, segmentStart, reason };
}

function collectLongSegmentCandidates(
  source: SegmentsFile,
  chunks: SuggestedPatchChunk[]
): Map<string, LongSegmentCandidate[]> {
  const groups = new Map<string, LongSegmentCandidate[]>();
  for (const segment of source.segments) {
    const duration = segment.end - segment.start;
    const chars = countSubtitleTextUnits(segment.ja);
    const reasons: string[] = [];
    if (duration > DURATION_LIMITS.longHard) {
      reasons.push(`duration ${formatSeconds(duration)}s exceeds ${DURATION_LIMITS.longHard}s`);
    }
    if (chars > 28) {
      reasons.push(`Japanese text has ${chars} non-space chars`);
    }
    const charsPerSecond = hasValidDuration(segment) ? chars / duration : undefined;
    if (charsPerSecond !== undefined && charsPerSecond > 20) {
      reasons.push(`reading speed is ${formatRate(charsPerSecond)} chars/s`);
    }
    if (reasons.length === 0) {
      continue;
    }
    const chunk = chunkForTime(chunks, segment.start);
    const key = groupKey(LONG_SEGMENT_PASS, 'low', chunk);
    const candidates = groups.get(key) ?? [];
    candidates.push({ segment, reasons, chars, charsPerSecond });
    groups.set(key, candidates);
  }
  return groups;
}

async function writeOperationPatches(input: {
  outputDir: string;
  pass: string;
  name: string;
  summary: string;
  chunks: SuggestedPatchChunk[];
  groups: Map<string, SuggestedPatchOperation[]>;
}): Promise<void> {
  for (const [key, operations] of input.groups) {
    if (operations.length === 0) {
      continue;
    }
    const { confidence, chunk } = parseGroupKey(key, input.chunks);
    const filePath = path.join(
      input.outputDir,
      patchFileName(input.pass, chunk, confidence, 'toml')
    );
    await writeFileAtomic(
      filePath,
      stringify({
        name: input.name,
        summary: `${input.summary} ${formatChunkSummary(chunk)}`,
        created_by: 'rajio',
        start: chunk.start,
        end: chunk.end,
        operations
      })
    );
  }
}

async function writeLongSegmentReports(input: {
  outputDir: string;
  chunks: SuggestedPatchChunk[];
  groups: Map<string, LongSegmentCandidate[]>;
}): Promise<void> {
  for (const [key, candidates] of input.groups) {
    if (candidates.length === 0) {
      continue;
    }
    const { confidence, chunk } = parseGroupKey(key, input.chunks);
    const filePath = path.join(
      input.outputDir,
      patchFileName(LONG_SEGMENT_PASS, chunk, confidence, 'md')
    );
    await writeFileAtomic(filePath, formatLongSegmentReport(chunk, candidates));
  }
}

function addOperation(
  groups: Map<string, SuggestedPatchOperation[]>,
  pass: string,
  confidence: PatchConfidence,
  chunk: SuggestedPatchChunk,
  operation: SuggestedPatchOperation
): void {
  const key = groupKey(pass, confidence, chunk);
  const operations = groups.get(key) ?? [];
  operations.push(operation);
  groups.set(key, operations);
}

function resolveSuggestedPatchChunks(
  audioChunks: SessionAudioChunk[],
  segments: Segment[]
): SuggestedPatchChunk[] {
  if (audioChunks.length > 0) {
    return audioChunks.map((chunk, index) => ({
      index,
      start: chunk.start,
      end: chunk.end
    }));
  }
  return [
    {
      index: 0,
      start: 0,
      end: Math.max(0, ...segments.map((segment) => segment.end).filter(Number.isFinite))
    }
  ];
}

function commonChunk(
  segments: Segment[],
  chunks: SuggestedPatchChunk[]
): SuggestedPatchChunk | undefined {
  const first = segments[0]!;
  const last = segments.at(-1)!;
  const chunk = chunkForTime(chunks, first.start);
  if (last.end > chunk.end + TIME_EPSILON || first.start < chunk.start - TIME_EPSILON) {
    return undefined;
  }
  if (segments.some((segment) => chunkForTime(chunks, segment.start).index !== chunk.index)) {
    return undefined;
  }
  return chunk;
}

function chunkForTime(chunks: SuggestedPatchChunk[], time: number): SuggestedPatchChunk {
  return (
    chunks.find((chunk) => time >= chunk.start - TIME_EPSILON && time < chunk.end - TIME_EPSILON) ??
    chunks.at(-1)!
  );
}

function hasAdjacentMergeGaps(segments: Segment[]): boolean {
  for (let index = 1; index < segments.length; index += 1) {
    const gap = segments[index]!.start - segments[index - 1]!.end;
    if (gap < MIN_RETIME_GAP - TIME_EPSILON || gap >= MAX_RETIME_GAP - TIME_EPSILON) {
      return false;
    }
  }
  return true;
}

function isShortFragment(segment: Segment): boolean {
  return (
    segment.end - segment.start <= 0.8 + TIME_EPSILON || countSubtitleTextUnits(segment.ja) <= 4
  );
}

function isVeryShortFragment(segment: Segment): boolean {
  return (
    segment.end - segment.start <= 0.55 + TIME_EPSILON || countSubtitleTextUnits(segment.ja) <= 3
  );
}

function isTinyAnchor(segment: Segment): boolean {
  return (
    segment.end - segment.start <= 0.5 + TIME_EPSILON || countSubtitleTextUnits(segment.ja) <= 2
  );
}

function speakerChangeCount(segments: Segment[]): number {
  let count = 0;
  for (let index = 1; index < segments.length; index += 1) {
    if (segments[index]!.speaker !== segments[index - 1]!.speaker) {
      count += 1;
    }
  }
  return count;
}

function hasValidDuration(segment: Segment): boolean {
  return segment.end > segment.start;
}

function roundSegmentTime(value: number): number {
  return Number(value.toFixed(6));
}

function groupKey(pass: string, confidence: PatchConfidence, chunk: SuggestedPatchChunk): string {
  return `${pass}\0${confidence}\0${chunk.index}`;
}

function parseGroupKey(
  key: string,
  chunks: SuggestedPatchChunk[]
): { confidence: PatchConfidence; chunk: SuggestedPatchChunk } {
  const [, confidence, chunkIndex] = key.split('\0') as [string, PatchConfidence, string];
  return {
    confidence,
    chunk: chunks[Number(chunkIndex)]!
  };
}

function patchFileName(
  pass: string,
  chunk: SuggestedPatchChunk,
  confidence: PatchConfidence,
  extension: 'toml' | 'md'
): string {
  return `${pass}-chunk-${pad(chunk.index, 3)}-${formatFileSeconds(chunk.start)}s-${formatFileSeconds(
    chunk.end
  )}s-${confidence}.${extension}`;
}

function formatFileSeconds(value: number): string {
  return pad(Math.max(0, Math.round(value)), 6);
}

function formatChunkSummary(chunk: SuggestedPatchChunk): string {
  return `Chunk ${pad(chunk.index, 3)} covers ${formatSeconds(chunk.start)}s-${formatSeconds(
    chunk.end
  )}s.`;
}

function formatLongSegmentReport(
  chunk: SuggestedPatchChunk,
  candidates: LongSegmentCandidate[]
): string {
  const lines = [
    '# Long Segment Candidates',
    '',
    `Chunk: ${pad(chunk.index, 3)} (${formatSeconds(chunk.start)}s-${formatSeconds(chunk.end)}s)`,
    '',
    'These are review targets only. They are not segment patch operations.',
    ''
  ];
  for (const candidate of candidates) {
    const { segment } = candidate;
    lines.push(
      `- ${segment.id} ${formatSeconds(segment.start)}s-${formatSeconds(segment.end)}s ` +
        `speaker=${segment.speaker} chars=${candidate.chars}: ${candidate.reasons.join('; ')}`
    );
    lines.push(`  ja: ${segment.ja}`);
  }
  return `${lines.join('\n')}\n`;
}

function formatSeconds(value: number): string {
  return Number(value.toFixed(3)).toString();
}

function formatRate(value: number): string {
  return Number(value.toFixed(2)).toString();
}

function pad(value: number, length: number): string {
  return String(value).padStart(length, '0');
}
