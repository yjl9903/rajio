import { breadc, InputError } from 'breadc';
import { describe, expect, it } from 'vitest';

import { formatCliError } from '../src/utils/cli-error.js';

function parseError(argv: string[]): InputError {
  const app = breadc('rajio');
  app.command('').argument('<target>');
  app.command('doctor').argument('<target>');
  try {
    app.parse(argv);
  } catch (error) {
    if (error instanceof InputError) return error;
    throw error;
  }
  throw new Error('Expected invalid argv');
}

describe('CLI error formatting', () => {
  it('suggests the correct order for misplaced commands', () => {
    for (const command of ['check', 'doctor', 'clean', 'segments', 'clips', 'frames']) {
      const argv = ['/path/session', command];
      expect(formatCliError(parseError(argv), argv)).toContain('command order looks wrong.');
      expect(formatCliError(parseError(argv), argv)).toContain(`Use: rajio ${command}`);
    }
  });

  it('keeps generic redundant argument errors without a misplaced command', () => {
    const argv = ['/path/session', 'extra'];
    expect(formatCliError(parseError(argv), argv)).toBe('Detect unexpected redundant arguments');
  });

  it('formats missing targets with the declared usage', () => {
    expect(formatCliError(parseError(['doctor']), ['doctor'])).toBe(
      'target is required.\nUsage: rajio doctor <target>'
    );
  });

  it('keeps other input diagnostics when adding a missing-target hint', () => {
    const argv = ['doctor', '--unknown'];
    const output = formatCliError(parseError(argv), argv);
    expect(output).toContain('Unknown option: --unknown');
    expect(output).toContain('target is required.');
  });
});
