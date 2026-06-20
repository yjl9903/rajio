import type { Segment, SegmentSkipCheck, SegmentsFile } from '../types.js';
import { Session } from '../session/index.js';
import type { ManualStageName } from '../types.js';
import { assertSegmentId, readSegmentsFile, writeSegmentsFile } from './index.js';
import { SEGMENT_TIME_EPSILON } from './limits.js';
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
  skipChecks?: SegmentSkipCheck[];
  clearSkipChecks?: boolean;
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
  const hasSegmentFieldUpdate = [
    update.start,
    update.end,
    update.speaker,
    update.ja,
    update.zh,
    update.skipChecks
  ].some((value) => value !== undefined);
  if (!hasSegmentFieldUpdate && update.clearSkipChecks !== true) {
    throw new Error('at least one field must be provided.');
  }
  if (update.skipChecks !== undefined && update.clearSkipChecks === true) {
    throw new Error('skipChecks and clearSkipChecks are mutually exclusive.');
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
  if (update.skipChecks !== undefined) {
    if (update.skipChecks.length > 0) {
      segment.skip_checks = update.skipChecks;
    } else {
      delete segment.skip_checks;
    }
  }
  if (update.clearSkipChecks === true) {
    delete segment.skip_checks;
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
  if (hasTranslatedText(source) && (input.zh1 === undefined || input.zh2 === undefined)) {
    throw new Error('splitting a translated segment requires --zh1 and --zh2.');
  }

  const first: Segment = {
    ...withoutSkipChecks(source),
    id: input.id1,
    start: source.start,
    end: boundary.end,
    speaker: input.speaker1 ?? source.speaker,
    ja: input.ja1
  };
  const second: Segment = {
    ...withoutSkipChecks(source),
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

export function insertSegment(
  file: SegmentsFile,
  input: {
    id: string;
    start: number;
    end: number;
    speaker: string;
    ja: string;
    zh?: string;
    requireZh?: boolean;
  }
): Segment {
  assertSegmentId(input.id);
  if (file.segments.some((segment) => segment.id === input.id)) {
    throw new Error(`segment id already exists: ${input.id}`);
  }
  if (input.end <= input.start) {
    throw new Error(`Segment ${input.id} end must be greater than start.`);
  }
  if (input.speaker.length === 0) {
    throw new Error(`Segment ${input.id} has empty speaker.`);
  }
  if (!input.ja.trim()) {
    throw new Error(`Segment ${input.id} has empty Japanese text.`);
  }
  if (input.requireZh === true && !input.zh?.trim()) {
    throw new Error(`Segment ${input.id} has empty Chinese text.`);
  }

  const segment: Segment = {
    id: input.id,
    start: input.start,
    end: input.end,
    speaker: input.speaker,
    ja: input.ja
  };
  if (input.zh !== undefined) {
    segment.zh = input.zh;
  }

  const index = file.segments.findIndex((current) => current.start > segment.start);
  const insertAt = index === -1 ? file.segments.length : index;
  const previous = file.segments[insertAt - 1];
  const next = file.segments[insertAt];
  if (previous && segment.start < previous.end - SEGMENT_TIME_EPSILON) {
    throw new Error(`Segment ${segment.id} overlaps previous segment ${previous.id}.`);
  }
  if (next && next.start < segment.end - SEGMENT_TIME_EPSILON) {
    throw new Error(`Segment ${next.id} overlaps previous segment ${segment.id}.`);
  }

  file.segments.splice(insertAt, 0, segment);
  return segment;
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
  if ((hasTranslatedText(first) || hasTranslatedText(second)) && input.zh === undefined) {
    throw new Error('merging translated segments requires --zh.');
  }

  const merged: Segment = {
    ...withoutSkipChecks(first),
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
  assertSegmentId(id);
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
  if (segment.skip_checks) {
    next.skip_checks = segment.skip_checks.map((skip) => ({ ...skip }));
  }
  return next;
}

export function hasTranslatedText(segment: Segment): boolean {
  return segment.zh !== undefined && segment.zh.trim().length > 0;
}

export function withoutSkipChecks(segment: Segment): Segment {
  const next = cloneSegment(segment);
  delete next.skip_checks;
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
