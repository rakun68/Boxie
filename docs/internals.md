# Internals

Back to the [README](../README.md).

## Inside the container

`image/make-config.mjs` writes the OpenCode config per run:

- **`worker`** agent (edits; sealed globs denied) or **`reviewer`** agent (no edits in the repo;
  scratch files under `/tmp`).
- **`scout`** subagent on Gemini 3.8 Flash: read-only search that every worker may call, so premium
  workers spend their quota on reasoning.
- **Skills**: Ponytail (`ponytail`, `ponytail-review`; baked into the image), the project's own `.claude/skills/` (filtered by `worker_skills` in the context map, so
  skills that interview a human are hidden) plus Boxie's `box-verify` and `box-prove-finding`.
- `reasoning_effort` from the role, as a model option.
- **Context**: each model gets limits, so OpenCode compacts the session at `COMPACT_AT` tokens
  (110000) and prunes old tool output in continued rounds. OpenCode never compacts a model registered
  without `limit.context`. Step latency grows with context: median 4 s a step under 60k tokens, 42 s
  at 120-180k (RakunMiniItems t51, 2026-10-16). `COMPACT_AT=0` turns it off.
- **`api`** (`image/api.mjs`): `api find|show|grep` print signatures from the JVM dependency jars in
  the Gradle and Maven caches, indexed once into the shared `boxie-api-cache` volume. Workers had
  spent 36 of 61 shell calls decompiling jars by hand (t51). The plugin points at it when a worker runs
  javap or unzip on the caches.
- **Self-check** (`SELF_CHECK=1`, off by default): a first round that changed code gets one more turn
  auditing its diff against the task before the harness tests. Off because in 15 Gemini runs it edited
  nothing (13-103 s each) while the reviews still proved the edge cases it lists (2026-10-17).
- **Lessons**: the project's accepted review findings (`lib/examples.mjs --lessons`) go into the
  implementer's context pack. `LESSONS=0` turns them off; `LESSONS_BEFORE` limits them to an earlier time.

**A turn cut off at the output cap** (step reason `length`, Gemini thinking ~30,700 tokens of a ~32k
cap, Lykos T174b) is resumed in the same session up to twice (`CUT_RESUMES`) before the run ends;
`cut_resumes` in the summary counts them.

## Speed

**Speed**: the delay between tool calls is model time (Gemini 3.8 Flash 4.6-10.6 s per step, DeepSeek
Flash 5.4-9.0 s, Composer 2.4 s; 16 Lykos runs, research/findings.md §1), so the harness cuts steps: small named files and sealed
tests are pasted into the pack (8 KB each, 24 KB total), the Ponytail and box-verify rules are in the
preamble instead of loaded as skills, and `gradlew`/`mvnw` are made executable. One task (add a
one-line Javadoc, RakunMiniItems, 2026-10-12, one run each): Gemini before 66 calls / 546 s, after 50
calls / 345 s (Gradle daemon also on); Composer `quick` 19 calls / 77 s. Gemini still explores widely
on trivial tasks: use `quick` for those.

**Measurements** live in [research/findings.md](../research/findings.md), with the method to compare
another harness (Lykos) against this one on the same task files.

## Engine

`BOXIE_ENGINE` in `boxie.conf`: `podman` (default) or `docker`. Build once per engine.
Podman needs user-mode networking (`podman machine set --user-mode-networking`), because OmniRoute
listens on 127.0.0.1 and only gvproxy's host address reaches the host's loopback.

Measured 2026-10-12, one full Lykos suite each, same commit, same machine:

| | Docker 29.6.2 | Podman 6.1.3 |
| --- | --- | --- |
| image | 2.15 GB | 1.55 GB |
| `npm ci` | 27 s | 22 s |
| test suite | 504 s | 653 s |
| Windows-side processes, idle | ~770 MB | ~13 MB |

## Source files

| | |
| --- | --- |
| `delegate.sh` | Host side: pack, bundle in, container lifecycle, bundle out, fetch, report, fanout, review |
| `lib/pack.mjs` | Deterministic context pack (named files pasted, code index of the task's identifiers, red command, scope) |
| `lib/checks.mjs`, `lib/ledger.mjs` | Evidence flags, verdict and `next`; the ledger writer, labels and outcomes |
| `lib/stats.mjs`, `lib/stats/` | Ledger dashboard and TUI |
| `lib/ticket.mjs`, `lib/ticket/` | Ticket mode and its worker prompts (adapted from Matt Pocock's skills, MIT) |
| `lib/bench.mjs`, `bench/` | Benchmark runner and the frozen suites |
| `lib/watch.mjs`, `lib/forward.mjs` | Live feed; review findings into a fix round |
| `lib/doctor.mjs`, `lib/gc.mjs`, `lib/prices.mjs` | `doctor`; `gc`; prices applied to the ledger |
| `image/api.mjs` | `api` in the container: dependency signatures from the build caches |
| `lib/reviewmode.mjs`, `lib/family.mjs` | Who reviews (review mode, roles, axes); the implementer's family never reviews its own code |
| `image/progress.mjs`, `image/plugin.js`, `image/syntax-check.mjs` | Live progress file; syntax check after every edit |
| `image/run-task.sh` | Container side: clone, setup, config, OpenCode, sealed check, tests, bundle |
| `image/make-config.mjs` | Per-run OpenCode config: agents, scout, permissions, skills, effort |
| `image/preamble*.md`, `image/skills/` | Operating conditions and worker skills |
| `boxie.conf` | Engine, roles, review defaults, scout model |
| `projects/*.env` | Per-project key and settings. Git-ignored |
| `projects/*.context.yaml` | Per-project context map |
| `projects/*.Dockerfile` | Per-project image: the toolchain on top of the base (`projects/example.Dockerfile`) |
| `research/` | The research this design rests on |
| `runs/` | Run outputs. Git-ignored |
| `claude-skill/boxie/SKILL.md` | The Claude Code skill: the orchestrator's procedure |

After changing anything under `image/`, run `./delegate.sh build`, then `./delegate.sh build <repo>` for each project with its own Dockerfile. To update OpenCode, change
`OPENCODE_VERSION` in `image/Dockerfile` and rebuild.
