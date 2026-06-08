# Segment Split Midpoint Gap Plan

## Summary

Keep `rajio check` rules unchanged. Update split tooling so generated split segments include a
valid subtitle gap by treating split times as boundary midpoints.

## Key Changes

- Add shared split timing constants near segment validation code:
  - default split gap: `0.08s`
  - minimum split gap: `0.08s`
  - minimum generated child duration: `0.5s`
- Update `rajio segments split`:
  - add `--gap <seconds>`, default `0.08`
  - interpret `--at` as the midpoint of the gap
  - generate first `end = at - gap / 2`
  - generate second `start = at + gap / 2`
  - reject `gap < 0.08`, invalid midpoint, or any child shorter than `0.5s`
- Update `segments apply` split operations:
  - add optional `gap = <seconds>` per `op = "split"` operation, default `0.08`
  - treat authored `start/end` values as virtual continuous timing
  - every internal boundary where `prev.end == next.start` becomes the midpoint of an inserted gap
  - preserve first segment `start` and last segment `end`
  - reject non-continuous virtual coverage, overlaps, `gap < 0.08`, or generated children shorter
    than `0.5s`
- Keep translation safeguards unchanged: splitting translated segments still requires `zh` on every
  generated child.

## Interface

CLI:

```bash
rajio segments split <target> <id> --at 12.5 --gap 0.08 --id1 1.1 --id2 1.2 --ja1 前半 --ja2 後半
```

Patch TOML:

```toml
[[operations]]
op = "split"
source_id = "1"
gap = 0.08

[[operations.replacements]]
segment_id = "1.1"
start = 0
end = 1.2
speaker = "A"
ja = "前半"

[[operations.replacements]]
segment_id = "1.2"
start = 1.2
end = 2.5
speaker = "A"
ja = "後半"
```

Applied result uses `1.2` as the midpoint: first segment ends at `1.16`, second starts at `1.24`.

## Test Plan

- Test CLI split default midpoint gap and custom `--gap`.
- Test split rejects `gap < 0.08`.
- Test split rejects child durations below `0.5s` after gap insertion.
- Test patch split converts continuous virtual boundaries into midpoint gaps.
- Test multi-segment patch split inserts gaps at every internal boundary.
- Test patch split rejects non-continuous virtual coverage.
- Test resulting split segments do not produce `subtitle_gap_too_short`.
- Run `pnpm --filter rajio test` and `pnpm --filter rajio typecheck`.

## Assumptions

- No `rajio check` thresholds or severity levels change.
- Existing manual `segments edit` remains permissive.
- Implementation should first save this agreed design as `docs/plan/006-segment-split-midpoint-gap.md`.
