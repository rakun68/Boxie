# Implement: getting it right the first time

Researched and built 2026-11-07. Question: implementation takes most of Boxie's time. How do we cut
re-implementation, and when is one agent better than several?

Tags follow research/workflow.md: **[S]** sourced, **[M]** measured here, **[I]** inference.

## 1. Where implement time goes [M]

From `ledger/events.jsonl`, implement-role runs that are not benchmark runs, 2026-10-12..11-06:

| | runs | median total | median agent | median steps |
| --- | --- | --- | --- | --- |
| first round | 105 | 1854 s | 1771 s | 130 |
| later rounds (fixes) | 110 | 832 s | 736 s | 41 |

- First rounds were 67 h and later rounds 37 h. Rework is about 36 % of implement time.
- Runs per task: 38 tasks took one run, 63 took two or more (34 two, 14 three, 15 four to nine).
- Tool time is a small share. The median first round spent 314 s in tools, against 1771 s for the agent. The rest is
  model latency over about 130 steps.
- Re-reads are not waste. 3608 of 5629 reads were of a file read before, but only 89 repeated the same
  range with no edit in between. The rest were pages of long files.
- **The scout subagent was never used**: 0 `task` calls in the 102 first rounds with events. Its tool
  description rode along on every step.

From the 53 loop states under `runs/*/_loops/`, round 1's medium-or-worse findings:

- logic: 30
- requirement: 21
- edge case: 12
- security: 11
- regression: 8
- other: 14

Read one by one, most logic findings are a missed ripple: another path that still does the old thing,
for example "The interactive guard still refuses --mode" or "still advertises '[a] always'". Requirement
findings are a part of the task left out, such as "README has no prototype-limits section". 34 of 53 loops
needed at least one fix round.

Self-check, tried 2026-10-17 [M]: one more turn in the same session, auditing the diff against the task.
It made 0 edits in 15 runs, and the reviews after it still found the edge cases its checklist named. The
same model in the same session passes its own work [S: SELFPREF, arXiv 2404.13076].

## 2. What the sources say

**Anthropic, harness design for long-running apps** [S]
(https://www.anthropic.com/engineering/harness-design-long-running-apps):
- The harness has a planner, a generator and an evaluator. Before each sprint, the generator and the
  evaluator agree a "sprint contract": what will be built and how it is verified.
- When Opus 4.6 came, the sprints were dropped and the evaluator moved to one pass at the end. The planner
  stayed: "without the planner, the generator under-scoped".
- Out of the box, the evaluator approved work it had flagged as buggy. A separate, skeptical evaluator is
  "much more tractable" than making the generator judge itself.
- The evaluator pays off only when the task is "beyond what the current model does reliably solo".
  Pieces were removed one at a time to find which were load-bearing.

**Claude Code dynamic workflows** [S] (https://code.claude.com/docs/en/workflows):
- The plan moves into a script. The runtime runs it, and intermediate results stay in variables, not in
  Claude's context.
- Quality comes from repeatable patterns:
  - adversarial verify (independent agents try to refute each finding);
  - plans drafted "from several angles" and weighed before committing;
  - "keep fixing until a check passes or two rounds in a row make no progress";
  - loop-until-dry discovery.
- Fit: breadth (one agent per file or item), cross-checked research, and migrations across many files
  in isolated worktrees. Runs cost more tokens than doing the task in conversation.
- Boxie already is this shape. `lib/loop.mjs` is a deterministic script, workers run in disposable
  containers, the gate is executable checks, and it stops on no progress. The loop now uses
  open-code-review for its reviews.

**Claude Code best practices** [S] (https://code.claude.com/docs/en/best-practices):
- Give the model a check it can run.
- Review against the spec in a fresh subagent: "check every requirement is implemented and the listed
  edge cases have tests".
- "Handing the same task to a subagent doesn't make the answer any better. A fresh reviewer does help."
- A fresh subagent "can end up slower", because it gathers again the context the session already had.

**Single agent vs several** [S]:
- Co-Coder (arXiv 2606.00953): naive file-level parallelism produced conflicting interfaces and
  re-generation. Grouping tightly coupled files into one agent gave up to +14.0 % pass rate, 2.10x
  speed and -35 % cost. Claude Code agent teams had the lowest pass rate, 54.1 % on DevEval.
- SAIGE (arXiv 2609.19759): several agents help on long tasks with sparse dependencies. Single agents
  stay better on "tightly coupled, sequential workflows", and more agents give diminishing returns.
- Cognition, "Don't build multi-agents": share full context, because split agents make conflicting
  implicit decisions.
- Claude Code docs: for same-file edits and heavily dependent work, one session is better than a team.

Your observation fits this. One agent does well on coupled work because it keeps every implicit
decision in one context. Several agents pay off only when their pieces share little.

## 3. What was built

**Decision** `[1]` **Contract first, with a critic from another family**
(`CONTRACT=1`, `image/preamble-contract.md`, `contract_ready` in `image/ask-mcp.mjs`).
- Before its first edit, a first implement round writes a contract:
  - requirements, each with its place and the test that fails without it;
  - ripple, the `path:line` of every caller, reader and doc that must change or keep working;
  - edge cases, each with its expected result;
  - what stays unchanged.
- `image/plugin.js` refuses edits until the contract is recorded.
- The first `contract_ready` call sends the task and the contract to a model of another family:
  `CONTRACT_MODEL` (Sol 6.1 high, `cx/gpt-6.1-sol-high`), or `CONTRACT_MODEL_ALT` (Gemini) when a GPT model implements.
  It is one pass with no repo, limited to gaps the task implies, at most 8.
- The gaps go back to the worker, who adds the ones it agrees with and gives reasons for the ones it
  rejects.
- Why this and not the self-check:
  - it targets the two largest finding classes, missed ripple and missed requirements;
  - it works before the code exists, as the planner and sprint contract do in Anthropic's harness;
  - the critic is fresh and of another family, which is what the self-check lacked.
- Cost: one chat completion (it took 10-40 s here) plus the contract turn.
- Summary: `contract: {written, lines, critic}` in `summary.json`.

**Decision** `[2]` **Scout off** (`SCOUT_MODEL=""`): 0 uses in 102 runs.

**Decision** `[3]` **Coupling check** (`delegate.sh couple <repo> <task.md>...`, `lib/couple.mjs`).
- Tasks that share a file, or where one task's file imports the other's, form a group: one worker or in
  sequence. The rest run in parallel.
- Deterministic and quick (JS/TS/Python relative imports, Java/Kotlin package), for the orchestrator
  before it fans a phase out.

**Not built:**
- Moving the evaluator into the implement run. The loop already continues the same session in a
  parked container, so the saving is only setup time.
- Best-of-N first rounds. Without an executable selector they waste tokens (research/workflow.md §1.2).
  The loop's fresh attempts already cover stalls.

## 4. Benchmark

Results in §5. It was run after the build: arms A (`CONTRACT=0`) and B (`CONTRACT=1`), the same image, one
container at a time, alternating per task.

## 5. Benchmark [M]

2026-11-07, `runs/.tmp/ab-contract.sh`. The implement role ran alone with the same image and model, one container
at a time, and A and B alternated. The runs did not overlap in time. Bench task history before this:
report-sort passed 4/17 (the hidden cases are numeric sort, stable ties and sort before `--limit`), honesty
6/9 and truncate-width 9/11.

| task | A (`CONTRACT=0`) s | B (`CONTRACT=1`) s | pass A / B |
| --- | --- | --- | --- |
| feature-report-sort | 319, 277, 288, 571 | 325, 495, 496, 405 | 4/4, 4/4 |
| bugfix-truncate-width | 211 | 195, 205 | 1/1, 2/2 |
| honesty-week-start | 358 | 278 | 1/1, 1/1 (both blocked, correct) |

- Pass rate: no difference. Every run passed its hidden check, A included. report-sort is at the ceiling
  in both arms now, so this bench cannot show a quality gain.
- Time: report-sort's median was 304 s for A and 450 s for B, about +150 s. truncate-width was the same.
  On honesty, B blocked before writing a contract, so the gate cost nothing.
- Steps on report-sort (from the bench table): A 34, 31, 41 and B 33, 35, 30. Tokens: A 1.16M to 1.50M,
  B 1.04M to 1.26M.
- Critic (Sol): 6 calls, 6 to 19 s each. It answered "no gaps" 5 times. Once it found one real gap, the exact
  help text the task required.
- The first try, with the broken DeepSeek critic (empty answer), gave A 306 s and B 339 s on report-sort, both passing.

What this means:
- On short bench tasks the contract costs time and shows no gain. n is small (13 runs), so this is anecdotal.
- What the contract aims at is fewer fix rounds in real loops: 34 of 53 loops needed one, and a fix round's
  median is 832 s. The bench measures only the first round, so that effect is **unmeasured**.
- It stays on by default. The ledger now records `contract` on each implement run. **Tripwire**: after
  about 20 loops with it on, compare the share of loops that need a fix round against 34/53. If it is not
  lower, set `CONTRACT=0`.
