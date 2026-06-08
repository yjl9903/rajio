import { describe, expect, it } from 'vitest';

import { formatCliError } from '../src/utils/cli-error.js';

describe('CLI error formatting', () => {
  it('suggests the correct order for misplaced utility commands', () => {
    const error = new Error('Detect unexpected redundant arguments');

    expect(formatCliError(error, ['/path/session', 'doctor'])).toBe(
      [
        'command order looks wrong.',
        'Use: rajio doctor <target>',
        'Subcommands come before the target.'
      ].join('\n')
    );
    expect(formatCliError(error, ['/path/session', 'check'])).toContain(
      'Use: rajio check <target>'
    );
    expect(formatCliError(error, ['/path/session', 'clean'])).toContain(
      'Use: rajio clean <target>'
    );
  });

  it('suggests generic command shapes for misplaced segment and clip groups', () => {
    const error = new Error('Detect unexpected redundant arguments');

    expect(formatCliError(error, ['/path/session', 'segments'])).toContain(
      'Use: rajio segments <command> <target>'
    );
    expect(formatCliError(error, ['/path/session', 'clips'])).toContain(
      'Use: rajio clips <command> <target>'
    );
  });

  it('keeps generic redundant argument errors without a misplaced command', () => {
    const error = new Error('Detect unexpected redundant arguments');

    expect(formatCliError(error, ['/path/session', 'extra'])).toBe(
      'Detect unexpected redundant arguments'
    );
  });
});
