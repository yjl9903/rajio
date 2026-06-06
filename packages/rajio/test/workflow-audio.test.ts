import { describe, expect, it } from 'vitest';

import { parseSilenceDetectOutput, planAudioChunks } from '../src/workflow/stages/audio.js';

describe('audio chunk planning', () => {
  it('uses nearby silence boundaries instead of fixed timestamps', () => {
    const chunks = planAudioChunks(
      2397,
      [
        { start: 594, end: 596 },
        { start: 1192, end: 1196 },
        { start: 1805, end: 1807 }
      ],
      { targetSeconds: 600, maxSeconds: 1350, minSeconds: 30, boundarySearchSeconds: 90 }
    );

    expect(chunks).toEqual([
      { start: 0, end: 595 },
      { start: 595, end: 1194 },
      { start: 1194, end: 1806 },
      { start: 1806, end: 2397 }
    ]);
    expect(chunks.every((chunk) => chunk.end - chunk.start <= 1350)).toBe(true);
  });

  it('falls back to safe time boundaries when no silence is available', () => {
    const chunks = planAudioChunks(2397, [], {
      targetSeconds: 600,
      maxSeconds: 1350,
      minSeconds: 30,
      boundarySearchSeconds: 90
    });

    expect(chunks).toEqual([
      { start: 0, end: 600 },
      { start: 600, end: 1200 },
      { start: 1200, end: 1800 },
      { start: 1800, end: 2397 }
    ]);
  });

  it('parses ffmpeg silencedetect intervals', () => {
    const silences = parseSilenceDetectOutput(
      [
        '[silencedetect @ 0x1] silence_start: 594',
        '[silencedetect @ 0x1] silence_end: 596 | silence_duration: 2',
        '[silencedetect @ 0x1] silence_start: 1192.5',
        '[silencedetect @ 0x1] silence_end: 1196 | silence_duration: 3.5'
      ].join('\n')
    );

    expect(silences).toEqual([
      { start: 594, end: 596 },
      { start: 1192.5, end: 1196 }
    ]);
  });
});
