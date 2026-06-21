import { countSubtitleTextUnits } from '../segments/index.js';
import { SEGMENT_DURATION_LIMITS, SUBTITLE_GAP_LIMITS } from '../segments/limits.js';
import type { Segment, SegmentWord, SegmentsFile } from '../types.js';
import type { TranscriptInputResult } from './types.js';

const JA_SOFT_TEXT_UNITS = 20;
const JA_HARD_TEXT_UNITS = 28;
const TERMINAL_PUNCTUATION = /[。．.,，、;；:：…]$/;

export function buildTranscriptFile(input: {
  inputs: TranscriptInputResult[];
  generatedAt: string;
  normalize: (value: unknown, options: { offset: number; idPrefix: string }) => Segment[];
}): SegmentsFile {
  return {
    version: 1,
    source: {
      kind: 'transcript',
      generated_at: input.generatedAt
    },
    segments: input.inputs.flatMap((chunk) =>
      input.normalize(chunk.response, {
        offset: chunk.start,
        idPrefix: String(chunk.index + 1)
      })
    )
  };
}

export function segmentWords(words: SegmentWord[], idPrefix: string): Segment[] {
  const segments: Segment[] = [];
  let current: SegmentWord[] = [];
  const flush = () => {
    const text = joinSegmentText(current);
    if (!text) {
      current = [];
      return;
    }
    segments.push({
      id: `${idPrefix}-s${segments.length + 1}`,
      start: current[0]!.start,
      end: current.at(-1)!.end,
      speaker: current.find((word) => word.speaker)?.speaker ?? 'speaker_0',
      ja: text,
      words: current
    });
    current = [];
  };

  for (const word of words) {
    const previous = current.at(-1);
    const nextText = joinableWordText(word);
    const wouldExceedHard =
      nextText &&
      current.length > 0 &&
      countSubtitleTextUnits(joinSegmentText([...current, word])) > JA_HARD_TEXT_UNITS;
    const gap = previous ? word.start - previous.end : 0;
    if (
      current.length > 0 &&
      ((previous?.speaker && word.speaker && previous.speaker !== word.speaker) ||
        gap > SUBTITLE_GAP_LIMITS.soft ||
        wouldExceedHard ||
        previousSegmentIsLong(current))
    ) {
      flush();
    }
    current.push(word);
    if (
      nextText &&
      TERMINAL_PUNCTUATION.test(nextText) &&
      countSubtitleTextUnits(joinSegmentText(current)) >= JA_SOFT_TEXT_UNITS
    ) {
      flush();
    }
  }
  flush();

  return segments;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function previousSegmentIsLong(words: SegmentWord[]): boolean {
  const start = words[0]?.start;
  const end = words.at(-1)?.end;
  return (
    start !== undefined && end !== undefined && end - start >= SEGMENT_DURATION_LIMITS.longSoft
  );
}

function joinSegmentText(words: SegmentWord[]): string {
  return words.map(joinableWordText).join('');
}

function joinableWordText(word: SegmentWord): string {
  return word.type === 'spacing' || word.type === 'audio_event' ? '' : word.text;
}
