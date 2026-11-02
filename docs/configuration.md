# Configuration

Back to the [README](../README.md).

## Files

| file | in git | what |
| --- | --- | --- |
| `boxie.conf` | yes | engine, roles, review and loop defaults, context and self-check settings |
| `boxie.local.conf` | no | this machine's overrides: `BOXIE_SLOTS`, `BOXIE_ENGINE`, `BOXIE_NS`, `BOXIE_REPOS` |
| `projects/<repo>.env` | no | the project's OmniRoute key and settings; any `boxie.conf` key wins here |
| `projects/<repo>.context.yaml`, `.Dockerfile` | no (only `example.*`) | context map; the project's toolchain image |
| `prices.conf`, `prices.local.conf` | yes / no | USD per 1M tokens per model, for `stats` |

**A second checkout** (a worktree, a test install) sets `BOXIE_NS=<name>` in its
`boxie.local.conf`: its images (`boxie-<name>`), containers, cache volumes and herdr workspace
are then its own, and `clean` and `gc` touch only those.

## Platforms

| | Windows | macOS | Linux |
| --- | --- | --- | --- |
| shell | Git Bash | bash 4+ (`brew install bash`; macOS ships 3.2) | bash |
| Podman | `podman machine`, user-mode networking | `podman machine` | native, rootless |
| Docker | Docker Desktop | Docker Desktop | Docker Engine 20.10+ |
| host address in containers | found through the machine (`host.containers.internal`) | same | `host-gateway` |

Containers reach OmniRoute as `host.docker.internal`. On Linux the host service must listen where a
container can reach it (not only `127.0.0.1`), or set `BOXIE_NETWORK=host` and
`OMNIROUTE_BASE_URL=http://localhost:20128/v1`. `BOXIE_HOST_IP` overrides the address on any
platform. Tested on Windows 10 with Podman 6.1 (2026-10-17); the unit tests and `doctor` also run in
a Linux container. macOS and Docker Engine on Linux are untested.

## Project settings

**Toolchain.** The base image has Node only (plus make, g++, python3 for node-gyp). A project that
needs Go, Rust, CMake or a JDK gets its own image, built on the base (`setup` writes it, or by hand):

```bash
cp projects/example.Dockerfile projects/myrepo.Dockerfile    # uncomment what the project needs
./delegate.sh build /path/to/myrepo                          # builds boxie-myrepo, used for every run
./delegate.sh config /path/to/myrepo                         # image, caches, every setting the .env sets
```

**Settings.** Any `boxie.conf` key can be set in the project's `.env` and wins there. The ones
made for other stacks (examples in `projects/example.env`):

| Key | What it does |
| --- | --- |
| `SETUP_CMD`, `TEST_CMD` | Install and test commands (default `npm ci`, `npm test`) |
| `CACHES` | `name:/path` named volumes kept across runs, e.g. `go:/home/node/go` |
| `CONTAINER_ENV` | Names of `.env` settings passed into the container, e.g. `GOFLAGS` |
| `SYNTAX_<ext>` | Fast check after every edit of a `.<ext>` file, e.g. `SYNTAX_go='gofmt -e {file} >/dev/null'` |
| `FAIL_REGEX` | Failing test names in the test output. Default knows node:test, TAP, Go, cargo, GoogleTest, pytest, Gradle |
| `NEIGHBOUR_SOURCES` | Changed files whose neighbouring tests rerun each review round. Default: JS/TS, Java, Kotlin, Python, Go, Rust, C/C++ |
| `SENSITIVE_EXTRA` | More paths flagged `SENSITIVE` when a worker edits them |
| `BASE_SUITE_CMD` | The base's whole suite, run once per base commit for the loop (default `TEST_CMD`) |
| `ROLE_*`, `REVIEW_MODE`, `REVIEW_ROLES`, `LOOP_*` | Models, reviewers and loop limits for this project only |

`test_file_command` in the context map takes `{files}`, `{tests}` (Gradle `--tests` filters) and
`{dirs}` (the files' directories as `./dir`, for `go test {dirs}`).

**Per project**: any `ROLE_*`, `REVIEW_MODE`, `REVIEW_ROLES`, `SCOUT_MODEL`, `TICKET_ESCALATE_*` or `LOOP_*` line in
`projects/<repo>.env` overrides `boxie.conf` for that project, in `delegate.sh` and in ticket mode
alike. `delegate.sh roles <repo>` prints what is in effect and marks the project's own lines.

## Concurrency and memory

At most `BOXIE_SLOTS` containers run at once (default 4), whatever starts them; the rest wait for a
slot. A project's `PROJECT_SLOTS` caps its own share. `MEMORY` (default `8g`) is each container's
memory cap. A launch also waits while the caps of running Boxie containers, plus taken slots not up
yet, plus its own, exceed the engine's memory x `MEMORY_OVERCOMMIT` (default 1.5; 0 turns the check
off). One container alone always starts. `doctor` warns when memory, not slots, limits how many run.
A review that installs nothing (`REVIEW_SETUP=0`, every advise review) is capped at `REVIEW_MEMORY`
(default `2g`) instead.

## Reviews

| Key | Default | What it does |
| --- | --- | --- |
| `REVIEW_KIND` | `gate` | `gate`: few, proven findings for the loop, one session with reproductions. `advise` (`review --advise`): every useful comment, the diff split into parts reviewed side by side |
| `REVIEW_STEPS` | 90 | Step cap of a gate review's session |
| `REVIEW_SETUP` | 1 | 0 skips `SETUP_CMD` on reviews. A failed setup never stops a review; the reviewer is told dependencies are missing |
| `REVIEW_REPORT_MIN` | 5 | Minutes kept back from `TIMEOUT_MIN` for a review cut at its limit to write the findings it has |
| `REVIEW_PART_STEPS`, `REVIEW_PART_FILES`, `REVIEW_PART_MIN` | 30, 3, 7 | Advise: step cap, files at most and minutes per part. A part cut at its minutes writes the findings it has |
| `REVIEW_FANOUT`, `REVIEW_PARTS_MAX` | 6, 8 | Advise: parts at once, parts at most (`lib/bundle.mjs`, `image/fanout.mjs`) |
| `REVIEW_FILTER`, `REVIEW_FILTER_MIN`, `FILTER_MODEL` | 1, 3, the reviewer's | Advise: one call scores the merged findings against the diff; those under the minimum go to `filtered.json` (`image/filter.mjs`) |
| `OCR_BIN`, `OCR_EFFORT`, `OCR_CONCURRENCY`, `OCR_TIMEOUT_MIN` | `ocr` on PATH, medium, 8, 15 | The `review-both-ocr` role: open-code-review on the host (`lib/ocr.mjs`) |

An advise review uses open-code-review's per-language checklists (`ocr delegate rule`) when its binary
is found, and places each finding on its line from the code it quotes (`image/anchor.mjs`).

## Caches

- The npm cache is a shared named volume (`boxie-npm-cache`); npm checks lockfile integrity hashes.
  Other caches are the project's `CACHES` volumes, shared by every project that names the same one
  (RakunMiniItems: `gradle`, holding the wrapper, dependencies and toolchain JDKs). Each concurrency
  slot mounts its own copy, `boxie-<name><slot>-cache`, seeded once from `boxie-<name>-cache`:
  two containers on one Gradle cache deadlock on its journal lock (RakunMiniItems, 2026-10-15).
  `BOXIE_SLOT_CACHES=0` shares one volume again.
  Java projects: `{tests}` in `test_file_command` expands to `--tests <class>` for each sibling `*Test.java`.
