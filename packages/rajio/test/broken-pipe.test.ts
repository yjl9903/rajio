import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import { installBrokenPipeHandler, isBrokenPipeError } from '../src/utils/broken-pipe.js';

class FakeStream extends EventEmitter {
  override on(event: 'error', listener: (error: unknown) => void): this {
    return super.on(event, listener);
  }
}

describe('broken pipe handling', () => {
  it('exits cleanly when stdout is closed by a downstream pipe', () => {
    const stdout = new FakeStream();
    let exitCode: number | undefined;

    installBrokenPipeHandler({
      streams: [stdout],
      exit: (code) => {
        exitCode = code;
      }
    });
    stdout.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));

    expect(exitCode).toBe(0);
  });

  it('does not swallow non-EPIPE stream errors', () => {
    const stdout = new FakeStream();
    installBrokenPipeHandler({ streams: [stdout], exit: () => undefined });

    expect(() =>
      stdout.emit('error', Object.assign(new Error('write failed'), { code: 'EINVAL' }))
    ).toThrow('write failed');
  });

  it('does not install duplicate handlers for the same stream', () => {
    const stdout = new FakeStream();

    installBrokenPipeHandler({ streams: [stdout], exit: () => undefined });
    installBrokenPipeHandler({ streams: [stdout], exit: () => undefined });

    expect(stdout.listenerCount('error')).toBe(1);
  });

  it('recognizes only EPIPE errors as broken pipes', () => {
    expect(isBrokenPipeError(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).toBe(
      true
    );
    expect(isBrokenPipeError(Object.assign(new Error('write failed'), { code: 'EINVAL' }))).toBe(
      false
    );
  });
});
