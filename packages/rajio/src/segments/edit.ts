import type { Segment, SegmentsFile } from '../types.js';
import { Session } from '../session/index.js';
import type { ManualStageName } from '../types.js';
import { readSegmentsFile, writeSegmentsFile } from './index.js';
import { assertMinimumSplitDurations, normalizeSplitGap, splitAroundMidpoint } from './split.js';

export type SegmentEditStage = 'transcript' | 'translation';

export interface SegmentEditContext {
  session: Session;
  stage: ManualStageName;
  filePath: string;
  file: SegmentsFile;
}

export interface SegmentEditUpdate {
  start?: number;
  end?: number;
  speaker?: string;
  ja?: string;
  zh?: string;
}

export async function loadSegmentEditContext(input: {
  sessionTarget: string;
  stage?: SegmentEditStage;
}): Promise<SegmentEditContext> {
  const session = await Session.load(input.sessionTarget);
  return resolveSegmentEditContext({ session, stage: input.stage });
}

export async function resolveSegmentEditContext(input: {
  session: Session;
  stage?: SegmentEditStage;
}): Promise<SegmentEditContext> {
  const stage = resolveManualStage(input.session, input.stage);
  const state = input.session.stage(stage);
  if (typeof state.segments !== 'string') {
    throw new Error(`${stage} does not have a work segments path.`);
  }
  const filePath = input.session.resolve(state.segments);
  return {
    session: input.session,
    stage,
    filePath,
    file: await readSegmentsFile(filePath)
  };
}

export async function persistSegmentEdit(context: SegmentEditContext): Promise<void> {
  await writeSegmentsFile(context.filePath, context.file, { validate: false });
  await context.session.refreshDirtyState();
  await context.session.save();
}

export function editSegment(file: SegmentsFile, id: string, update: SegmentEditUpdate): Segment {
  if (Object.values(update).every((value) => value === undefined)) {
    throw new Error('at least one field must be provided.');
  }
  const segment = findSegment(file, id);
  if (update.start !== undefined) {
    segment.start = update.start;
  }
  if (update.end !== undefined) {
    segment.end = update.end;
  }
  if (update.speaker !== undefined) {
    segment.speaker = update.speaker;
  }
  if (update.ja !== undefined) {
    segment.ja = update.ja;
  }
  if (update.zh !== undefined) {
    segment.zh = update.zh;
  }
  return segment;
}

export function splitSegment(
  file: SegmentsFile,
  id: string,
  input: {
    at: number;
    id1: string;
    id2: string;
    ja1: string;
    ja2: string;
    speaker1?: string;
    speaker2?: string;
    zh1?: string;
    zh2?: string;
    gap?: number;
  }
): Segment[] {
  const index = findSegmentIndex(file, id);
  const source = file.segments[index]!;
  const gap = normalizeSplitGap(input.gap, '--gap');
  const boundary = splitAroundMidpoint(input.at, gap);
  if (input.id1 === input.id2) {
    throw new Error('split ids must be different.');
  }
  assertAvailableId(file, input.id1, id);
  assertAvailableId(file, input.id2, id);
  if (source.zh !== undefined && (input.zh1 === undefined || input.zh2 === undefined)) {
    throw new Error('splitting a translated segment requires --zh1 and --zh2.');
  }

  const first: Segment = {
    ...source,
    id: input.id1,
    start: source.start,
    end: boundary.end,
    speaker: input.speaker1 ?? source.speaker,
    ja: input.ja1
  };
  const second: Segment = {
    ...source,
    id: input.id2,
    start: boundary.start,
    end: source.end,
    speaker: input.speaker2 ?? source.speaker,
    ja: input.ja2
  };
  if (input.zh1 !== undefined) {
    first.zh = input.zh1;
  } else {
    delete first.zh;
  }
  if (input.zh2 !== undefined) {
    second.zh = input.zh2;
  } else {
    delete second.zh;
  }
  assertMinimumSplitDurations(id, [first, second]);

  file.segments.splice(index, 1, first, second);
  return [first, second];
}

export function mergeSegments(
  file: SegmentsFile,
  id1: string,
  id2: string,
  input: {
    id: string;
    ja: string;
    speaker?: string;
    zh?: string;
  }
): Segment {
  const index1 = findSegmentIndex(file, id1);
  const index2 = findSegmentIndex(file, id2);
  if (index2 !== index1 + 1) {
    throw new Error(`${id1} and ${id2} must be adjacent in file order.`);
  }
  assertAvailableId(file, input.id, id1, id2);

  const first = file.segments[index1]!;
  const second = file.segments[index2]!;
  if ((first.zh !== undefined || second.zh !== undefined) && input.zh === undefined) {
    throw new Error('merging translated segments requires --zh.');
  }

  const merged: Segment = {
    ...first,
    id: input.id,
    start: first.start,
    end: second.end,
    speaker: input.speaker ?? mergeSpeakerLabels(first.speaker, second.speaker),
    ja: input.ja
  };
  if (input.zh !== undefined) {
    merged.zh = input.zh;
  } else {
    delete merged.zh;
  }

  file.segments.splice(index1, 2, merged);
  return merged;
}

export function deleteSegment(file: SegmentsFile, id: string): Segment {
  const index = findSegmentIndex(file, id);
  const [removed] = file.segments.splice(index, 1);
  return removed!;
}

function resolveManualStage(
  session: Session,
  stage: SegmentEditStage | undefined
): ManualStageName {
  if (stage === 'transcript') {
    return 'transcript_work';
  }
  if (stage === 'translation') {
    return 'translation_work';
  }
  if (session.currentStage === 'transcript_work' || session.currentStage === 'translation_work') {
    return session.currentStage;
  }
  throw new Error('current stage is not manual; pass --stage transcript or --stage translation.');
}

export function findSegment(file: SegmentsFile, id: string): Segment {
  return file.segments[findSegmentIndex(file, id)]!;
}

export function findSegmentIndex(file: SegmentsFile, id: string): number {
  const index = file.segments.findIndex((segment) => segment.id === id);
  if (index === -1) {
    throw new Error(`segment not found: ${id}`);
  }
  return index;
}

function assertAvailableId(file: SegmentsFile, id: string, ...allowedExistingIds: string[]): void {
  if (!id.trim()) {
    throw new Error('segment id must not be empty.');
  }
  const allowed = new Set(allowedExistingIds);
  const existing = file.segments.find((segment) => segment.id === id);
  if (existing && !allowed.has(existing.id)) {
    throw new Error(`segment id already exists: ${id}`);
  }
}

export function cloneSegment(segment: Segment): Segment {
  const next = { ...segment };
  if (segment.flags) {
    next.flags = [...segment.flags];
  }
  return next;
}

export function mergeSpeakerLabels(...values: string[]): string {
  return Array.from(new Set(values.flatMap(splitSpeakerLabels))).join(',');
}

function splitSpeakerLabels(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}
