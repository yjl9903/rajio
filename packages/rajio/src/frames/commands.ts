import type { breadc } from 'breadc';
import stringWidth from 'fast-string-width';
import { z } from 'zod';

import { numberInput } from '../utils/cast.js';
import { extractFrames, resolveFrameRequest, type FrameResult } from './extract.js';

const secondsInput = z
  .string()
  .trim()
  .regex(/^(?:\d+(?:\.\d*)?|\.\d+)$/)
  .pipe(numberInput);

export function registerFrameCommands(app: ReturnType<typeof breadc>): void {
  app
    .command('frames', {
      summary: 'Extract video frames at requested times or evenly within a range',
      details: `Choose one mode:

- Time points: --at <seconds> extracts frames at the comma-separated times.
- Range: --start <seconds> --end <seconds> --count <number> divides the range into count equal intervals and extracts a frame at each midpoint. All three options are required.

Do not combine the two modes. Times are non-negative decimal seconds from the source media start.

Returned times indicate the requested positions; actual frame timestamps may differ. Images are saved in frames/capture-<unique suffix>/.`,
      examples: [
        {
          comment: 'Inspect two points in a session.',
          command: 'rajio frames /path/to/session --at 120,123.45'
        },
        {
          comment: 'Take six midpoint samples from a local video range.',
          command: 'rajio frames /path/to/video.mp4 --start 120 --end 150 --count 6'
        }
      ]
    })
    .argument('<target>', 'Existing session directory, session.toml, or media file.')
    .option(
      '--at <seconds>',
      'Comma-separated time points; preserves order and removes duplicates. Requires 1 to 24 distinct points, each less than the known media duration.',
      {
        cast: z
          .string()
          .transform((value) => value.split(','))
          .pipe(z.array(secondsInput))
      }
    )
    .option('--start <seconds>', 'Range start.', {
      cast: secondsInput
    })
    .option(
      '--end <seconds>',
      'Range end; greater than start and no later than known media duration.',
      { cast: secondsInput }
    )
    .option('--count <number>', 'Number of midpoint samples, an integer from 1 to 24.', {
      cast: secondsInput.pipe(z.number().int().min(1).max(24))
    })
    .option('--json', 'Print JSON.')
    .action(async (target, options) => {
      if (options['--'].length) throw new Error(`Unexpected argument: ${options['--'][0]}`);
      const result = await extractFrames(target, resolveFrameRequest(options));
      process.stdout.write(
        formatFrameResult(result, { json: options.json, isTTY: process.stdout.isTTY })
      );
    });
}

export function formatFrameResult(
  result: FrameResult,
  options: { json?: boolean; isTTY?: boolean }
): string {
  if (options.json) return `${JSON.stringify(result, null, options.isTTY ? 2 : undefined)}\n`;
  if (!options.isTTY) {
    return `time,path\n${result.frames.map((frame) => `${frame.time},${escapeCsv(frame.path)}`).join('\n')}\n`;
  }
  const rows = [
    ['TIME', 'PATH'],
    ...result.frames.map((frame) => [String(frame.time), frame.path])
  ];
  const widths = [0, 1].map((index) => Math.max(...rows.map((row) => stringWidth(row[index]))));
  const lines = rows.map((row) =>
    row.map((value, i) => value + ' '.repeat(widths[i] - stringWidth(value))).join('  ')
  );
  lines.splice(1, 0, widths.map((width) => '-'.repeat(width)).join('  '));
  return `Output directory: ${result.output_dir}\n\n${lines.join('\n')}\n`;
}

function escapeCsv(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}
