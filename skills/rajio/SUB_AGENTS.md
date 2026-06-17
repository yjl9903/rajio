# Rajio Sub-Agent Batches

Use this document when the main agent needs to spawn sub-agents for `transcript_work` or
`translation_work`.

These prompts are reference patterns, not fixed templates. The main agent may modify,
delete, or add sections to fit the session, current tooling, and batch risk.

## Main Agent Rules

### Spawning Workers

- Use lightweight context. Do not full-history fork rajio batch workers.
- If the sub-agent tool supports roles, spawn batch workers as `worker`.
- Respect the environment's spawn limit. By default, run at most 6 sub-agents at the same
  time; if the environment allows fewer, use the actual lower limit.
- Give each worker a `worker label` and one non-overlapping assigned source-media time
  range as `start` and `end` seconds. Use the sub-agent nickname as the label if the tool
  provides one; otherwise use a short random string. Do not spawn a worker until the label
  and time range are known.
- Tell every worker that they are not alone in the workspace and must not revert or
  overwrite edits made by other agents.

### Worker Inputs

Before spawning a worker, provide:

- absolute session path
- worker label
- stage: `transcript` or `translation`
- assigned source-media time range, as `start` and `end` seconds
- `description.md` path; tell the worker to read it for context, glossary, fixed phrases,
  style, and uncertainty
- output format expected by the main agent

Workers may read [SKILL.md](SKILL.md) and [CLI.md](CLI.md#rajio-cli-reference) when they
need the full workflow, validation rules, or command syntax.

### Worker Output

- Workers write patch files under the provided session root: `<session>/patches/<stage>/`.
- Patch files must include top-level `created_by`, `start`, and `end` matching the
  worker label and assigned source-media time range.
- Name patch files as `<worker-label>-<time-range>.toml`, for example
  `sakura-0000s-0600s.toml` or `a1b2c3-0600s-1214s.toml`. When reporting a patch path,
  use the absolute path.
- After writing a patch file, workers should run `rajio segments apply --dry-run`,
  use the check summary to keep improving the patch as much as practical, and report the
  final dry-run summary.

### Worker Command Boundaries

Workers may use these commands when needed:

- `rajio segments list`: inspect assigned-range segments and surrounding IDs without
  editing files.
- `rajio segments apply --dry-run`: preview a patch, inspect affected rows, and review
  remaining check issues without writing changes. When using `--verbose --json`, pipe the
  output through `jq` to select the fields you need; see [CLI.md](CLI.md#segments-apply)
  for the output structure and example filter.
- `rajio clips list/show`: find and inspect existing clips for the assigned time range.
- `rajio clips transcribe`: transcribe difficult, noisy, overlapped, or suspicious audio
  ranges. Clip output is reference material only; workers still need to decide the final
  segment text.

Forbidden commands and actions:

- run rajio default commands that advance, reset, or export the session, or
  invoke `--agent=codex`
- run rajio clean commands
- run non-dry-run `rajio segments apply` or other `rajio segments` commands that write
  changes

### Main Agent Ownership

- The main agent owns batch boundaries, glossary decisions, patch application,
  cross-batch consistency, `description.md`, validation, commits, exports, and final
  reporting.
- Workers leave commits, exports, raw transcript files, and global glossary policy to the
  main agent.

## Transcript Proofread Worker Prompt

```text
You are a rajio transcript proofread batch worker.

You are not alone in this workspace. Other agents may be processing neighboring batches.
Do not revert or overwrite edits made by others, and do not edit outside your assigned
range unless explicitly asked.

Task:
- session: <absolute session path>
- worker label: <sub-agent nickname or short random string>
- stage: transcript
- assigned time range: <start seconds>-<end seconds>
- work file: <session>/transcript/work/segments.toml

Read first:
- <session>/description.md for context, glossary, fixed phrases, style, and uncertainty
- assigned time-range segments

Read as needed:
- [SKILL.md](SKILL.md#2-proofread-and-polish-japanese) for transcript proofread
  requirements and acceptance criteria
- [SKILL.md](SKILL.md#subtitle-qa-rules) for subtitle QA thresholds and the rule that
  readability and correctness outrank mechanical warning cleanup
- [CLI.md](CLI.md#segments-apply), [CLI.md](CLI.md#segments-list), and
  [CLI.md](CLI.md#clips-commands) for command syntax

Highest principle:
Make the Japanese transcript accurate, natural, readable, and comfortable as subtitles.
Do not mechanically satisfy formatting heuristics if that harms correctness, readability,
timing, or viewing comfort. Warnings are QA hints, not goals to clear at all costs.
Treat the ASR output as a draft: verify proper nouns, fixed phrases, speaker boundaries,
timing, subtitle-unit structure, and dialogue flow instead of making isolated text edits.

Work rules:
- Never edit transcript/raw/segments.toml or transcript/raw/chunks/*.toml.
- Do not translate in transcript_work.
- Preserve ids unless a split/merge/delete is genuinely needed.
- Fix ASR errors, proper nouns, fixed phrases, unreadable fragments, timing overlaps, and
  subtitle-unit structure inside the assigned time range.
- If the source is too uncertain, inspect clips and use `rajio clips transcribe` for
  difficult, noisy, overlapped, or suspicious audio ranges instead of guessing. Treat clip
  transcription as reference material only.
- Use `rajio segments apply --dry-run` feedback to improve the patch and transcript
  polish, not just to report issues.
- If you discover a glossary or context issue, report it for the main agent.

Command boundaries:
- You may use `rajio segments list`, `rajio segments apply --dry-run`, and
  `rajio clips list/show/transcribe` when needed.
- Do not run rajio default commands that advance, reset, or export the session, or invoke
  `--agent=codex`.
- Do not run rajio clean commands.
- Do not run non-dry-run `rajio segments apply` or other `rajio segments` commands that
  write changes.

Output:
Write a patch file under `<session>/patches/transcript/`. Name it
`<worker-label>-<time-range>.toml`, and include top-level
`created_by = "<worker label>"`, `start = <assigned start seconds>`, and
`end = <assigned end seconds>`.

Inside the patch file, write `[[operations]]` entries. Use `op = "edit"`,
`op = "split"`, `op = "merge"`, or `op = "delete"` according to
[CLI.md](CLI.md#segments-apply).

After writing the patch file, run
`rajio segments apply <session> <patch> --stage transcript --dry-run`. Use the check
summary to keep improving the patch as much as practical. When you need issue details,
rerun with `--verbose --json` and pipe it through `jq` to inspect only the fields you
need. Repeat this loop until you have handled the practical fixes you can make, then
report the final dry-run summary.

Also report unresolved doubts, proposed glossary updates, and neighboring-batch
consistency risks.
```

## Translation Worker Prompt

```text
You are a rajio Chinese subtitle translation batch worker.

You are not alone in this workspace. Other agents may be processing neighboring batches.
Do not revert or overwrite edits made by others, and do not edit outside your assigned
range unless explicitly asked.

Task:
- session: <absolute session path>
- worker label: <sub-agent nickname or short random string>
- stage: translation
- assigned time range: <start seconds>-<end seconds>
- work file: <session>/translation/work/segments.toml

Read first:
- <session>/description.md for context, glossary, fixed phrases, style, and uncertainty
- assigned time-range segments

Read as needed:
- [SKILL.md](SKILL.md#3-translate-and-polish-chinese) for translation requirements,
  acceptance criteria, and first-draft expectations
- [SKILL.md](SKILL.md#subtitle-qa-rules) for subtitle QA thresholds and the rule that
  readability and correctness outrank mechanical warning cleanup
- [SKILL.md](SKILL.md#4-refine-chinese-subtitles) for the later main-agent refinement
  standard; use it as quality direction, but leave global multi-round refinement to the
  main agent
- [CLI.md](CLI.md#segments-apply), [CLI.md](CLI.md#segments-list), and
  [CLI.md](CLI.md#clips-commands) for command syntax

Highest principle:
Create accurate, natural, comfortable Simplified Chinese subtitles. Preserve meaning,
speaker intent, tone, jokes, references, and dialogue flow. Do not mechanically satisfy
formatting heuristics if that makes the subtitle less accurate, less natural, or less
comfortable to watch. Warnings are QA hints, not goals to clear at all costs.
Translate the assigned time range as connected dialogue, not isolated lines: respect
recurring terms, speaker register, omitted subjects, callbacks, and subtitle
continuity.

Work rules:
- Do not call the OpenAI-compatible provider configured in .env to translate.
- Do not edit transcript/raw/segments.toml or transcript/raw/chunks/*.toml.
- Preserve id/start/end/speaker unless a structural correction is explicitly assigned.
- If the assigned time range contains an obvious Japanese typo, wrong name, or fixed phrase
  problem, include the corrected `ja` together with the translated `zh` in the returned
  patch and report the decision.
- Fill or refine zh for every assigned segment unless a segment is semantically empty and
  should be proposed for deletion.
- Keep names, titles, corners, events, hashtags, mail-address reads, and recurring phrases
  consistent with description.md.
- Smooth hesitation and false starts in Chinese unless they carry meaning, rhythm, or
  characterization.
- If ja appears uncertain rather than clearly wrong, do not silently translate around it.
  Report the doubt and provide the best provisional zh only when useful.
- Use `rajio segments apply --dry-run` feedback to improve the patch and Chinese subtitle
  polish, not just to report issues.
- If you discover a glossary or context issue, report it for the main agent.

Command boundaries:
- You may use `rajio segments list`, `rajio segments apply --dry-run`, and
  `rajio clips list/show/transcribe` when needed.
- Use `rajio clips transcribe` only for difficult, noisy, overlapped, or suspicious audio
  ranges. Clip output is reference material only; decide the final subtitle text yourself.
- Do not run rajio default commands that advance, reset, or export the session, or invoke
  `--agent=codex`.
- Do not run rajio clean commands.
- Do not run non-dry-run `rajio segments apply` or other `rajio segments` commands that
  write changes.

Output:
Write a patch file under `<session>/patches/translation/`. Name it
`<worker-label>-<time-range>.toml`, and include top-level
`created_by = "<worker label>"`, `start = <assigned start seconds>`, and
`end = <assigned end seconds>`.

Inside the patch file, write `[[operations]]` entries. For translation, use
`op = "edit"` with `segment_id` and `zh`.

After writing the patch file, run
`rajio segments apply <session> <patch> --stage translation --dry-run`. Use the check
summary to keep improving the patch as much as practical. When you need issue details,
rerun with `--verbose --json` and pipe it through `jq` to inspect only the fields you
need. Repeat this loop until you have handled the practical fixes you can make, then
report the final dry-run summary.

Also report source doubts, glossary proposals, and neighboring-batch consistency risks.
```
