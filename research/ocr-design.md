# open-code-review (OCR): how it works, and what Boxie should take

Subject: `alibaba/open-code-review`, Apache-2.0, Go. Installed locally: 1.13.3
(`runs/.tmp/aacr/ocr-cli/node_modules/@alibaba-group/`). Source read from `main` on GitHub on
2026-11-02 (raw files). The local binary's `--help` output matches what the source shows. Paths below
are repo paths unless they say otherwise.

Why it matters: on 5 AACR-Bench PRs with the same model (gemini-3.8-flash-high), OCR scored F1 0.290 /
P 0.524 / R 0.200 at about 220 s per PR. Boxie scored F1 0.109 at about 1,180 s, and 2 of its 5 runs
produced no review.

Measured from the local OCR result files (`runs/.tmp/aacr/aacr-bench/evaluation/results/sample5/ocr/gemini/*.json`):

| PR | secs | files | groups (files each) | tool calls (all groups, all rounds) | input tok | cache read | comments |
| --- | --- | --- | --- | --- | --- | --- | --- |
| cherry-studio | 172 | 9 | 5,1,3 | 54 | 647k | 106k | 13 |
| cline | 147 | 18 | 6,7,2,3 | 59 | 886k | 230k | 0 |
| react | 243 | 11 | 2,5,4 | 98 | 1,258k | 429k | 3 |
| mpv | 462 | 5 | 5 | 32 | 505k | 133k | 3 |
| vllm | 75 | 13 | 2,5,4,2 | 31 | 296k | 0 | 2 |

The bench harness passed `--max-tools 30`. OCR clamped that to 50 (stderr: "--max-tools 30 is below
minimum 50, using 50"). The harness matches lines with tolerance `--line-k 1`
(`aacr-bench/evaluation/pipeline.py`), so where a comment lands counts as much as what it says.

---

## 1. Pipeline end to end

Entry point: `Agent.Run` in `internal/agent/agent.go` ("parse diffs -> group -> plan per group -> LLM
tool-loop -> collect comments").

1. **Parse diffs** (`internal/diff/*`). All diffs go into a read-only DiffMap *before* filtering, so
   the model can still call `file_read_diff` on a file that was filtered out.
2. **Select files** (`internal/agent/selection.go`, `selectFiles` / `whyExcluded`). This is a pure,
   deterministic step that `--preview` and the real run share. The gates, in order:
   binary → built-in secret paths (`.ssh`, `id_rsa`, `.netrc`, `.npmrc`, `.env*` except templates;
   `internal/config/allowlist/default_secret_patterns.json`) → user `exclude` → user `include`
   (bypasses the next two gates) → extension allowlist (`supported_file_types.json`; `.md` is *not*
   on it) → default path excludes (`default_exclude_patterns.json`). Deleted files are kept as
   prompt context but never reviewed. A file whose diff alone is over 80% of `MAX_TOKENS` is
   excluded as `too_large`.
   - The default excludes cover **test files** in every language (`**/*_test.go`,
     `**/*.test.{js,jsx,ts,tsx}`, `**/*.spec.*`, `**/__tests__/**`, `**/test_*.py`, `**/*Test.java`…),
     plus fixtures, snapshots, generated code (`*.pb.go`, `*.generated.*`), lockfiles, `node_modules`,
     `dist`, `vendor`, `target` and similar. This costs some recall whenever ground truth includes
     test-file issues.
3. **Group into bundles** (`internal/agent/grouping.go`, `Template.GroupingPlan` in
   `internal/config/template/template.go`). The thresholds come from `task_template.json`:
   - 1 file: a group of one.
   - Fewer than `GROUPING_MIN_FILES`=4 files: if total churn is under `GROUPING_BUNDLE_LINE_THRESHOLD`=200
     lines, everything goes into one bundle labelled "small change set"; otherwise one group per file.
     No LLM call is made.
   - 4 or more files: one LLM call (`GROUPING_TASK`). The model sees **metadata only**, one line per
     file: `[i] MODIFIED   path (+N/-M)`. It returns `[{"label","files":[indices]}]`. Indices are
     used instead of paths to save output tokens. Files the model leaves out get groups of their own.
     Groups are capped at 10 files (`maxFilesPerGroup`). A group whose summed diff tokens exceed the
     prompt limit is split back into single files. If the call or the parse fails, the fallback is
     one group per file.
   - The grouping prompt (`prompts/grouping_task_system.md`) bundles files that share a module or
     feature, have a producer/consumer link (interface and implementation), are i18n/config variants
     of one resource, or share a directory and work on one concern.
4. **Dispatch** (`dispatchSubtasks`). One goroutine per group, with a semaphore of `--concurrency`
   (default 8). The per-group deadline is `--timeout` (default 15 min) × review rounds, so 30 min at
   medium effort. Each HTTP request has its own timeout of 300 s (`OCR_LLM_TIMEOUT`). With
   `--max-tokens-budget` set, a group is not dispatched if used tokens plus its estimate would pass
   the budget.
5. **Per-group subtask** (`executeGroupSubtask`):
   - Diffs are concatenated as `<file path="...">…</file>` blocks. The other changed files are listed
     as `STATUS path (+N/-M)` with no content.
   - Rules are resolved per file and merged. If the group needs more than one rule set, each block is
     wrapped as `<rules for="a, b">`. Paths are sorted, so the prompt prefix stays the same between
     runs and provider caches can reuse it.
   - **Plan phase** (optional): it runs when the largest file has ≥50 changed lines
     (`PLAN_MODE_LINE_THRESHOLD`), or when there are ≥2 files and ≥100 lines in total
     (`PLAN_MODE_GROUP_LINE_THRESHOLD`). It is one tool-free LLM call. Its output becomes "Review Plan"
     in round 1 only.
   - **Main loop rounds**: `MAX_REVIEW_ROUNDS`, set by `--effort` (low 1, medium 2 (default), high 3;
     `internal/config/template/effort.go`). Round 2+ drops the plan ("to avoid it acting as a
     coverage ceiling") and adds a "Previously Confirmed Findings" block: up to 30 findings, with
     code cut at 200 chars and the issue at 300 (`internal/agent/util.go`). It stops early when a
     round adds no new finding or when 30 findings are confirmed.
   - After each round: drain the async comment workers (positioning), then run the **review filter**
     (reflection) on that round's new comments only.
6. **Main tool loop** (`RunMainTask` in `internal/llmloop/loop.go`). It allows `MAX_TOOL_REQUEST_TIMES`
   = 100 LLM requests per round (`--max-tools`, minimum 50). Each request may carry several parallel
   tool calls. Other limits:
   - A turn with no tool call gets the nudge "You did not successfully call any tools. Please try
     again or use task_done if finished."
   - Three consecutive rounds with no valid tool result stop the loop.
   - When the budget is spent, one **grace round** runs with only `code_comment` and `task_done`
     available ("Your review budget is exhausted. This is your FINAL round…"). The model can still
     flush its findings, so a spent budget does not mean empty output.
   - The completion cap is 16,384 tokens (`MAX_COMPLETION_TOKENS`). The prompt cap is 200k
     (`MAX_TOKENS`).
7. **Merge**. Comments go into a shared `CommentCollector`, keyed by path. Results are reported per
   file and marked completed or failed in a coverage manifest. A group that stopped early but has
   comments is still marked completed. Merging is plain concatenation; deduplication across groups is
   implicit, since each file belongs to exactly one group.

## 2. Review prompts (`internal/config/template/prompts/`, wired by `task_template.json`)

**`main_task_system.md`** (about 30 lines, summarized):
- Role: a concise, objective PR reviewer. It reads the diffs and uses tools for context.
- It focuses on **newly added code**. It should not comment on correct code, unchanged code, deleted
  code (reference only), or on non-functional elements such as code comments or `@Generated`
  markers.
- Strict focus: review every file in `<review_files>` on its own, look for cross-file
  inconsistencies inside the group, and never comment on files outside it. Context tools are for
  background only.
- Reply limit: before `task_done`, confirm each `<file>` got its own pass ("a file being the smaller
  or secondary member of the group is not a reason to skip it"). Report confirmed issues through
  `code_comment`. Use a context tool when confirmation is needed.

**`main_task_user.md`**: `<other_changed_files>{{change_files}}`, then
`<review_files>{{diffs}}</review_files>`, then the current time, then `<user_task>` with Requirement
Background (`--background`; in commit mode the default is the commit message, as observed in
`delegate preview`), Review Checklist (`{{system_rule}}`), Review Plan, and Previously Confirmed
Findings. Empty blocks are removed by regex.

**Output schema**: there is no free-text output. Findings come only through the `code_comment` tool
(`internal/config/toolsconfig/tools.json`). Each comment has these fields:
- Required: `content`, `existing_code` (verbatim new-side lines from the diff, used as the anchor),
  `category` (bug | security | performance | maintainability | test | style | documentation |
  other), `severity` (critical | high | medium | low), `path`.
- Optional: `suggestion_code`.

The model never writes line numbers. OCR computes them (section 5).

**`plan_task_system.md`**: plain text only, in this shape: `Summary:` → `Issues` → numbered
`[high|medium|low]` items sorted by severity, each with `→ tool args — reason` lines saying which
tool call would verify the issue. The tools are described but never invoked. Severity is defined
(high = security, data loss, crash; medium = performance, edge cases; low = style). "Do not invent
issues"; `(none)` is allowed.

**`memory_compression_task_system.md`**: summarizes the conversation into Identified Issues, Tool Call
Conclusions, Completed, Pending, and Current Focus. It contains no code.

## 3. Toolset (`internal/config/toolsconfig/tools.json`, `internal/tool/*.go`; docs `pages/.../en/tools.md`)

| Tool | Args | What it does / limits | Plan | Main |
| --- | --- | --- | --- | --- |
| `task_done` | `state` DONE/FAILED | ends the loop; FAILED fails the subtask | no | yes |
| `code_comment` | `comments[]` (see above) | records findings; positioning runs async in `CommentWorkerPool` | no | yes |
| `file_read` | `file_path`, `start_line?`, `end_line?` | post-change version; **max 500 lines** per call (`fileReadMaxLines`); header shows total lines, `IS_TRUNCATED`, `LINE_RANGE`; the description teaches computing ranges from `@@ -x,y +m,n @@` | no | yes |
| `file_read_diff` | `path_array[]` | diffs of other changed files (including filtered ones) | yes | yes |
| `file_find` | `query_name`, `case_sensitive?` | filename keyword match (path match if the query has `/`); first 100 hits | yes | yes |
| `code_search` | `search_text`, `file_patterns[]?` (git pathspec, `:(exclude)`), `case_sensitive?`, `use_perl_regexp?` | `git grep -n` (falls back to `--no-index` outside git); **first 100 matches**; timeout errors tell the model to narrow the pathspec | yes | yes |

There is no shell, no write tool, and no test running. MCP tools can be added (`internal/mcp`), and
`--tools` swaps in a different registry JSON. In the local runs, `code_search` and `file_read` made up
about 80% of calls.

## 4. Rules

- **Where they live**: `internal/config/rules/system_rules.json` (embedded) maps globs to Markdown
  files in `internal/config/rules/rule_docs/`. 59 path entries, plus `default_rule: default.md`.
- **Matching**: the first matching glob wins, in declaration order. Matching uses
  `bmatcuk/doublestar/v4`, case-insensitive. Specific files come first (`**/pom.xml`,
  `**/package.json`, `**/Cargo.toml`, `**/*{mapper,dao}*.xml`, `.github/workflows/**`), then
  languages. `sniffer.go` reads the first line of a `.m` file to choose objc over MATLAB.
- **Layers** (`pages/src/content/docs/en/review-rules.md`), highest first: `--rule <json>` →
  `<repo>/.opencodereview/rule.json` → `~/.opencodereview/rule.json` → system. A user file has
  `include[]` (bypasses the default excludes), `exclude[]`, and `rules[]` of `{path, rule,
  merge_system_rule?}`. A user rule replaces the system rule unless `merge_system_rule: true`. In that
  case the output is "## System-Specific Rules (Mandatory)" + language rule + "## User-Specific Rules
  (Mandatory)". `ocr rules check <path>` shows which layer and pattern matched.
- **Built-in rule docs** (`rule_docs/`): arkts, astro, bicep, build_gradle, c, capnp, cargo_toml,
  composer_json, cpp, default, elm, freemarker, fsharp, github_config, github_workflows, go, graphql,
  handlebars_mustache, haskell, java, jinja, json, jsonnet, julia, kotlin, mapper_dao_xml, matlab,
  nim, nix, nushell, objc, ocaml, package_json, php, po, pom_xml, pot, powershell, prisma,
  properties, protobuf, pug, python, r, rego, rust, shader, solidity, swift, terraform, thrift,
  ts_js_tsx_jsx, verilog, vhdl, vyper, yaml, zig. There is **no shell/bash rule**; `.sh` gets
  `default.md`.
- **Format**: Markdown checklists under `####` headings. `default.md` (22 lines) is a generic list:
  Correctness, Security, Performance, Maintainability, Test Coverage. The language docs are specific.
  For example, `python.md` (77 lines) opens with "Favor precision over recall: only raise an issue
  when you are confident…". It then lists concrete defect classes (typos at declaration sites, dead
  code, mutable defaults, boundary cases, bare except, `is` on literals, resources,
  performance-on-hot-path, async), and each section has explicit **"Do not report …"** carve-outs and
  "confirm with `file_read` before flagging" instructions. `go.md` is 69 lines / 10.8 KB.
  `ts_js_tsx_jsx.md` covers typos, dead code, quality checks (no `var`, `===`, no `any`, null checks)
  and React practices.

## 5. Positioning and reflection

OCR's README calls these "external positioning and reflection modules". In the source they are
comment resolution/re-location and the review filter.

**Positioning** (anchor → line numbers). It runs for each `code_comment`, in
`internal/llmloop/loop.go` `executeToolCall`. Order:
1. `diff.ResolveComment` (`internal/diff/resolver.go`), **deterministic**. It splits `existing_code`
   into lines, normalizes each one (trim, strip a leading `+`/`-`, drop blank lines), and slides a
   window over each hunk's new side (context + added lines with new-file line numbers). If that
   fails it tries the old side, then the whole new file content. The first consecutive match sets
   `start_line`/`end_line`.
2. `diff.RelocateAcrossFiles`, **deterministic**. When the snippet belongs to another changed file
   (for example, the comment was filed on a header but quotes the implementation), it moves the
   comment to that file. This happens only on a *unique* hit; ambiguous matches are left alone.
3. `diff.ReLocateComment` (`internal/diff/relocation.go`), **an LLM call**, made only if 1 and 2
   fail. The `re_location_task_*` prompt (with `/no_think`) gives the file diff, the failed snippet
   and the comment, and asks for the minimal contiguous range copied **verbatim** with the diff
   markers stripped, as a single fenced block and nothing else. Step 1 then runs again on the
   answer. If that fails too, the original snippet is restored.

**Reflection = review filter** (`REVIEW_FILTER_TASK`, `executeGroupReviewFilter` in `agent.go`). This
is **one LLM call per group per round**, made after the main loop, over that round's new comments.
`--no-filter` turns it off.
- The input is the group's diffs only, plus the comments as JSON `[{id:"c-N", path, content,
  existing_code}]`. It is told the reviewing agent saw more than the filter can.
- The prompt summary: you are a fact-checker. Remove only comments the diff **proves** wrong. Keeping
  a wrong comment is cheap; removing a right one is not. The default answer is approve-all.
- There are only two grounds for removal:
  - **Ground A**: the construct the comment describes is not in its subject file's diff.
  - **Ground B**: one diff line literally contradicts the comment's central claim (for example, it
    says "unused" and the diff shows a use).
- Vetoes apply first and always mean approve:
  - **Protected subjects**: memory safety, concurrency, linkage/declaration consistency,
    behavioural/compat change, unused parameter.
  - **Value veto**: a true style or naming comment.
- The method runs as five ordered steps.
- Output is forced through **two tools**: `report_incorrect_comments{analysis[], comment_ids[]}` or
  `approve_all_comments{}`. The comment in `agent.go` explains that `analysis` comes before
  `comment_ids` on purpose: Go serializes the fields alphabetically, so the model reasons before it
  commits to IDs. Replayed sessions showed the model could not take back IDs it had already written.
  A text fallback parser covers models that answer without a tool call.

Note: the filter is built to be *permissive*. OCR's precision comes mainly from the main prompt's
"newly added code only / no comments on correct code" scope, the precision-first rule docs, and
having no free-text output channel. The filter only removes comments that are provably wrong.

## 6. Delegation mode and the OpenCode plugin

`ocr delegate` makes **no LLM call** (`cmd/opencodereview/delegate_cmd.go`,
`internal/delegate/format.go`, `rulegroup.go`). Output observed on this repo
(`delegate preview -c 4e7b6a2`):

- `delegate preview --format json`: `{schema_version:"1", mode:"workspace|range|commit", repository,
  commit | from,to,merge_base, background, total_files, reviewable_count, excluded_count,
  total_insertions, total_deletions, reviewable_files:[{path,status,insertions,deletions}],
  excluded_files:[{path,status,insertions,deletions,reason}]}`. Reasons include `unsupported_ext`,
  `default_path`, `secret_exclude`, `too_large`, `deleted`. The text form is a Markdown list, with
  excluded files struck through.
- `delegate rule --format json <paths…>`: `{schema_version:"1", groups:[{group_id, source:"system|…",
  pattern, files[], rule:"<markdown>"}]}`. Files that share identical rule text are grouped. In text
  form: `### Rule Group N: system / <pattern>`, then "Applies to", then the content.
- **How a host uses it** (`skills/open-code-review-delegate/SKILL.md`,
  `pages/.../integrations/delegate.md`):
  1. Run preview.
  2. Run rule over the reviewable paths.
  3. Get diffs with plain git commands. The modes and refs from preview pick the command
     (`git --no-pager diff --no-ext-diff --no-textconv --no-color <merge_base>..<to> -- <path>` for
     range, `git show` for commit, `diff HEAD` + `cat` for workspace); large diffs go to an
     `--output` file read in chunks.
  4. Review each file against its rule group.
  5. Report comments as `{path, content, start_line?, end_line?, category?, severity?}`, with
     coverage (`total_files`, `reviewed_files`, `skipped_files`, `coverage_rate`), dropping low
     findings unless clearly valuable.

  In short, delegation hands over the deterministic scaffold but none of the loop, positioning,
  filter, or prompts.
- **OpenCode plugin** (`plugins/open-code-review/opencode/open-code-review.ts`, 617 lines; README
  there):
  - Installation: curl the single `.ts` file into `~/.config/opencode/plugins/` or
    `.opencode/plugins/`, then `npm install @opencode-ai/plugin` (OpenCode 1.x; 2.x also needs
    `@opencode/plugin@beta`).
  - It registers the tools `ocr_review` (args commit/from/to/resume/background/backgroundFile/
    exclude/model/concurrency/timeoutMinutes/overallTimeoutMinutes/maxTools/maxGitProcesses/preview)
    and `ocr_health` (`ocr version` + `ocr llm test`), plus the commands `/ocr-review` and
    `/ocr-health`. It never overrides existing commands of the same name.
  - It is only a wrapper. It spawns `ocr review --audience agent --format json --repo …` with
    `shell:false`, a 15-min default process timeout (30 per the README), a 10 MiB output cap, and
    `taskkill /T` on Windows.
  - It does not use delegation mode: OCR's own configured LLM does the review.

## 7. Config by env vars only; JSON output

The source is `internal/llm/resolver.go`. Resolution tries these sources in order: `~/.opencodereview/config.json` →
**OCR env** → Claude Code env (`ANTHROPIC_BASE_URL/AUTH_TOKEN/MODEL`) → shell rc file. The first one
that is complete wins. In a clean container (no config file, no rc), the OCR env vars are enough:

```sh
OCR_LLM_URL=http://host.containers.internal:20128/v1   # base URL
OCR_LLM_TOKEN=<key>                                    # bearer token
OCR_LLM_MODEL=antigravity/gemini-3.8-flash-high
OCR_LLM_PROTOCOL=openai      # IMPORTANT: env default is anthropic (OCR_USE_ANTHROPIC defaults true)
OCR_LLM_TIMEOUT=300          # per-request seconds (optional)
OCR_LLM_EXTRA_HEADERS=...    # optional; OCR_LLM_AUTH_HEADER only for anthropic protocol
```

`--model` overrides the model for a single run. Protocols: `anthropic`, `openai` (chat
completions), `openai-responses`. If the host has a `~/.opencodereview/config.json`, it shadows the
env, so isolate `HOME` in a container.

**`ocr review --format json [--audience agent] [-o file]`** writes an envelope
(`cmd/opencodereview/output.go`) with these top-level fields:
`status`, `llm{provider?,model}`, `trace_id?`, `message?`, `summary{files_reviewed, comments,
total_tokens, input_tokens, output_tokens, cache_read_tokens?, cache_write_tokens?, elapsed,
budget_exceeded?}`, `tool_calls{total, by_tool{}, failure, failure_by_tool{}, failure_details[]}`,
`comments[]`, `groups[{label, files[]}]`, `warnings[{type,file,message}]`, `session_id`,
`manifest{schema_version, run_id, operation, terminal_state, repository, input, execution, coverage,
elapsed_ms}`, and `retry_report?`. Each comment (`internal/model/review.go`) is `{path, content,
suggestion_code?, existing_code?, start_line, end_line, thinking?, category?, severity?}`. Line
numbers are new-file lines. Exit code is 0 for partial results; it is non-zero only when every
selected item failed. `--format sarif` also exists.

## 8. Token economy

- **Context isolation**: each group is its own conversation and sees only its own diffs. Other changed
  files show up as one-line metadata, fetched on demand through `file_read_diff`. Grouping sends only
  the file list, never diff content. The filter and the re-location call each see one group's or one
  file's diff, not the conversation.
- **Diff-first**: the diff is in the first user message, so the model never spends turns finding the
  change. Full files are read in windows of at most 500 lines, guided by hunk headers.
- **Bounded growth**: memory compression (`internal/llmloop/compression.go`) starts in the background
  at 60% of `MAX_TOKENS` and synchronously at 80%. It keeps recent rounds and summarizes older ones.
  The loop stops if a conversation is still over 80% after compression.
- **Caching**: no explicit cache markers were found for the OpenAI path. OCR relies on implicit prefix
  caching: each round re-sends an append-only conversation. It keeps prefixes stable on purpose
  (sorted rule blocks, a fixed system prompt). It scopes an affinity key per conversation
  (`llm.SessionTaskKey(session, task, file)`; `internal/llm/sessionkey.go`), which it sends as
  `prompt_cache_key` on the Responses API and exposes as a template variable for `extra_headers` /
  `extra_body` elsewhere. Locally, 0–35% of input was cache reads. I did not check the Anthropic
  client's cache_control handling.
- **Scale**: 0.3–1.26M input tokens per PR locally. That is more fresh input than Boxie's
  0.27–0.58M, but OCR used far less total context than Boxie's 6.5–12.2M cache reads per run (figures
  from `docs/review-improvement-brief.md`), and it took 31–98 tool calls per PR in total, spread over
  parallel groups.

## Licensing note for vendoring

Apache-2.0. The repo root has `LICENSE` but **no NOTICE file**; the only NOTICE is
`internal/viewer/static/icons/NOTICE`, for icons. Go files carry an SPDX header
("Copyright 2026 alibaba/open-code-review Contributors"); prompt `.md` and rule `.md` files have no
header. To vendor them, keep a copy of the Apache-2.0 license, add an attribution line naming the
source path and commit, and state in each changed file that it was modified (§4b). No upstream NOTICE
needs to be carried.

---

## What Boxie should adopt

Ranked by expected gain. P = precision, R = recall, T = time. [copy] means the code, prompt or JSON
can be vendored with attribution. [idea] means reimplement it.

1. **Run `ocr review --format json --audience agent` as the review worker in the container** (env
   from section 7, `OCR_LLM_PROTOCOL=openai`, `HOME` isolated). This gives the measured OCR numbers
   at once (F1 0.29, ~220 s) and fixes Boxie's empty runs. P+R+T. [copy: binary; needs the user's OK
   to install the npm or linux binary in the image]
2. **Diff in the first message; findings only through a tool; no free-text verdict.** Use a fixed
   read-only toolset (read ≤500 lines, git-grep ≤100 hits, find, other-file diff, comment, done) and
   no bash. This removes the step spent discovering the change and most of the 90–150-step loops. T
   (large), P. [copy: `tools.json` definitions, `main_task_system.md`/`main_task_user.md`]
3. **A hard round cap plus a grace round** limited to `code_comment`/`task_done`, and a nudge on
   turns with no tool call. A spent budget still produces findings, which addresses the 2-of-5 empty
   runs. T, R. [idea; prompt text is copyable]
4. **Anchor by `existing_code`, then compute lines deterministically.** The order is new-side hunk
   window → old side → whole file → unique cross-file hit → LLM re-locate. The judge matches lines
   at k=1, so wrong lines cost P and R directly. P, R. [copy: ~150 lines of `resolver.go` logic to
   port to JS; `re_location_task_*` prompt]
5. **Per-language precision rule docs** chosen by glob (`system_rules.json` + `rule_docs/*.md`).
   They carry explicit "Do not report…" carve-outs and a precision-over-recall header. Add a bash
   rule; OCR has none. P. [copy: 59 rule docs + the mapping]
6. **Deterministic file selection** (binary, secrets, extension allowlist, lockfiles, generated,
   vendor) and **no setup step on review runs**. Decide on purpose about OCR's test-file exclusion:
   keep tests in if AACR ground truth includes them. T, P. [copy: the allowlist JSONs]
7. **Bundle and parallelize.** Under 4 files and under 200 lines: one bundle. Otherwise do LLM
   grouping on metadata by index, at most 10 files per group, then run groups concurrently (8).
   Divide-and-conquer keeps each context small and wall time at the slowest group. T, R. [copy:
   grouping prompt; idea: thresholds]
8. **Review filter after each round**: proof-only removal, protected-subject veto, two forced tools
   with `analysis` before `comment_ids`. A small gain (it is permissive by design), but cheap: one
   call per group. P. [copy: `review_filter_task_*` + the `filterTools` schema in `agent.go`]
9. **Rounds 2–3 with confirmed findings injected and the plan removed**, stopping early when a
   round finds nothing new. `--effort high` (3 rounds) is the main lever to beat OCR's R 0.20. R
   (at some T cost). [idea; prompt text copyable from `util.go`]
10. **A plan pass only for big changes** (a file ≥50 lines or a group ≥100 lines): one tool-free
    call that lists risks with severity and the tool calls that would verify them. R on large diffs.
    [copy: `plan_task_*`]
11. **Stable prompt prefixes and a per-conversation cache key**; compression at 60/80% only if
    contexts still grow. T and cost. [idea]
12. **`ocr delegate preview/rule --format json`** as a no-LLM preprocessor, if Boxie keeps its own
    OpenCode loop: file list, exclusion reasons, and rule text per group. A small gain alone; it
    provides items 5 and 6 without vendoring. [copy: binary]
