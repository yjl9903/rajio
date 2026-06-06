import type { Segment, SegmentsFile } from '../types.js';

export function renderSrt(file: SegmentsFile, language: 'ja' | 'zh'): string {
  return `${file.segments
    .map((segment, index) => {
      const text = language === 'ja' ? segment.ja : (segment.zh ?? '');
      return `${index + 1}\n${formatSrtTime(segment.start)} --> ${formatSrtTime(segment.end)}\n${text.trim()}`;
    })
    .join('\n\n')}\n`;
}

export function renderAss(file: SegmentsFile, title: string): string {
  const events = file.segments.map((segment) => {
    const text = `${escapeAss(segment.ja)}\\N${escapeAss(segment.zh ?? '')}`;
    return `Dialogue: 0,${formatAssTime(segment.start)},${formatAssTime(segment.end)},Default,,0,0,0,,${text}`;
  });

  return `[Script Info]
Title: ${escapeAss(title)}
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,42,&H00FFFFFF,&H000000FF,&H00222222,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,40,40,32,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events.join('\n')}
`;
}

export function formatSrtTime(seconds: number): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const ms = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const s = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const m = totalMinutes % 60;
  const h = Math.floor(totalMinutes / 60);
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(ms, 3)}`;
}

export function formatAssTime(seconds: number): string {
  const totalCs = Math.max(0, Math.round(seconds * 100));
  const cs = totalCs % 100;
  const totalSeconds = Math.floor(totalCs / 100);
  const s = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const m = totalMinutes % 60;
  const h = Math.floor(totalMinutes / 60);
  return `${h}:${pad(m, 2)}:${pad(s, 2)}.${pad(cs, 2)}`;
}

export function segmentDisplayText(segment: Segment): string {
  return segment.zh ? `${segment.ja}\n${segment.zh}` : segment.ja;
}

function escapeAss(value: string): string {
  return value.replace(/[{}]/g, '').replace(/\r?\n/g, '\\N');
}

function pad(value: number, length: number): string {
  return String(value).padStart(length, '0');
}
