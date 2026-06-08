export interface BrokenPipeStream {
  on(event: 'error', listener: (error: unknown) => void): unknown;
}

export interface BrokenPipeHandlerOptions {
  streams?: BrokenPipeStream[];
  exit?: (code: number) => void;
}

const installedStreams = new WeakSet<BrokenPipeStream>();

export function installBrokenPipeHandler(options: BrokenPipeHandlerOptions = {}): void {
  const streams = options.streams ?? [process.stdout, process.stderr];
  const exit = options.exit ?? ((code) => process.exit(code));

  for (const stream of streams) {
    if (installedStreams.has(stream)) {
      continue;
    }
    installedStreams.add(stream);
    stream.on('error', (error) => {
      if (isBrokenPipeError(error)) {
        exit(0);
        return;
      }
      throw error;
    });
  }
}

export function isBrokenPipeError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'EPIPE'
  );
}
