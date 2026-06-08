import { parse } from 'smol-toml';
import { z } from 'zod';

import type { Segment, SegmentsFile } from '../types.js';
import {
  cloneSegment,
  deleteSegment,
  editSegment,
  findSegment,
  findSegmentIndex,
  mergeSpeakerLabels
} from './edit.js';
import { SEGMENT_TIME_EPSILON as SPLIT_TIME_EPSILON } from './limits.js';
import { assertMinimumSplitDurations, normalizeSplitGap, splitAroundMidpoint } from './split.js';

const editPatchSchema = z
  .object({
    id: z.string().min(1),
    start: z.number().finite().nonnegative().optional(),
    end: z.number().finite().positive().optional(),
    speaker: z.string().min(1).optional(),
    ja: z.string().optional(),
    zh: z.string().optional()
  })
  .strict()
  .refine(
    (segment) =>
      segment.start !== undefined ||
      segment.end !== undefined ||
      segment.speaker !== undefined ||
      segment.ja !== undefined ||
      segment.zh !== undefined,
    { message: 'edit must update at least one field.' }
  );

const splitSegmentSchema = z
  .object({
    id: z.string().min(1),
    start: z.number().finite().nonnegative(),
    end: z.number().finite().positive(),
    speaker: z.string().min(1),
    ja: z.string(),
    zh: z.string().optional()
  })
  .strict();

const splitPatchSchema = z
  .object({
    id: z.string().min(1),
    gap: z.number().finite().nonnegative().optional(),
    segments: z.array(splitSegmentSchema).min(2)
  })
  .strict();

const mergePatchSchema = z
  .object({
    ids: z.array(z.string().min(1)).min(2),
    id: z.string().min(1),
    speaker: z.string().min(1).optional(),
    ja: z.string(),
    zh: z.string().optional()
  })
  .strict();

const deletePatchSchema = z
  .object({
    id: z.string().min(1)
  })
  .strict();

const segmentPatchSchema = z
  .object({
    edits: z.array(editPatchSchema).optional(),
    splits: z.array(splitPatchSchema).optional(),
    merges: z.array(mergePatchSchema).optional(),
    deletes: z.array(deletePatchSchema).optional()
  })
  .strict()
  .refine(
    (patch) =>
      (patch.edits?.length ?? 0) > 0 ||
      (patch.splits?.length ?? 0) > 0 ||
      (patch.merges?.length ?? 0) > 0 ||
      (patch.deletes?.length ?? 0) > 0,
    { message: 'patch must contain at least one edit, split, merge, or delete.' }
  );

export type SegmentPatch = z.infer<typeof segmentPatchSchema>;

export interface SegmentPatchResult {
  edits: Segment[];
  splits: Segment[];
  merges: Segment[];
  deletes: Segment[];
}

export interface SegmentPatchResultStats {
  edits: number;
  splits: number;
  merges: number;
  deletes: number;
  total: number;
}

export function parseSegmentPatch(text: string): SegmentPatch {
  return segmentPatchSchema.parse(parse(text));
}

export function applySegmentPatch(file: SegmentsFile, patch: SegmentPatch): SegmentPatchResult {
  assertUniqueOperationTargets(patch);
  const next = cloneSegmentsFile(file);
  const result: SegmentPatchResult = { edits: [], splits: [], merges: [], deletes: [] };

  for (const edit of patch.edits ?? []) {
    editSegment(next, edit.id, {
      start: edit.start,
      end: edit.end,
      speaker: edit.speaker,
      ja: edit.ja,
      zh: edit.zh
    });
    result.edits.push(cloneSegment(findSegment(next, edit.id)));
  }

  for (const split of patch.splits ?? []) {
    result.splits.push(...applySplit(next, split).map(cloneSegment));
  }

  for (const merge of patch.merges ?? []) {
    result.merges.push(cloneSegment(applyMerge(next, merge)));
  }

  for (const deletion of patch.deletes ?? []) {
    result.deletes.push(cloneSegment(deleteSegment(next, deletion.id)));
  }

  assertUniqueFinalIds(next);
  file.segments = next.segments;
  return result;
}

export function summarizeSegmentPatchResult(patch: SegmentPatch): SegmentPatchResultStats {
  const edits = patch.edits?.length ?? 0;
  const splits = patch.splits?.length ?? 0;
  const merges = patch.merges?.length ?? 0;
  const deletes = patch.deletes?.length ?? 0;
  return {
    edits,
    splits,
    merges,
    deletes,
    total: edits + splits + merges + deletes
  };
}

function applySplit(
  file: SegmentsFile,
  split: NonNullable<SegmentPatch['splits']>[number]
): Segment[] {
  const index = findSegmentIndex(file, split.id);
  const source = file.segments[index]!;
  validateSplitCoverage(source, split.segments);
  if (source.zh !== undefined && split.segments.some((segment) => segment.zh === undefined)) {
    throw new Error(`splitting translated segment ${split.id} requires zh on every new segment.`);
  }
  const segments = insertSplitGaps(split.id, split.segments, normalizeSplitGap(split.gap));
  file.segments.splice(index, 1, ...segments);
  return segments;
}

function applyMerge(
  file: SegmentsFile,
  merge: NonNullable<SegmentPatch['merges']>[number]
): Segment {
  const indexes = merge.ids.map((id) => findSegmentIndex(file, id));
  for (let index = 1; index < indexes.length; index += 1) {
    if (indexes[index] !== indexes[index - 1]! + 1) {
      throw new Error(`merge ids must be adjacent in file order: ${merge.ids.join(', ')}`);
    }
  }

  const firstIndex = indexes[0]!;
  const sources = indexes.map((index) => file.segments[index]!);
  if (sources.some((segment) => segment.zh !== undefined) && merge.zh === undefined) {
    throw new Error(`merging translated segments requires zh: ${merge.ids.join(', ')}`);
  }
  const first = sources[0]!;
  const last = sources.at(-1)!;
  const merged: Segment = {
    ...first,
    id: merge.id,
    start: first.start,
    end: last.end,
    speaker: merge.speaker ?? mergeSpeakerLabels(...sources.map((segment) => segment.speaker)),
    ja: merge.ja
  };
  if (merge.zh !== undefined) {
    merged.zh = merge.zh;
  } else {
    delete merged.zh;
  }
  file.segments.splice(firstIndex, sources.length, merged);
  return merged;
}

function validateSplitCoverage(source: Segment, segments: Segment[]): void {
  if (!timesEqual(segments[0]!.start, source.start)) {
    throw new Error(`split ${source.id} must start at ${source.start}.`);
  }
  if (!timesEqual(segments.at(-1)!.end, source.end)) {
    throw new Error(`split ${source.id} must end at ${source.end}.`);
  }
  for (const [index, segment] of segments.entries()) {
    if (segment.end <= segment.start) {
      throw new Error(`split segment ${segment.id} end must be greater than start.`);
    }
    if (index > 0 && !timesEqual(segment.start, segments[index - 1]!.end)) {
      throw new Error(`split ${source.id} must be continuous with no gaps or overlaps.`);
    }
  }
}

function insertSplitGaps(sourceId: string, segments: Segment[], gap: number): Segment[] {
  const next = segments.map(cloneSegment);
  for (let index = 1; index < next.length; index += 1) {
    const previous = next[index - 1]!;
    const segment = next[index]!;
    const boundary = splitAroundMidpoint(segment.start, gap);
    previous.end = boundary.end;
    segment.start = boundary.start;
  }
  assertMinimumSplitDurations(sourceId, next);
  return next;
}

function timesEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= SPLIT_TIME_EPSILON;
}

function assertUniqueOperationTargets(patch: SegmentPatch): void {
  assertUniqueIds(
    (patch.edits ?? []).map((edit) => edit.id),
    'duplicate edit id'
  );
  assertUniqueIds(
    (patch.splits ?? []).map((split) => split.id),
    'duplicate split id'
  );
  for (const merge of patch.merges ?? []) {
    assertUniqueIds(merge.ids, 'duplicate merge source id');
  }
  assertUniqueIds(
    (patch.deletes ?? []).map((deletion) => deletion.id),
    'duplicate delete id'
  );
}

function assertUniqueFinalIds(file: SegmentsFile): void {
  assertUniqueIds(
    file.segments.map((segment) => segment.id),
    'duplicate final segment id'
  );
}

function assertUniqueIds(ids: string[], message: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      throw new Error(`${message}: ${id}`);
    }
    seen.add(id);
  }
}

function cloneSegmentsFile(file: SegmentsFile): SegmentsFile {
  return {
    ...file,
    source: { ...file.source },
    segments: file.segments.map(cloneSegment)
  };
}
