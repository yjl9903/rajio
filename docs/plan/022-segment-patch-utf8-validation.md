# Segment Patch UTF-8 Validation

## Summary

`segments apply` should reject broken patch input before TOML parsing. Node's default UTF-8 file
read can silently replace invalid bytes with `�`, which lets dry-run validate already-garbled patch
content.

## Behavior

- Read patch files and stdin as bytes.
- Decode with fatal UTF-8 validation.
- Reject decoded patch text containing U+FFFD replacement characters.
- Reject actual C0/C1 control characters except tab, LF, and CR.
- Keep `parseSegmentPatch` as a pure TOML/schema parser; input encoding validation stays at the CLI
  input boundary.

## Tests

- Invalid UTF-8 patch file fails.
- Invalid UTF-8 stdin patch fails.
- U+FFFD in decoded patch text fails.
- NUL/control characters in decoded patch text fail.
- Normal UTF-8 patches with CJK text and regular newlines still apply in dry-run.

## Assumptions

- Broken historical patch files do not need backward compatibility and should be corrected.
- File input and stdin use the same validation rules.
