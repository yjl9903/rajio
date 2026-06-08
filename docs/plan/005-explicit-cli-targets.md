# Explicit CLI Targets

## Summary

All rajio commands require an explicit positional session target. The default command,
utility commands, segment tools, and clip tools now use the same target-first convention.

## CLI Shape

- `rajio <target> [options]`
- `rajio check <target> [options]`
- `rajio doctor <target>`
- `rajio clean <target>`
- `rajio segments list <target> [options]`
- `rajio segments apply <target> [patch] [options]`
- `rajio segments edit <target> <id> [fields]`
- `rajio segments split <target> <id> [fields]`
- `rajio segments merge <target> <id1> <id2> [fields]`
- `rajio segments delete <target> <id> [options]`
- `rajio clips transcribe <target> --start <seconds> --end <seconds> [options]`
- `rajio clips list <target> [--json]`
- `rajio clips show <target> <id> [--json]`

## Implementation Notes

- Segment edit context requires an explicit `sessionTarget`.
- Segment and clip subcommands reject unknown options before resolving the session target.
- `check`, `doctor`, and `clean` use required `<target>` command arguments and no cwd fallback.
- `segments apply <target> [patch]` keeps stdin patch support when `[patch]` is omitted.

## Test Plan

- CLI parsing tests cover target-first `segments list`, `segments apply`, `clips list`, and
  `clips show`.
- `segments apply <target>` is tested with stdin input.
- Utility commands are tested for missing-target failure.
- Regression coverage verifies unknown segment and clip options fail before session directory
  inference.
