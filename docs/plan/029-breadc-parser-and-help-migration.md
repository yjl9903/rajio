# Breadc Parser And Help Migration

## Scope And Decision

Migrate rajio from `breadc@1.0.0-beta.18` to `1.0.0-beta.21`, the npm latest version
verified on 2026-10-05. Adopt the new parser contract directly; the user confirmed that
historical CLI parsing compatibility is not required. Remove obsolete workarounds rather
than reproducing the old parser behavior. The migration is implemented with Zod schemas in the existing `utils/cast.ts` and
help prose inline in command declarations, following the original skill reference wording.

Session formats, workflow stages, editing semantics, and transcription behavior are outside
this migration. Preserve their existing requirements.

## Verified Upstream Changes

Sources were inspected at the beta.21 release commit `433b311`; subsequent upstream changes
at inspection time affect documentation only.

- [Input selection and casting](https://github.com/yjl9903/Breadc/blob/v1.0.0-beta.21/packages/core/src/runtime/matched.ts):
  `default` is a raw input and passes through `cast`. An absent ordinary value option without
  a default remains `undefined` without calling its cast. `initial` is removed. Cast results
  are retained as returned; they do not trigger a second default selection.
- [Parser](https://github.com/yjl9903/Breadc/blob/v1.0.0-beta.21/packages/core/src/runtime/parser.ts):
  explicit missing option values and redundant positional arguments produce input issues.
  Only arguments after an explicit `--` become passthrough values. `--` cannot supply required
  positional arguments. Unknown options are rejected by default.
- [Errors](https://github.com/yjl9903/Breadc/blob/v1.0.0-beta.21/packages/core/src/error.ts):
  use `InputError.issues` and `ErrorCode` rather than matching error messages or old `cause`
  structures. Syntax diagnostics are aggregated; ordinary function-cast exceptions still
  propagate directly.
- [Description types](https://github.com/yjl9903/Breadc/blob/v1.0.0-beta.21/packages/core/src/breadc/types/description.ts):
  application descriptions accept `{ description, examples }`; command descriptions accept
  `{ summary, details, examples }`. Positionals can have descriptions via `.argument()`.
- [Builtin help](https://github.com/yjl9903/Breadc/blob/v1.0.0-beta.21/packages/breadc/src/builtin/help.ts):
  help/version actions belong to `breadc`, with standard help sections and width-aware layout.
  There is no arbitrary-section API or separate detailed-help flag. Long command contracts
  belong in `details`; examples use `{ command, comment }`.

Isolated probes against the published beta.18 and beta.21 packages confirmed:

| Input or configuration                 | beta.18                            | beta.21                              |
| -------------------------------------- | ---------------------------------- | ------------------------------------ |
| Omitted option with configured default | Default bypasses cast              | Default passes through cast          |
| Omitted value option without default   | Cast can run on absent value       | Cast is skipped                      |
| `--number` without its required value  | Can reach the action               | `MISSING_OPTION_VALUE`               |
| `<target> extra`                       | Extra is placed in `options['--']` | `UNEXPECTED_ARGUMENTS`               |
| `<target> -- extra`                    | Passthrough                        | Passthrough                          |
| Repeated `--full`                      | Runtime error                      | `InputError` with `DUPLICATE_OPTION` |
| `--chunk-silence-noise -35`            | Accepts negative value             | Accepts negative value               |

Beta.21 probes also confirmed that leaf-command help needs no target and executes neither
the business action nor unrelated casts. A required default `<target>` still makes bare
`rajio` fail for missing target; automatic help does not override that requirement.

## Parser Migration

1. Pin `breadc` to beta.21 and update the lockfile, including its matching `@breadc/*`
   packages. Check pnpm release-age exclusions; remove stale beta.17 exceptions rather than
   retaining unrelated historical entries.
2. Replace `formatCliError` message matching with `InputError` issue handling. Preserve the
   useful rajio missing-target and misordered-command hints using `MISSING_ARGUMENT`,
   `argument.name`, and `UNEXPECTED_ARGUMENTS`. Format every issue so a useful hint does not
   hide another input problem. Keep filesystem and target-resolution diagnostics separate.
3. Remove segment/clip `rejectUnknownOption` handlers and their `.allowUnknownOption()`
   registrations. Remove the top-level argv special case for the removed `--agent` option.
   Use normal `app.run(argv)` and native unknown-option rejection for all commands.
4. Retain the segments-list prohibition on actual passthrough arguments, renaming its
   helper to make that purpose explicit. Let the parser reject redundant positionals.
5. Pass Zod schemas directly as `cast` through breadc's Standard Schema support. Replace
   handwritten enum, number, count, comma-separated ID, and issue-list casts rather than
   wrapping schemas in functions that call `.parse()`. Remove obsolete cast-local
   absent-value branches while keeping checks for absent required options:
   `--start <seconds>` requires a value when present, not that the option must appear.
   Keep `--continue`'s raw string default. Numeric chunk defaults remain owned by audio
   resolution; describe those defaults in help rather than changing their ownership.
6. Keep comma-separated `--id` and `--issues`: rajio has no spread declarations requiring
   migration. Do not redesign these options around upstream array support.
7. Keep cross-option and business validation in the existing command/domain code. Per-input
   Zod schemas validate individual values; they do not replace checks such as paired
   `--start`/`--end`, `end > start`, pagination/filter exclusions, stage availability, or
   patch application constraints.

### Zod Input Schemas

The repository already depends on Zod 4. Pass the schema itself to `cast`, allowing breadc
to infer its output type and aggregate schema failures as `INVALID_OPTION_VALUE` or
`INVALID_ARGUMENT_VALUE` issues with the relevant input path.

```ts
.option('--continue <mode>', 'continue mode', {
  default: 'until-manual',
  cast: z.enum(['until-manual', 'step'])
})
.option('--start <seconds>', 'start time in seconds', {
  cast: z.string().transform(Number).pipe(z.number().finite())
})
```

- Use `z.enum()` for continuation mode, reset stage, manual stage, issue level, and check
  language/stage. Reuse existing constant lists where appropriate.
- Convert numeric strings to finite numbers; use an integer schema for counts. Preserve
  the existing numeric acceptance and domain constraints rather than adding unrelated
  syntax restrictions. `Number()` coercion currently accepts empty/whitespace strings as
  zero; test and document that behavior explicitly if it is retained.
- Model comma-separated IDs with string-to-array transformation followed by validation
  of trimmed nonempty entries. Model issue lists with the existing trimming/filtering
  behavior followed by an array of the allowed issue-code enum.
- Share only schemas actually reused by multiple command modules, removing the duplicate
  numeric helpers and obsolete enum/list casts. Do not introduce a generic schema factory.
- Use synchronous schemas: breadc does not support asynchronous casts/refinements.
- An omitted ordinary value option without a breadc default skips schema evaluation.
  Consequently, neither a required Zod schema nor `.default()` inside a schema can force
  an option to appear or supply its value in that case. Keep required-option presence
  checks, and configure CLI defaults with breadc's `default` field.
- Configured raw defaults also pass through the schema. Invalid configured defaults are
  definition errors, whereas invalid user values become aggregated input issues.

## Help And Documentation Ownership

The CLI owns command contracts. The skill owns agent workflow and editorial decisions.
Help is static and must work without loading a session, probing providers, or reading
environment files.

| Existing content                                                                          | CLI destination                             | Skill treatment                                                                               |
| ----------------------------------------------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Target types, resolution, media override, environment precedence                          | Root application description                | Remove duplicate reference prose                                                              |
| Workflow flags, reset behavior, chunk defaults                                            | Root description and option descriptions    | Keep instructions that explain when an agent should run a workflow step                       |
| List IDs, ranges, filtering, pagination constraints, output JSON                          | `segments list` details/examples            | Remove command reference; retain agent preferences for bounded context and JSON               |
| Ordered patch format, edit/split/merge/insert/delete fields, stdin, dry-run, check output | `segments apply` details/examples           | Remove duplicate TOML schema and generic examples; keep batch planning and patch review rules |
| Individual edit operation constraints and output                                          | Each segment leaf command                   | Remove duplicated syntax and option lists                                                     |
| Clip artifacts, output structure, sidecar behavior                                        | Each clip leaf command                      | Keep criteria for requesting an independent ASR comparison                                    |
| Check levels, scope/language defaults, JSON shape, issue codes                            | `check` details/examples                    | Keep editorial interpretation, exceptions, and required review gates                          |
| Doctor checks and clean artifact behavior                                                 | `doctor` and `clean` details                | Keep version comparison and failure-handling policy                                           |
| Provider configuration and artifacts                                                      | Relevant root/doctor/clip help descriptions | Remove duplicate configuration reference after coverage is complete                           |
| Privacy authorization, read-only raw artifacts, sub-agent contracts, language quality     | No migration required                       | Retain in SKILL/SUB_AGENTS and subtitle guidelines                                            |

Use declaration-adjacent metadata in `cli.ts`, `segments/commands.ts`, and
`clips/commands.ts`. Keep all help prose inline; the user explicitly requested no new help module.
Keep shared Zod schemas in the existing `utils/cast.ts`. Do not introduce a documentation registry, generator, runtime Markdown loader, or custom
renderer.

Declare positionals through `.argument('<target>', description)` and equivalent argument
declarations when argument descriptions are needed. Do not append `.argument('<target>')`
to a command spec already containing `<target>`: that adds another positional argument.
The root help selects the application description rather than default-command details,
so place default-workflow explanations at the application level.

Existing flat multiword commands already support `rajio segments --help` and
`rajio clips --help` discovery. Introduce explicit groups only if parent-level prose is
needed; preserve leaf command spellings and registration behavior.

Replace SKILL's command-reference section with availability and help discovery:
`rajio --help`, `rajio segments --help`, and relevant leaf `--help` calls before use.
Keep task-specific workflow examples where they express agent decisions. Update all
`CLI.md` links in `SKILL.md` and `SUB_AGENTS.md`, including links inside worker prompt
templates. Once all command/configuration reference content is covered by help, remove
`skills/rajio/CLI.md` and redundant `references/configuration.md`; retain any agent-only
policy in the skill. Do not leave a second hand-maintained command reference behind.

## Implementation Order And Validation

1. Upgrade and migrate parser/error handling and Zod input schemas; update affected focused
   CLI/error tests.
2. Add complete help contracts and examples; verify root, parent, and every leaf page.
3. Remove reference duplication and update skill/worker discovery instructions.
4. Run `pnpm --filter rajio test --run`, `pnpm --filter rajio typecheck`, and
   `pnpm --filter rajio build`; run `pnpm test:ci` before a PR.

Focused behavior coverage should include missing targets and values, aggregated errors,
unknown options before session resolution, repeated flags, negative numeric values,
redundant positionals versus explicit passthrough, and option-like values supplied with attached option syntax. Verify unchanged comma-separated ID
selection and workflow default selection.

Verify that multiple invalid schema inputs produce multiple input issues before business
actions run, numeric inputs reject nonfinite values, counts reject fractions, ID lists
reject empty entries, issue lists reject unknown codes, and omitted options remain
undefined. Validate the raw continuation default through its enum schema.

Help coverage must verify target-free root/parent/leaf output, argument descriptions,
command-specific details and examples, patch and JSON contracts, and no session/filesystem
writes or provider/workflow actions. Include malformed argv with help: help skips business
casts but must not swallow parser syntax errors. Update old-error unit fixtures to real
beta.21 errors rather than preserving a compatibility shim.

Finally search remaining skill files for stale reference links and duplicated command
tables, and verify the package's existing prepack copy still includes the retained skill
files. Do not edit generated `dist` or package-local copied skills.

## Verification Results

- `pnpm test:ci`: 212 tests passed; Turbo also completed the workspace build/typecheck prerequisites.
- `pnpm --filter rajio typecheck`: passed.
- `pnpm --filter rajio build`: passed.
- Skill frontmatter validation: passed.
- Root, parent, and all leaf help pages are covered without session loading; malformed
  syntax remains an error with help, while business casts are skipped.
- Removed obsolete CLI/configuration references and updated all skill/worker references.
- No new help/schema modules: prose is inline and shared schemas use `utils/cast.ts`.

## Help Review Follow-Up

Reviewed actual root, both parent pages, and every leaf page. Keep framework-owned Usage,
Commands, Arguments, Options, and Examples as the only syntax/reference structure.
Parameter resolution belongs in argument descriptions. Defaults, ranges, flag behavior,
and output-mode contracts belong on their corresponding options; command details retain
only relevant behavior and data contracts. Do not copy the entire reference introduction
onto every leaf. Root help must not contain clip trees or main/clip checkpoint manuals.
Provider credentials and binary overrides belong in doctor help; clip artifacts belong in
clips transcribe help. Keep examples purposeful and let breadc wrap prose paragraphs;
preserve literal TOML, directory trees, and shell continuations.

Review verification: all 16 built CLI help pages exit successfully. Before example comments,
root help reduced from 241 to 141 lines; segments list from 120 to 75, edit from 70 to 49, and apply from
278 to 173. Full package tests pass (212 tests), as do typecheck and build. CLI coverage
also checks unique framework section headings, unrelated-content exclusions, and parses
the rendered TOML patch example to catch wrapping that would make it invalid.

All 37 examples now include an inline breadc `comment` explaining their purpose. Verified
the rendered comments across all 16 help pages; typecheck and build pass.

The TOML patch example uses a fenced `toml` code block. Console wrapping starts in
command action middleware so consola's inline formatting cannot alter builtin help
code fences. The help assertion extracts the fenced content and validates the TOML.


## User-Facing Help Priorities

Keep help focused on the inputs, consequences, and results users need to operate commands.
Correct provider switching/reset requirements, explicit versus default export check scope,
copyable stdin examples, output formats, mutually exclusive list filters, and split/merge
skip annotation removal. Explain check JSON count/level semantics in one sentence because
it affects interpretation of successful checks. Simplify clip status descriptions without
exposing their internal precedence algorithm.

Combine repetitive list/check examples. Move the full TOML patch into the framework Examples
section after invocation examples, leaving Usage and Options before the literal patch.
Omit its optional check-range metadata so its illustrated operation times do not contradict
an explicit range. Preserve target/stage/output contracts on each independently usable leaf.
Do not expand help with apply language-selection algorithms, neighbor collection, or an
exhaustive nested JSON schema. Runtime behavior is unchanged.


Validation: all 212 package tests pass, along with package typecheck and build.
All 16 built help pages exit successfully. The rendered stdin example was executed
with a harmless output sink and its resulting TOML parsed successfully. List help
is now 71 lines and check help 118 lines; apply Usage moved from line 125 to line 62,
with the full patch example retained after invocation examples.


## Help Review Wording Corrections

Keep help at the level of user inputs, effects, and outputs. Single-operation dry-run
help promises a preview without writes, not complete validation. Apply dry-run defaults
to operation and check summaries; non-JSON --verbose replaces summaries with segment
rows, while JSON retains summaries and adds rows. Patch range help describes paired
start/end for an explicit range and an automatic range otherwise, without explaining
neighbor collection. List help briefly notes that Japanese QA can match error in
translation work while check reports warning; existing execution behavior is retained.

Root help documents new-session transcription frontmatter and configuration precedence,
and points to doctor help for credentials and tools. List stage descriptions use reads.
Clip help keeps the artifact tree and removes the duplicate artifact list and upload
notice. Independently usable leaf pages retain their target, stage, and output contracts.

Validation: 212 package tests passed; package typecheck and build passed. All 16
built help pages exited successfully, and the changed rendered pages were reviewed
for wording and wrapping. Prettier checks and git diff --check passed.

## User-Approved Accuracy Corrections

Clarify new-session transcription precedence: CLI fields override frontmatter, and only
fields absent from both use provider defaults. Switching provider also requires a
matching model. Describe reset consequences directly: rerunning may overwrite existing
work files and outputs; transcript_raw clears raw checkpoints.

Document apply output modes accurately: default operation/check summaries, non-JSON
verbose rows instead of summaries, and JSON summaries with additional verbose rows.
Verbose JSON rows always have affected; issues appears only when problems remain.
For segments list, listed counts returned rows; total, translated, and untranslated
count the entire work file. These changes affect help wording only.

Validation: root, segments list, and segments apply source CLI help exited successfully;
rendered wording assertions and git diff --check passed. Runtime behavior is unchanged.
