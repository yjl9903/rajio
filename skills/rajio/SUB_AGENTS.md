# Rajio Sub-Agent Batches

Use this document whenever the main agent spawns sub-agents for `transcript_work` or
`translation_work`.

The worker prompts below are mandatory templates. The main agent may fill in session
paths, labels, ranges, known context, and tool-specific delivery details, but must not
remove or weaken the worker contract, manual-review requirements, dry-run hard gate,
submission reread loop, command boundaries, or final reporting requirements.

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

Workers must follow the provided prompt and read referenced [SKILL.md](SKILL.md) and
[CLI.md](CLI.md#rajio-cli-reference) sections when the prompt names them, or whenever
validation rules, QA rules, or command syntax are unclear.

### Worker Output

- Workers write patch files under the provided session root: `<session>/patches/<stage>/`.
- Patch files must include top-level `created_by`, `start`, and `end` matching the
  worker label and assigned source-media time range.
- Name patch files as `<worker-label>-<time-range>.toml`, for example
  `sakura-0000s-0600s.toml` or `a1b2c3-0600s-1214s.toml`. When reporting a patch path,
  use the absolute path.
- After writing a patch file, workers must run `rajio segments apply --dry-run`,
  use the check summary to keep improving the patch, and report the final dry-run
  summary. A worker patch is not ready while the dry-run still reports any
  `fatal` or `error` issue in the assigned range. If a remaining `fatal`/`error`
  cannot be fixed by the worker, the worker must submit a blocker report, not a ready
  patch. The blocker report must list each remaining issue identifier: segment ID plus
  issue code for segment issues, or file/global issue code for non-segment issues, with
  the reason it remains.

### Worker Manual Review

- Workers must manually review every segment in their assigned range by reading subtitle
  text in timeline order with enough neighboring context to judge meaning, continuity,
  terminology, timing, and subtitle comfort.
- Use `rajio segments list` with explicit `--start/--end`, `--offset/--limit`, `--id
  --around`, and issue filters as needed to read the actual subtitle text in manageable
  batches. Do not rely only on `rajio check` summaries, generated patch suggestions, or
  validation examples.
- Do not use ad hoc automation scripts to edit `segments.toml`, generate subtitle text,
  generate proofread/translation patch operations, or add `skip_checks`. Write patch
  operations from reviewed segment text and validate them with `rajio segments apply
  --dry-run`.
- Automation scripts are allowed only for non-editing support such as counting segments,
  slicing JSON output for inspection, or validating data shape. They must support manual
  review, not replace reading and judgment.
- If part of the assigned range was not read segment by segment in context, report that
  range as unreviewed. Do not call the batch polished or complete.
- Search commands such as `rg` may help locate text, but they do not count as reading the
  assigned subtitles. A worker who substitutes search hits or QA summaries for full
  segment-by-segment reading has not met the batch contract.

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

- run rajio default commands that advance, reset, or export the session
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

Read before work:
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
At the same time, warnings are not noise: inspect them and decide whether to fix,
preserve, or report them. A clean or acceptable dry-run is only the technical baseline,
not proof that the transcript has been semantically proofread.
Treat the ASR output as a draft: verify proper nouns, fixed phrases, speaker boundaries,
timing, subtitle-unit structure, and dialogue flow instead of making isolated text edits.

Work rules:
- Never edit transcript/raw/segments.toml, transcript/raw/checkpoints/*.toml, or
  transcript/raw/chunks/*.toml.
- Do not translate in transcript_work.
- Manually review every segment in the assigned range in timeline order with neighboring
  context. Use `rajio segments list` range commands to read actual segment text;
  `rajio check` output and suggested patches are only aids.
- Do not use ad hoc automation scripts to generate transcript edits, patch operations, or
  skip annotations. Patch operations must come from reviewed subtitle text.
- Preserve ids unless a split/merge/delete is genuinely needed.
- Fix ASR errors, proper nouns, fixed phrases, unreadable fragments, timing overlaps, and
  subtitle-unit structure inside the assigned time range.
- If the source is too uncertain, inspect clips and use `rajio clips transcribe` for
  difficult, noisy, overlapped, or suspicious audio ranges instead of guessing. Treat clip
  transcription as reference material only.
- Use `rajio segments apply --dry-run` feedback to improve the patch and transcript
  polish, not just to report issues.
- Keep iterating until the transcript dry-run reports `fatal = 0` and `error = 0` for
  the assigned range. Reduce warnings where that improves correctness, readability,
  timing, or subtitle comfort. Do not chase a warning by making the transcript worse, but
  do not use that rule as permission to leave fixable warnings untouched.
- Before final output, enter submission preparation:
  1. Run `rajio segments apply <session> <patch> --stage transcript --dry-run --json`
     and record the explicit `check.counts.fatal`, `check.counts.error`, and
     `check.counts.warning` counts.
  2. Read the assigned range again from start to end as subtitle text. For every segment
     affected by your patch, including edits, splits, merges, deletes, and merge context,
     reread the final patched text one by one in timeline order. Do not replace this with
     `rg`, issue summaries, or examples.
  3. If this final read finds any missed problem, update the patch and return to step 1.
  4. Submit a ready patch only when no `fatal` or `error` remains. If any `fatal`/`error`
     remains, do not call the patch ready or complete; submit a blocker report instead,
     listing each issue identifier and reason.
- If you discover a glossary or context issue, report it for the main agent.

Command boundaries:
- You may use `rajio segments list`, `rajio segments apply --dry-run`, and
  `rajio clips list/show/transcribe` when needed.
- Do not run rajio default commands that advance, reset, or export the session.
- Do not run rajio clean commands.
- Do not run non-dry-run `rajio segments apply` or other `rajio segments` commands that
  write changes.

Output:
Write a patch file under `<session>/patches/transcript/`. Name it
`<worker-label>-<time-range>.toml`, and include top-level
`created_by = "<worker label>"`, `start = <assigned start seconds>`, and
`end = <assigned end seconds>`.

Inside the patch file, write `[[operations]]` entries. Use `op = "edit"`,
`op = "split"`, `op = "merge"`, `op = "insert"`, or `op = "delete"` according to
[CLI.md](CLI.md#segments-apply).

After writing the patch file, run
`rajio segments apply <session> <patch> --stage transcript --dry-run`. Use the check
summary to keep improving the patch until assigned-range `fatal = 0` and `error = 0`.
When you need issue details, rerun with `--verbose --json` and pipe it through `jq` to
inspect only the fields you need. Warnings should go down when doing so improves the
subtitle; remaining warnings are acceptable only after manual review and only when the
worker can explain why changing them would hurt or not improve the subtitle.

Before submitting, run the submission-preparation loop in Work rules. In the final report,
include the dry-run counts and explicitly confirm both reviews: the full assigned range
was reread from start to end as subtitle text, and every segment affected by your patch
was reread one by one in its final patched form. If any `fatal`/`error` remains, label the
output as a blocker report, not a ready patch, and list each issue identifier and reason.
Also report unresolved doubts, proposed glossary updates, remaining warning rationale, and
neighboring-batch consistency risks.
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

Read before work:
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
At the same time, warnings are not noise: inspect them and decide whether to fix,
preserve, or report them. `rajio check` only verifies the baseline; it does not judge
whether the Chinese is polished, concise, idiomatic, or pleasant to watch.
Translate the assigned time range as connected dialogue, not isolated lines: respect
recurring terms, speaker register, omitted subjects, callbacks, and subtitle
continuity.

Work rules:
- Do not use the OpenAI-compatible provider configured in `.env` as a
  machine-translation service.
- Do not edit transcript/raw/segments.toml, transcript/raw/checkpoints/*.toml, or
  transcript/raw/chunks/*.toml.
- Manually review every segment in the assigned range in timeline order with neighboring
  context before writing its `zh`. Use `rajio segments list` range commands to read
  actual segment text; `rajio check` output is only validation support.
- Do not use ad hoc automation scripts to generate translations, patch operations, or
  skip annotations. Patch operations must come from reviewed subtitle text.
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
- Remove unnecessary Chinese filler and transcript-shaped clutter, including but not
  limited to redundant `嗯`, `啊`, `哦`, `呃`, `欸`, `那个`, `就是`, repeated `对对对`,
  duplicated verbs, repeated subjects, stalled false starts, and trailing particles such
  as `嘛` when they do not carry tone or timing value. Treat these as review candidates,
  not a fixed deletion list. Keep interjections when they express a real reaction, joke
  beat, surprise, embarrassment, or speaker personality.
- If ja appears uncertain rather than clearly wrong, do not silently translate around it.
  Report the doubt and provide the best provisional zh only when useful.
- Use `rajio segments apply --dry-run` feedback to improve the patch and Chinese subtitle
  polish, not just to report issues.
- Keep iterating until the translation dry-run reports `fatal = 0` and `error = 0` for
  the assigned range. Reduce warnings where that improves correctness, readability,
  timing, or subtitle comfort. Do not chase a warning by making the subtitle worse, but
  do not use that rule as permission to leave fixable warnings untouched.
- Before final output, enter submission preparation:
  1. Run `rajio segments apply <session> <patch> --stage translation --dry-run --json`
     and record the explicit `check.counts.fatal`, `check.counts.error`, and
     `check.counts.warning` counts.
  2. Read the assigned range again from start to end as subtitle text. For every segment
     you translated or otherwise changed, reread the final subtitle text one by one in
     timeline order with neighboring context. Do not replace this with `rg`, issue
     summaries, or examples.
  3. If this final read finds any missed problem, update the patch and return to step 1.
  4. Submit a ready patch only when no `fatal` or `error` remains. If any `fatal`/`error`
     remains, do not call the patch ready or complete; submit a blocker report instead,
     listing each issue identifier and reason.
- If you discover a glossary or context issue, report it for the main agent.

Command boundaries:
- You may use `rajio segments list`, `rajio segments apply --dry-run`, and
  `rajio clips list/show/transcribe` when needed.
- Use `rajio clips transcribe` only for difficult, noisy, overlapped, or suspicious audio
  ranges. Clip output is reference material only; decide the final subtitle text yourself.
- Do not run rajio default commands that advance, reset, or export the session.
- Do not run rajio clean commands.
- Do not run non-dry-run `rajio segments apply` or other `rajio segments` commands that
  write changes.

Output:
Write a patch file under `<session>/patches/translation/`. Name it
`<worker-label>-<time-range>.toml`, and include top-level
`created_by = "<worker label>"`, `start = <assigned start seconds>`, and
`end = <assigned end seconds>`.

Inside the patch file, write `[[operations]]` entries. For translation, use `op = "edit"`
with `segment_id` and `zh` by default. If the assigned time range contains an obvious
Japanese typo, wrong name, or fixed phrase problem, include the corrected `ja` in the same
edit operation and report the decision. If a segment is semantically empty and should be
removed, use `op = "delete"` and report why.

After writing the patch file, run
`rajio segments apply <session> <patch> --stage translation --dry-run`. Use the check
summary to keep improving the patch until assigned-range `fatal = 0` and `error = 0`.
When you need issue details, rerun with `--verbose --json` and pipe it through `jq` to
inspect only the fields you need. Warnings should go down when doing so improves the
subtitle; remaining warnings are acceptable only after manual review and only when the
worker can explain why changing them would hurt or not improve the subtitle.

In the final report, include the dry-run counts and explicitly confirm both reviews: the
full assigned range was read from start to end as subtitle text, and every segment you
translated or otherwise changed was reread one by one in its final subtitle form. If any
`fatal`/`error` remains, label the output as a blocker report, not a ready patch, and list
each issue identifier and reason. Also report source doubts, glossary proposals, remaining
warning rationale, and neighboring-batch consistency risks.
```
