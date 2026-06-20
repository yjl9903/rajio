import { parse } from 'smol-toml';
import { z } from 'zod';

import type { Segment, SegmentsFile } from '../types.js';
import {
  cloneSegment,
  deleteSegment,
  editSegment,
  findSegment,
  findSegmentIndex,
  hasTranslatedText,
  insertSegment,
  mergeSpeakerLabels,
  withoutSkipChecks
} from './edit.js';
import { segmentIdSchema, segmentSkipCheckSchema } from './index.js';
import { SEGMENT_TIME_EPSILON as SPLIT_TIME_EPSILON } from './limits.js';
import { assertMinimumSplitDurations, normalizeSplitGap, splitAroundMidpoint } from './split.js';

const patchConfidenceSchema = z.enum(['high', 'medium', 'low']);

const operationMetadataSchema = {
  reason: z.string().trim().min(1).optional(),
  confidence: patchConfidenceSchema.optional()
};

const editOperationSchema = z
  .object({
    op: z.literal('edit'),
    ...operationMetadataSchema,
    segment_id: segmentIdSchema,
    start: z.number().nonnegative().optional(),
    end: z.number().positive().optional(),
    speaker: z.string().min(1).optional(),
    ja: z.string().optional(),
    zh: z.string().optional(),
    skip_checks: z.array(segmentSkipCheckSchema).optional()
  })
  .strict();

const splitReplacementSchema = z
  .object({
    segment_id: segmentIdSchema,
    start: z.number().nonnegative(),
    end: z.number().positive(),
    speaker: z.string().min(1),
    ja: z.string(),
    zh: z.string().optional()
  })
  .strict();

const splitOperationSchema = z
  .object({
    op: z.literal('split'),
    ...operationMetadataSchema,
    source_id: segmentIdSchema,
    gap: z.number().nonnegative().optional(),
    replacements: z.array(splitReplacementSchema).min(2)
  })
  .strict();

const mergeOperationSchema = z
  .object({
    op: z.literal('merge'),
    ...operationMetadataSchema,
    source_ids: z.array(segmentIdSchema).min(2),
    merged_id: segmentIdSchema,
    speaker: z.string().min(1).optional(),
    ja: z.string(),
    zh: z.string().optional()
  })
  .strict();

const insertOperationSchema = z
  .object({
    op: z.literal('insert'),
    ...operationMetadataSchema,
    segment_id: segmentIdSchema,
    start: z.number().nonnegative(),
    end: z.number().positive(),
    speaker: z.string().min(1),
    ja: z.string(),
    zh: z.string().optional()
  })
  .strict();

const deleteOperationSchema = z
  .object({
    op: z.literal('delete'),
    ...operationMetadataSchema,
    segment_id: segmentIdSchema
  })
  .strict();

const segmentPatchOperationSchema = z
  .discriminatedUnion('op', [
    editOperationSchema,
    splitOperationSchema,
    mergeOperationSchema,
    insertOperationSchema,
    deleteOperationSchema
  ])
  .superRefine((operation, context) => {
    if (
      operation.op === 'edit' &&
      operation.start === undefined &&
      operation.end === undefined &&
      operation.speaker === undefined &&
      operation.ja === undefined &&
      operation.zh === undefined &&
      operation.skip_checks === undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'edit must update at least one field.'
      });
    }
  });

const segmentPatchSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    summary: z.string().trim().min(1).optional(),
    created_by: z.string().trim().min(1).optional(),
    start: z.number().nonnegative().optional(),
    end: z.number().positive().optional(),
    operations: z.array(segmentPatchOperationSchema).min(1)
  })
  .strict()
  .superRefine((patch, context) => {
    if (patch.start !== undefined && patch.end !== undefined && patch.end <= patch.start) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'patch end must be greater than start.'
      });
    }
  });

export type SegmentPatch = z.infer<typeof segmentPatchSchema>;
type SegmentPatchOperation = z.infer<typeof segmentPatchOperationSchema>;

export interface SegmentPatchResult {
  edits: Segment[];
  splits: Segment[];
  merges: Segment[];
  inserts: Segment[];
  deletes: Segment[];
  affected: Segment[];
}

export interface SegmentPatchResultStats {
  edits: number;
  splits: number;
  merges: number;
  inserts: number;
  deletes: number;
  total: number;
}

export function parseSegmentPatch(text: string): SegmentPatch {
  return segmentPatchSchema.parse(parse(text));
}

export function applySegmentPatch(file: SegmentsFile, patch: SegmentPatch): SegmentPatchResult {
  return applySegmentPatchWithOptions(file, patch);
}

export function applySegmentPatchWithOptions(
  file: SegmentsFile,
  patch: SegmentPatch,
  options: { requireZhForInserts?: boolean } = {}
): SegmentPatchResult {
  patch = segmentPatchSchema.parse(patch);
  const next = cloneSegmentsFile(file);
  const requireZhForInserts = options.requireZhForInserts ?? next.source.kind === 'translation';
  const result: SegmentPatchResult = {
    edits: [],
    splits: [],
    merges: [],
    inserts: [],
    deletes: [],
    affected: []
  };

  for (const operation of patch.operations) {
    applyOperation(next, operation, result, { requireZhForInserts });
    assertUniqueCurrentIds(next);
  }

  file.segments = next.segments;
  return result;
}

export function summarizeSegmentPatchResult(patch: SegmentPatch): SegmentPatchResultStats {
  const edits = patch.operations.filter((operation) => operation.op === 'edit').length;
  const splits = patch.operations.filter((operation) => operation.op === 'split').length;
  const merges = patch.operations.filter((operation) => operation.op === 'merge').length;
  const inserts = patch.operations.filter((operation) => operation.op === 'insert').length;
  const deletes = patch.operations.filter((operation) => operation.op === 'delete').length;
  return {
    edits,
    splits,
    merges,
    inserts,
    deletes,
    total: edits + splits + merges + inserts + deletes
  };
}

function applyOperation(
  file: SegmentsFile,
  operation: SegmentPatchOperation,
  result: SegmentPatchResult,
  options: { requireZhForInserts?: boolean }
): void {
  if (operation.op === 'edit') {
    editSegment(file, operation.segment_id, {
      start: operation.start,
      end: operation.end,
      speaker: operation.speaker,
      ja: operation.ja,
      zh: operation.zh,
      skipChecks: operation.skip_checks
    });
    const segment = cloneSegment(findSegment(file, operation.segment_id));
    result.edits.push(segment);
    result.affected.push(segment);
    return;
  }
  if (operation.op === 'split') {
    const segments = applySplit(file, operation).map(cloneSegment);
    result.splits.push(...segments);
    result.affected.push(...segments);
    return;
  }
  if (operation.op === 'merge') {
    const segment = cloneSegment(applyMerge(file, operation));
    result.merges.push(segment);
    result.affected.push(segment);
    return;
  }
  if (operation.op === 'insert') {
    const segment = cloneSegment(
      insertSegment(file, {
        id: operation.segment_id,
        start: operation.start,
        end: operation.end,
        speaker: operation.speaker,
        ja: operation.ja,
        zh: operation.zh,
        requireZh: options.requireZhForInserts
      })
    );
    result.inserts.push(segment);
    result.affected.push(segment);
    return;
  }
  const segment = cloneSegment(deleteSegment(file, operation.segment_id));
  result.deletes.push(segment);
  result.affected.push(segment);
}

function applySplit(
  file: SegmentsFile,
  split: Extract<SegmentPatchOperation, { op: 'split' }>
): Segment[] {
  const index = findSegmentIndex(file, split.source_id);
  const source = file.segments[index]!;
  const replacements = split.replacements.map((segment) => ({
    id: segment.segment_id,
    start: segment.start,
    end: segment.end,
    speaker: segment.speaker,
    ja: segment.ja,
    ...(segment.zh !== undefined ? { zh: segment.zh } : {})
  }));
  validateSplitCoverage(source, replacements);
  if (hasTranslatedText(source) && replacements.some((segment) => segment.zh === undefined)) {
    throw new Error(
      `splitting translated segment ${split.source_id} requires zh on every new segment.`
    );
  }
  const segments = insertSplitGaps(split.source_id, replacements, normalizeSplitGap(split.gap));
  file.segments.splice(index, 1, ...segments);
  return segments;
}

function applyMerge(
  file: SegmentsFile,
  merge: Extract<SegmentPatchOperation, { op: 'merge' }>
): Segment {
  assertUniqueIds(merge.source_ids, 'duplicate merge source id');
  const indexes = merge.source_ids.map((id) => findSegmentIndex(file, id));
  for (let index = 1; index < indexes.length; index += 1) {
    if (indexes[index] !== indexes[index - 1]! + 1) {
      throw new Error(
        `merge source_ids must be adjacent in file order: ${merge.source_ids.join(', ')}`
      );
    }
  }

  const firstIndex = indexes[0]!;
  const sources = indexes.map((index) => file.segments[index]!);
  if (sources.some((segment) => hasTranslatedText(segment)) && merge.zh === undefined) {
    throw new Error(`merging translated segments requires zh: ${merge.source_ids.join(', ')}`);
  }
  const first = sources[0]!;
  const last = sources.at(-1)!;
  const merged: Segment = {
    ...withoutSkipChecks(first),
    id: merge.merged_id,
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

function assertUniqueCurrentIds(file: SegmentsFile): void {
  assertUniqueIds(
    file.segments.map((segment) => segment.id),
    'duplicate current segment id'
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
