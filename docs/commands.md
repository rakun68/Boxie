# Commands

Back to the [README](../README.md).

```bash
./delegate.sh run    <repo> <task.md> --role <role> [--name N] [--base REF] [--timeout MIN] [--test CMD]
./delegate.sh run    <repo> <task.md> --model <id> [--effort E] [--review] [--web] ...
./delegate.sh continue <repo> <run-name> (-m TEXT | -f FILE) [--timeout MIN]    # resume that worker's session
./delegate.sh questions <repo> <run-name> [--wait]                              # open questions of a running worker
./delegate.sh answer <repo> <run-name> <id> (-m TEXT | -f FILE)                 # answer one; it keeps working
./delegate.sh fanout <repo> <task.md> --roles implement,feature [--base REF] ...   # parallel, comparison table
./delegate.sh review <repo> <branch> [--review-mode split|both] [--roles a,b] [--against REF] [--focus TEXT]  # generated read-only review
./delegate.sh loop   <repo> <run> [--spec FILE] [--max-rounds N] [--review-mode M] [--roles a,b] [--fresh R|none]  # review, verify, fix until nothing blocks
./delegate.sh loop resume <repo> <loop> [--answer T] [--drop IDs] [--add F] [-m T] [--max-rounds N] [--review-mode M]  # the orchestrator's decisions
./delegate.sh wait   <repo> <run-or-loop>... [--any] [--questions]  # block until they end; their short reports
./delegate.sh ask    <repo> [--role advise] [--prompt q.md] [--file ctx ...]       # one-pass advisor
./delegate.sh show   <repo> <name>
./delegate.sh clean  [<repo>] [--all]                # stopped and orphaned containers; live and parked runs stay
./delegate.sh stop   <repo> <run|loop>...           # stop a run now (a loop name: its rounds and base suite)
./delegate.sh doctor [<repo>]                       # prerequisites, images, OmniRoute route; fixes
./delegate.sh gc     [--days N] [--yes]             # disk: old session archives, model lists, untagged images

# ledger, trust, dashboard
./delegate.sh stats  [overview|models|runs|run R|flags|causes|notes|reviews|bench|compare|unlabeled|live] [--since 7d]
./delegate.sh stats json <view>                     # exact numbers for an agent
./delegate.sh dash                                  # interactive TUI over the ledger
./delegate.sh refs   <repo> <run>                   # what in a run still needs a reason
./delegate.sh note   <repo> <run> --refs a,b|--all --cause C --why "md"
./delegate.sh accept|reject|merged|discard <repo> <run> [--cause C] --why "md"

# more ways to delegate
./delegate.sh explore <repo> "<question>"           # read-only research digest with path:line evidence
./delegate.sh batch  <repo> a.md b.md ... [run options]          # different tasks in parallel
./delegate.sh continue <repo> <run> --findings RV-RUN[:n,m] [--drop RV-RUN:n] [-m TEXT]  # fix round from review findings
./delegate.sh tui    <repo> <run>                   # the real OpenCode TUI attached to a running worker
./delegate.sh check  <repo> <ref> [--test CMD] [--hidden DIR]    # tests on any commit, no agent

# ticket mode (to-tickets features)
./delegate.sh feature <repo> <feature-dir> [status|next|report|run [--parallel N] [--auto-land]]
./delegate.sh ticket  <repo> <feature-dir>/issues/NN-slug.md     # tests first, implement, review
./delegate.sh ticket-review <repo> <run>            # two-axis review again after a fix round
./delegate.sh land    <repo> <run>                  # one commit on box/<feature>, ticket stamped done
./delegate.sh defect  <repo> <feature-dir> "<title>" "<report>"

# benchmark
./delegate.sh bench list [suite]
./delegate.sh bench run <suite[/task]> --roles a,b [--repeat N] [--parallel K]   # BOXIE_REPOS: real repos elsewhere
node bench/validate.mjs [suite]                     # base fails, reference passes, cheats fail
```

## Watching

**Watching**: when [herdr](https://herdr.dev) is running, every run opens a tab in an `boxie`
workspace. Left: the real OpenCode TUI attached to the worker's session (the container runs `opencode
serve`, the worker runs `opencode run --attach`, the pane runs `podman exec -it ... opencode attach`),
with its subagent sessions; typing there reaches the worker. Right: the Boxie feed (`watch`):
phases, every tool call, questions the moment they are asked, the verdict and `next`; it reports the
state to herdr (working, blocked, done). Enter closes the tab. `BOXIE_TUI=0` keeps only the feed,
`BOXIE_HERDR=0` turns tabs off. Without herdr: `watch <repo> <run>`, `tui <repo> <run>`, or
`stats live` for every running worker at once.

A `loop` opens one more tab of its own (`loop-watch <repo> <loop>` without herdr), fed by
`runs/<project>/_loops/<loop>/progress.jsonl`: each round and its kind, the step running now with its
time, every finding with its severity and where it went (PROVEN, dropped, note, QUESTION, TRIAGE,
advice), what is fixed and still open, regressions, each decision and escalation, and when it stops,
what the orchestrator does next with the command. The check that reruns the reproductions has no tab
of its own; it shows only here.

## Waiting, questions, continue

the rest wait for a slot. `delegate.sh wait <repo> <name>... [--any] [--questions]` blocks until runs
or loops end and prints each one's short report, so an orchestrator waits on one background command
instead of polling.

**Mid-run questions**: workers get an `ask_orchestrator` tool (`image/ask-mcp.mjs`, a dependency-free
local MCP server; off with `run --no-ask`, never given to reviewers or the scout). A question lands in
`/out/questions/<n>.md` inside the running container; `questions <repo> <run> --wait` returns it, and
`answer <repo> <run> <n> -m TEXT` delivers the answer while the worker waits. Each tool call waits at
most 45 s (`ASK_WAIT_S`), under MCP clients' usual 60 s request timeout; the worker calls
`wait_for_answer` to keep waiting, and after 10 min (`ASK_TIMEOUT_MIN`) it is told to decide itself.
Questions and answers stay in `runs/<project>/<run>/questions/`; `summary.json` counts them.
Verified 2026-10-12: a Gemini worker asked, waited through one empty 45 s call, received an answer
that contradicted its own preferred option, and followed it.

**Continue**: every run saves its OpenCode session (`opencode-data.tgz`, session id in
`summary.json`) and its settings (`meta.sh`). `continue` starts a fresh container on the run's branch,
restores the session and sends the message: the worker keeps everything it read and tried, and the
same model, sealed files, test and checks apply. The result is `agent/<run>-r2`, `-r3`...; the base
stays the first round's, so the sealed check covers every round. Continuing an earlier round again
forks it (`-r2b`). Verified 2026-10-12: a resumed Gemini worker edited without re-reading the file
and recalled what it read in round 1 (cache read 155k tokens).

## Ticket mode

Ported from AgentOrchestratingSkill. Tickets are Matt Pocock `to-tickets` files
(`.scratch/<feature>/issues/NN-slug.md` with `**Blocked by:**`, `**Status:**`, optional `**Model:**`, and
`- [ ]` criteria; `spec.md` beside `issues/`). Per ticket: the `tests` role (Gemini Flash high) writes the
tests first; the harness accepts them only if nothing but test files changed, nothing is skipped, and
they fail on the current code (one fix round otherwise); they are sealed for the implementer, which
works on top of them; a failing implementation escalates once to `TICKET_ESCALATE_ROLE` with its
changes kept; the review mode's reviewers review in parallel (`--review-mode`, `--roles` override it). `land` squashes tests and code into
one commit on the local integration branch `box/<feature>` (never pushed, never checked out; if the
branch moved, the merge is tested in a container first), stamps the ticket done, and appends the
feature's decisions ledger, which later tickets get in their task. The project's context map needs
`test_file_command`; `test_globs` and `done_dir` are optional; `TICKET_CHECKS` and `LAND_TRAILERS`
(`\n`-separated, e.g. co-author lines) come from `projects/<repo>.env`.

## Benchmark

`bench/` holds frozen tasks on fixture repos materialized with fixed commit shas (`bench/README.md`).
Each task has a hidden check the worker never sees, a reference solution and cheat patches;
`validate.mjs` proves the base fails, the reference passes and every cheat fails. `lib/bench.mjs`
runs tasks through the harness per role and records the hidden check as a `bench` event; `expect:
blocked` tasks pass only when the worker stops BLOCKED and the behaviour is intact. The task files are
harness-agnostic: run another harness on the same task, base sha and check to compare.
