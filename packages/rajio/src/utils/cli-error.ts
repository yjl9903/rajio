const topLevelCommandUsage = new Map([
  ['check', 'rajio check <target>'],
  ['doctor', 'rajio doctor <target>'],
  ['clean', 'rajio clean <target>'],
  ['segments', 'rajio segments <command> <target>'],
  ['clips', 'rajio clips <command> <target>']
]);

export function formatCliError(error: unknown, argv: string[] = []): string {
  const commandOrderHint = formatMisorderedCommandError(error, argv);
  if (commandOrderHint) {
    return commandOrderHint;
  }

  if (isMissingTargetError(error)) {
    return [
      `target is required.`,
      `Usage: rajio ${error.context?.command?.spec ?? '<target>'}`
    ].join('\n');
  }

  if (isErrnoError(error) && error.code === 'ENOENT') {
    return [
      `target not found: ${error.path ?? 'unknown'}`,
      'Pass a session directory, session.toml, description markdown file, or media file.'
    ].join('\n');
  }

  if (error instanceof Error) {
    return formatTargetResolutionError(error.message);
  }
  return String(error);
}

function formatMisorderedCommandError(error: unknown, argv: string[]): string | undefined {
  if (!isUnexpectedArgumentsError(error) || argv.length < 2) {
    return undefined;
  }
  const misplacedCommand = argv.slice(1).find((arg) => topLevelCommandUsage.has(arg));
  if (!misplacedCommand) {
    return undefined;
  }
  return [
    'command order looks wrong.',
    `Use: ${topLevelCommandUsage.get(misplacedCommand)}`,
    'Subcommands come before the target.'
  ].join('\n');
}

function formatTargetResolutionError(message: string): string {
  if (message.startsWith('Unsupported target type: ')) {
    const target = message.slice('Unsupported target type: '.length);
    return [
      `unsupported target: ${target}`,
      'Pass a session directory, session.toml, description markdown file, or media file.'
    ].join('\n');
  }

  if (message.startsWith('Multiple description markdown files found in ')) {
    const dir = message.slice('Multiple description markdown files found in '.length);
    return [
      `target is ambiguous: multiple description markdown files found in ${dir}`,
      'Pass the specific description markdown file, media file, or session directory.'
    ].join('\n');
  }

  if (message.startsWith('Multiple media files found in ')) {
    const dir = message.slice('Multiple media files found in '.length);
    return [
      `target is ambiguous: multiple media files found in ${dir}`,
      'Pass the specific media file, description markdown file, or session directory.'
    ].join('\n');
  }

  if (
    message ===
    'Media file is required. Provide a media target, description frontmatter media, or --media.'
  ) {
    return [
      'media file is required for this target.',
      'Pass a media file target, add media frontmatter to the description, or provide --media.'
    ].join('\n');
  }

  return message;
}

function isMissingTargetError(error: unknown): error is Error & {
  context?: { command?: { spec?: string } };
  cause: { argument?: { name?: string } };
} {
  if (!(error instanceof Error)) {
    return false;
  }
  const candidate = error as Error & {
    cause?: { argument?: { name?: string } };
  };
  return (
    error.message === 'Missing required argument' && candidate.cause?.argument?.name === 'target'
  );
}

function isUnexpectedArgumentsError(error: unknown): boolean {
  return error instanceof Error && error.message === 'Detect unexpected redundant arguments';
}

function isErrnoError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string';
}
