# Known gaps

Found while driving Lykos P2's third band (T208–T218) through `loop` with
`BOXIE_SLOTS=3 BOXIE_PARK=1`, 2026-10-19 to 2026-10-20. Each entry says what was seen, why,
and the workaround used. Lykos P3 (2026-10-22) added 5 to 8, and a startup-time survey added 9.
All nine were fixed on 2026-10-23
(**Fixed** lines); the RakunLoots P9 gaps are in docs/rakunloots-p9/rakunloots-phase9-2026-10-21.md (local only, not in git).
Unit tests cover the host-side logic (test/gaps.test.mjs). The shell-side fixes are checked by
`bash -n` and by hand, not yet in a live run.

## 1. A resumed parked session waits for its own slot number

**Seen.** L209's `rv1` and L217's `rv2` looked hung: the loop waited, the reviewer printed nothing.

**Why.** A parked container frees its slot, but resuming it waits for the same slot number
(`runs/.slots/N`) it held before. Another run (t215) had taken slot 3, so the resume blocked until
t215 ended, although slots 1 and 2 were free. Nothing in the loop output says it is waiting on a
slot.

**Workaround.** Let the run holding that slot finish, or `unpark` it. Better: a resume takes any
free slot, and a wait for a slot prints which run holds it.

**Fixed.** `slot_acquire` prefers the parked slot only for `SLOT_PREFER_WAIT` seconds (default 0),
then takes any free slot and starts a fresh container (the parked one is removed, with a message).
A wait prints the holders (`slot:run (project)`). Slots of dead owners are reclaimed.

## 2. A stopped Podman VM reads as "ended with no summary"

**Seen.** `loop resume L212` started fix round `L212-fix1-1`, which ended 9 ms later with
`next fix_environment: fix round L212-fix1-1 ended with no summary`. No run directory was created.

**Why.** The Podman machine (`podman-machine-default`, WSL) had stopped; `podman` refused the
connection on `127.0.0.1:50461`. The loop does not check the engine before a step and does not
surface podman's error.

**Workaround.** `podman machine start`, then `loop resume`. Better: check `podman info` before each
step and stop with the engine's own message.

**Fixed.** `launch` calls `engine_up` (`podman info`) first and dies with the engine's error and
"podman machine start?". The loop's "ended with no summary" messages now quote the step log's tail.

## 3. An environment failure in a check container ends the loop

**Seen.** L212's `check1` failed `npm ci` with exit 6: node-gyp's headers download for
`better-sqlite3` reported "Completion callback never invoked". The loop stopped before reviewing,
although the base suite had passed.

**Why.** A network flake during dependency install is treated like a failing check. There is no
retry for install steps.

**Workaround.** `loop resume`. Better: retry `npm ci` once on a non-test failure, and label the stop
`environment` with the failing command.

**Fixed.** `run-task.sh` retries `SETUP_CMD` once after 5 s (`SETUP_RETRIES=0` turns it off; the
first log stays as `setup-1.log`) and logs the failing command with its tail. A check whose setup
failed stops the loop with `check <name>: setup failed (exit N), no test ran`, and `resume` reruns
only the check.

## 4. A worker whose gateway is down still runs the tests, and the round is spent

**Seen.** L212's fix round `L212-fix1-2`: `harness.log` shows `OmniRoute unreachable at
http://host.docker.internal:20128/v1: curl: (22) The requested URL returned error: 503`, then the
test step ran anyway (3 minutes), and the round ended `verdict error`, `next fix_environment`. No
model ran. Later `doctor` reported OmniRoute reachable from a container.

**Why.** The reachability probe only logs. The run continues to the test step, and the loop counts
the round.

**Workaround.** `doctor <repo>`, then `loop resume`. Better: stop the run at the failed probe with
an `environment` verdict, retry the probe a few times first, and do not count the round.

**Fixed.** The `/models` probe tries 4 times (10, 20, 30 s apart); still unreachable, the run skips
the agent and the tests (`agent_exit -2`, verdict `error`, next `fix_environment`). The loop counts a
fix round only when it passes. A worker that exits 0 without one model step is a provider error
("no model output", lib/ledger.mjs `noOutput`).

## 5. The repo argument must be a path, but the docs show a name

**Seen.** Lykos P3, 2026-10-22: `delegate.sh doctor lykos` and `doctor Lykos` failed with "not a git
repo". `doctor /c/Workspace/Projects/Lykos` worked. The skill and README write `<repo>` without
saying it is a path, and `projects/lykos.env` is found from the path's basename.

**Workaround.** Always pass the full path. Better: resolve a bare name through `projects/<name>.env`,
or say "path" in the usage line.

**Fixed.** `repo_path` resolves a bare name through `REPO_PATH` in `projects/<name>.env`; otherwise it
dies with "not a folder: X (pass the repo's path …)". The usage says `<repo>` is a path.

## 6. `loop` takes no `--add` at the start

**Seen.** Lykos P3 T195: I had my own findings before the first review. `loop` rejects `--add`; only
`loop resume` accepts it. The skill's "the same options at the start and on `loop resume`" reads as
if it applied to `--add` too.

**Workaround.** `continue <run> -f findings.md` first, then `loop` on the new round. Better: accept
`--add` at the start and send it to the first fixer with the review's findings.

**Fixed.** `loop --add FILE` at the start goes to the first fixer. A JSON findings array in `--add`
(start or resume) joins the loop: items with a valid reproduction become proven open items and
proofs, the rest go to the fixer as advice. `resume --retire ID` takes an item out without a
false-positive label.

## 7. A node_modules junction in a seal worktree can empty the main checkout

**Seen.** Lykos T195's first round linked the host's `node_modules` into a temporary `git worktree`
and removed the worktree with `git worktree remove --force` without unlinking first. The same
pattern emptied Lykos's `node_modules` once before (user memory "AGY worktree node_modules
junction"). The harness's review did not flag it.

**Workaround.** Name this in the task for any worker that creates worktrees. Better: a standing
lesson in the Lykos context pack.

**Fixed.** `lib/pack.mjs` reads top-level `traps:` from a context map into every pack.
`projects/lykos.context.yaml` has the trap: unlink `node_modules` before `git worktree remove --force`.

## 8. `wait --questions` returns at once on a question already answered

**Seen.** Lykos T197 loop: after `answer ... 1`, a new `wait loop-t197-r2 t199-r2 --any --questions`
returned immediately with "loop-t197-r2-rv1-review-both asks:" and an empty question;
`questions` said "no open questions".

**Workaround.** Check `questions <run>` before trusting the wake; start the wait again. Better: count
only unanswered questions.

**Fixed.** `wait --questions` skips parked runs, uses a file of its own per process (two waits
shared one before), and wakes only on output with a `## question` heading. `questions` skips empty
question files and answered ones.

## 9. Every fresh container spent 45-60 s before the first model step

**Seen.** 2026-10-23, from run artifacts. Since 2026-10-20 the median time from launch to the first
model step was 92 s on Lykos (104 runs) and 46 s on RakunLoots (60 runs). Host-side work (context
pack, bundle, node startup) was under 1 s of it. The model takes over 90% of a run, but reviews,
checks and spec checks are short, so this overhead was a large share of them.

**Why.** Three waits ran one after another inside the container:
- OpenCode npm-installed its plugin package (`@opencode-ai/plugin`) into `~/.config/opencode` on its
  first start: `opencode serve` listened at 1.3 s but answered `/session` at 19-22 s. With
  `SERVE_WAIT_S=20`, that was also on the edge of "opencode serve did not start".
- `npm ci` took 22 s of every Lykos run.
- The model list, config and server waited for setup and the red check to finish. Once, the
  `/models` fetch took 8 s from a container, and the same fetch took 0.04-0.1 s later.

**Fixed.**
- The image runs OpenCode once at build time, so the plugin package is already installed. The first
  `/session` now answers at 2.3 s.
- `node_modules` is a volume per project and slot (`NODE_MODULES_CACHE=0`: off). A stamp holds the
  hashes of `package-lock.json` and of npm's own `node_modules/.package-lock.json`, plus the Node and
  npm versions. The install runs only when one of them changed: a Lykos no-agent run went from 29 s
  to 7 s.
- The model list, config and server run in the background during setup and the red check.
- The inputs go into the container as one tar stream (each `podman cp` cost 0.7 s).
- A run's launch runs `gc --yes` on runs/, branches and scratch at most once a day (`AUTO_GC=0`: off).

**Measured.** Old harness (commit 3c1f5d8) against the new one, same ticket, base and model. Each
pair ran at the same time. Every run passed its tests. One run per side, so the agent and wall
times vary with the model and prove nothing. Time from container start to the first model step:

| Ticket | Old | New |
| --- | --- | --- |
| Lykos t207 (gemini-3.8-flash-tiered) | 45.3 s | 20.5 s |
| RakunLoots p9-108 (deepseek-flash-max, Gradle, red check) | 58.6 s | 31.1 s |

From launch to the first model step, Lykos t207 took 52.1 s old and 16.1-24.8 s new. RakunLoots
p9-108 took 92.7 s old, which includes a one-time 30 s cache seed, and 38.1 s new. Runs:
`runs/lykos/e2e-{old,new,new2}-t207` and `runs/rakunloots/e2e-{old,new,new2}-p9-108`. The new runs
are recorded as discarded in the ledger.

**Not changed.**
- The npm in the image skips the install scripts of better-sqlite3, node-pty and esbuild ("not yet
  covered by allowScripts"). No container test or agent log shows a missing native binding.
- The step stream loses its last step in about 305 of 477 agent runs. It is recovered from the
  session store every time.
- Rust: the host-side JavaScript is under 1 s per run, so a rewrite would save almost nothing.

## Found in the Lykos P18 grill, 2026-10-28

Found by reading the source and in the P18 councils. All fixed 2026-10-29; `test/p18-gaps.test.mjs`
covers each.

### 10. A dead loop driver stays dead

**Seen.** `lib/loop.mjs` saves `_loops/<name>/state.json` after every step, and `resume()`
(326-398) picks the loop up again. Nothing calls it on its own: when the driver process dies (a
closed terminal, a reboot, a killed shell), the loop waits until someone runs `loop resume`.
`status` lists it, but only when someone asks.

**Fixed** (2026-10-29). A running loop keeps its driver's pid in `state.json` until it stops. `status`
lists a loop whose driver is gone as "its driver died", with the `loop resume` command, also a new loop
that died before its first stop (it was not listed at all). `loop resume` refuses a loop whose driver
still runs. Nothing resumes on its own: a resume spends model calls, so it stays the orchestrator's call.

### 11. The round cap's code default differs from its configured value

**Seen.** `settings()` in `lib/loop.mjs:70` defaults `LOOP_MAX_ROUNDS` to 4. `boxie.conf:59`
sets 5, and the skill and README say 5. With the shipped config the cap is 5; the code default only
applies if the line is removed.

**Fixed** (2026-10-29). The code default is 5, as in `boxie.conf`.

### 12. `council` with no arguments crashes instead of printing usage

**Seen.** `delegate.sh council` (2026-10-28) printed `./delegate.sh: line 1408: $1: unbound variable`.
`cmd_council` reads `local repo="$1"` under `set -u` before any argument check.

**Fixed** (2026-10-29). A command given fewer arguments than its usage line names prints that usage
and exits 2 (`check_args` in `delegate.sh`, counted from the usage text).

### 13. `ask` dies at 300 s while its own timeout is 15 minutes

**Seen.** The Lykos P18 council (2026-10-28): the `advise` member (agentrouter/gpt-6.1-sol, 35 KB
task) failed twice, then the merge failed, each with `fetch failed` / `UND_ERR_HEADERS_TIMEOUT`
(`runs/lykos/_council/p18-council/advise.log`, `p18-council-readers/merge.log`).

**Why.** `lib/ask.mjs:51` sets `AbortSignal.timeout(15 * 60 * 1000)`, but Node's fetch (undici) has
its own `headersTimeout` of 300 s. A model that thinks longer than 5 minutes before sending headers
is cut off, whatever the abort signal says.

**Fixed** (2026-10-29). `lib/ask.mjs` posts with `node:http`, which has no headers timeout; one
15-minute timer covers the call. A dead gateway reads `ask failed (0): ...ECONNREFUSED`. Tested against a
local fake gateway, not against a model thinking past 5 minutes.

### 14. A council whose merge fails leaves no digest, and the members' work looks lost

**Seen.** Same run: both repo-reading members wrote full reports, the merge (Sol) failed, `digest.md`
is empty and the command exits 1. Only one member's report reached the log tail.

**Fixed** (2026-10-29). A failed merge writes `digest.md` with the merger's error and every member's
answer under its file name, unmerged. The command still exits 1.

### 15. The Podman VM dropped during a council launch

**Seen.** 2026-10-28 18:54:35, first P18 council: the DeepSeek member's container lost Podman
(`EOF`, then `connection forcibly closed`), the Gemini member then saw `no image boxie:latest`
(the image existed after a restart), and `podman machine list` showed the VM stopped. The daily
auto-gc ran at the same launch. The maturity journal records a member dying 3 s after the auto-gc on
2026-10-27. The rerun with `AUTO_GC=0` did not crash. Two occurrences, cause unproven.

**Fixed** (2026-10-29), cause still unproven. The daily auto-gc from a launch cleans only runs/,
branches and scratch (`gc --yes --host-only`); the image prune and container removal run only from a
`gc --yes` by hand.

### 16. The DeepSeek merger spends its whole output on reasoning and writes no digest

**Seen.** Lykos P18 decisions council, 2026-10-28 (`runs/lykos/_council/p18-decisions-1/merge.log`):
`ask failed (200)`, `finish_reason: "length"`, `content: ""`, the reasoning cut off mid-sentence. The
merge prompt carried three member reports (about 41 KB). `digest.md` is empty and the command exits 1
(gap 14 again, with a new cause).

**Fixed** (2026-10-29). `ask` retries once with `reasoning_effort: low` and `max_tokens` 32768
(`ASK_RETRY_MAX_TOKENS`) when the answer is empty with `finish_reason: length`, and a failure names
the finish reason and usage. Not yet seen against the DeepSeek merger itself.

### 17. A member whose last message is a question counts as an answer

**Seen.** Same day, two councils: `p18-council/advise-deepseek.md` (180 bytes) and
`p18-decisions-1/advise-gemini.md` (282 bytes) hold only a closing offer ("Do you want the answer
saved...", "Would you like to draft revisions..."). The council logged both as `answered`; the real
report stayed in the run's transcript, not in the member file.

**Fixed** (2026-10-29). A member's answer is its last message when that is at least
`COUNCIL_MIN_ANSWER` (1000) characters; otherwise its longest message, with the last one after it
(`lib/council.mjs`). Still short: one retry, and the longer short answer stands. The member's task also
says its last message is the whole report.

### 18. Repo-reading members cannot read Boxie itself

**Seen.** Same council: Sol and DeepSeek both reported `C:/Workspace/Tools/Boxie/lib/*.mjs` and
`docs/known-gaps.md` absent; only the target repo is mounted. A plan that compares a project with
Boxie cannot have its Boxie claims checked by the council.

**Fixed** (2026-10-29). `council --with-box` puts Boxie's tracked `lib/`, `docs/`, `image/`,
`claude-skill/`, `delegate.sh` and `boxie.conf` at `.boxie-ref/` in each tool member's clone, out of git
(`run --ref DIR`, read-only runs only). Needs the image rebuilt.

### 19. A prompt over 128 KB fails at launch with "Argument list too long"

**Seen.** Lykos P18 decisions council round 4, 2026-10-28: every member exited 126 within 7 s,
`opencode.log`: `/usr/local/bin/run-task.sh: line 222: /usr/bin/timeout: Argument list too long`.
`prompt.md` was 145,896 bytes (the 83 KB task with six `--file`s plus the 59 KB context pack).
`image/run-task.sh:222-223` passes the whole prompt as one argument to `opencode run`; Linux caps a
single argument at 128 KB (MAX_ARG_STRLEN). The council then reported "no council member answered", and
the run's verdict was `error / fix_environment`, which names neither the cause nor the size.

**Fixed** (2026-10-29). `run-task.sh` sends the prompt to `opencode run` on stdin, which OpenCode 1.19.4
reads when stdin is not a terminal (checked in its binary), so no argument limit applies. Needs the image
rebuilt; not yet run live with a prompt over 128 KB.

## Found driving Lykos P7, 2026-10-25 to 2026-10-26

Seen in the orchestrating session; fixed on branch `fix/p7-gaps` (2026-10-29). Unit tests cover each
fix (test/gaps.test.mjs, test/loop.test.mjs, test/p7-shell.test.mjs); none has run live yet.

### 20. A run waiting for a project slot exited silently

**Seen.** T220 and T225 reviews ended in 8 s as "no readable findings" under `PROJECT_SLOTS=1` while
the loop's base suite held the slot.

**Fixed** before this section, in `9ab8ce7` (2026-10-27): `slot_acquire`'s holder list no longer
fails under `pipefail`.

### 21. `loop resume` kept the settings the loop started with

**Seen.** `LOOP_BASE_SUITE=0` in `projects/lykos.env` never reached the resumed T220 loop, which ran
its base suite again and held the only slot.

**Fixed.** A resume reads how steps run (`LOOP_BASE_SUITE`, `BASE_SUITE_CMD`, `LOOP_PARK`,
`LOOP_LIVE_ASK`, `FAIL_REGEX`, `NEIGHBOUR_SOURCES`, `LOOP_NEIGHBOURS`) from the config as it is now. The
loop's caps, reviewers and fresh roles stay as started.

### 22. `--add` text was dropped when the first review approved

**Seen.** T225 and L4: the loop approved after one clean review, and the orchestrator's added notes
never reached a fixer.

**Fixed.** Orchestrator text no fixer has been sent gets one fix round before the loop can approve.
Text unsent at a stop is kept in the state and sent by the resume.

### 23. A review with its findings in prose stopped the loop

**Seen.** T223's DeepSeek review listed six real findings in prose and no `boxie-findings` block,
even after being asked for the block alone.

**Fixed.** After that request fails, `ROLE_transcribe` (a free model) copies the findings out of the
reviewer's message into the block, adding and judging nothing; the loop reruns each reproduction as
usual. `ROLE_transcribe=""` turns it off.

### 24. `clean` removed other sessions' running containers

**Seen.** `delegate.sh clean` during P7 also removed RakunLoots's container.

**Fixed.** `clean [<repo>]` removes stopped containers and running ones whose run is over or whose
launcher is gone. A live run's container and a parked one stay; `--all` removes every one.

### 25. Container memory caps were never checked against the engine's memory

**Seen.** The Podman VM (15.9 GB) died 3 times with Lykos and RakunLoots containers capped at 8g
each.

**Fixed.** A launch waits while the caps of running Boxie containers, plus taken slots not up
yet, plus its own, exceed the engine's memory x `MEMORY_OVERCOMMIT` (1.5; 0: off). One container is
never refused. `doctor` warns when memory, not slots, limits how many run at once.

### 26. No way to stop one run

**Seen.** A leftover base suite held Lykos's only slot for 15 minutes; killing its process by hand
was refused.

**Fixed.** `delegate.sh stop <repo> <run|loop>...` removes the run's container (and `<run>-*`, so a
loop's name stops its rounds and base suite). Its launch ends and frees the slot.

### 27. An approved loop said nothing about what it had not run

**Seen.** Three failures passed the loop and were found only on the host: a tool-risk test (T224),
missing catalog entries (`02f1ace`) and the L4 crash (`eecfebb`). The loop runs at most
`LOOP_NEIGHBOURS` test files next to the change. T226's Windows-only path bug passed in the Linux
container.

**Fixed.** An approve lists `unchecked:` lines: the whole suite did not run on the branch, with the
`delegate.sh check` command that runs it, and on a Windows host that the host's own behaviour is
untested. The orchestrator decides from the change's risk (user, 2026-10-29); nothing runs by itself.

### 28. A container flake counted as a regression

**Seen.** T224's loop ended on `decide` with an ast-grep "regression" that passed on the host.

**Fixed.** A regression in the tests next to the change is run once more; only tests that fail
both times count. A flake is logged (`flaky` in progress.jsonl).

### 29. The spec check is a session of its own

**Seen.** `run` on a task with `issue:` starts a separate read-only spec-check session (DeepSeek, a
few minutes) before the implementer, which then reads the same task, issue and docs again. The Lykos
P18 regrill (2026-10-31) merged the two: the implementer does the check as its first step.

**Open.** Fold the spec check into the implementer: before its first write it must either record
"nothing undecided" or ask through `ask_orchestrator` (BLOCKED for what it cannot decide alone), and
the harness refuses edits until it has. One session instead of two; the forced step keeps the
question from being guessed away. Measure both forms on the same tasks before removing `spec-check`.
