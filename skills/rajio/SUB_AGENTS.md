# Rajio Sub-Agent Batches

Use this document when the main agent needs to spawn sub-agents for `transcript_work` or
`translation_work`.

These prompts are reference patterns, not fixed templates. The main agent may modify,
delete, or add sections to fit the session, current tooling, and batch risk.

## Main Agent Rules

- Use lightweight context. Do not full-history fork rajio batch workers.
- If the sub-agent tool supports roles, spawn batch workers as `worker`.
- Respect the environment's spawn limit. By default, run at most 6 sub-agents at the same
  time; if the environment allows fewer, use the actual lower limit.
- Give each worker one non-overlapping segment range plus nearby context.
- Give each worker a `worker label`. Use the sub-agent nickname if the tool provides one;
  otherwise use a short random string.
- Tell every worker that they are not alone in the workspace and must not revert or
  overwrite edits made by other agents.
- The main agent owns batch boundaries, glossary decisions, patch application,
  cross-batch consistency, `description.md`, validation, commits, exports, and final
  reporting.
- Workers return structured edits or a patch file under the provided session root:
  `<session>/patches/<stage>/`. Name patch files as `<worker-label>-<time-range>.toml`,
  for example `sakura-0000s-0600s.toml` or `a1b2c3-0600s-1214s.toml`.
- Workers leave commits, exports, raw transcript files, and global glossary policy to the
  main agent.

Before spawning a worker, provide:

- absolute session path
- worker label
- stage: `transcript` or `translation`
- assigned segment range, such as offset/limit or explicit ids
- nearby segment context before and after the assigned range
- `description.md` path and the relevant glossary/style/fixed phrase notes
- output format expected by the main agent

Workers may read [SKILL.md](SKILL.md) and [CLI.md](CLI.md) when they need the full
workflow, validation rules, or command syntax.

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
- assigned range: <offset/limit, time range, or segment ids>
- work file: <session>/transcript/work/segments.toml

Read as needed:
- <session>/description.md for context, glossary, fixed phrases, style, and uncertainty
- SKILL.md for the overall workflow and subtitle QA rules
- CLI.md for rajio segments/clips/check command syntax
- assigned batch segments and nearby context segments

Highest principle:
Make the Japanese transcript accurate, natural, readable, and comfortable as subtitles.
Do not mechanically satisfy formatting heuristics if that harms correctness, readability,
timing, or viewing comfort. Warnings are QA hints, not goals to clear at all costs.

Rules:
- Never edit transcript/raw/segments.toml or transcript/raw/chunks/*.toml.
- Do not translate in transcript_work.
- Do not commit stages or export subtitles.
- Preserve ids unless a split/merge/delete is genuinely needed.
- Fix ASR errors, proper nouns, fixed phrases, unreadable fragments, timing overlaps, and
  subtitle-unit structure inside the assigned range.
- If the source is too uncertain and needs audio comparison, report the clip time range
  instead of guessing.
- If you discover a glossary or context issue, report it for the main agent.

Output:
Return a `[[operations]]` TOML patch or a patch path under
`<session>/patches/transcript/`. Use `op = "edit"`, `op = "split"`, `op = "merge"`, or
`op = "delete"` according to CLI.md. Also report unresolved doubts, proposed glossary
updates, and any consistency risks with neighboring batches.
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
- assigned range: <offset/limit, time range, or segment ids>
- work file: <session>/translation/work/segments.toml

Read as needed:
- <session>/description.md for context, glossary, fixed phrases, style, and uncertainty
- SKILL.md for the overall workflow and subtitle QA rules
- CLI.md for rajio segments/check command syntax
- assigned batch segments and nearby context segments

Highest principle:
Create accurate, natural, comfortable Simplified Chinese subtitles. Preserve meaning,
speaker intent, tone, jokes, references, and dialogue flow. Do not mechanically satisfy
formatting heuristics if that makes the subtitle less accurate, less natural, or less
comfortable to watch. Warnings are QA hints, not goals to clear at all costs.

Rules:
- Do not call the OpenAI-compatible provider configured in .env to translate.
- Do not edit transcript/raw/segments.toml or transcript/raw/chunks/*.toml.
- Do not commit stages or export subtitles.
- Preserve id/start/end/speaker/ja unless reporting a transcript issue to the main agent.
- Fill or refine zh for every assigned segment unless a segment is semantically empty and
  should be proposed for deletion.
- Keep names, titles, corners, events, hashtags, mail-address reads, and recurring phrases
  consistent with description.md.
- Smooth hesitation and false starts in Chinese unless they carry meaning, rhythm, or
  characterization.
- If ja appears wrong, do not silently translate around it. Report the transcript issue
  and provide the best provisional zh only when useful.
- If you discover a glossary or context issue, report it for the main agent.

Output:
Return a `[[operations]]` TOML patch or a patch path under
`<session>/patches/translation/`. For translation, use `op = "edit"` with `segment_id`
and `zh`. Also report source doubts, glossary proposals, and neighboring-batch consistency
risks.
```
