# Configuration

Back to the [README](../README.md).

## Files

| file | in git | what |
| --- | --- | --- |
| `agent-box.conf` | yes | engine, roles, review and loop defaults, context and self-check settings |
| `agent-box.local.conf` | no | this machine's overrides: `AGENT_BOX_SLOTS`, `AGENT_BOX_ENGINE`, `AGENT_BOX_NS`, `AGENT_BOX_REPOS` |
| `projects/<repo>.env` | no | the project's OmniRoute key and settings; any `agent-box.conf` key wins here |
| `projects/<repo>.context.yaml`, `.Dockerfile` | yes | context map; the project's toolchain image |
| `prices.conf`, `prices.local.conf` | yes / no | USD per 1M tokens per model, for `stats` |

**A second checkout** (a worktree, a test install) sets `AGENT_BOX_NS=<name>` in its
`agent-box.local.conf`: its images (`agent-box-<name>`), containers, cache volumes and herdr workspace
are then its own, and `clean` and `gc` touch only those.

## Platforms

| | Windows | macOS | Linux |
| --- | --- | --- | --- |
| shell | Git Bash | bash 4+ (`brew install bash`; macOS ships 3.2) | bash |
| Podman | `podman machine`, user-mode networking | `podman machine` | native, rootless |
| Docker | Docker Desktop | Docker Desktop | Docker Engine 20.10+ |
| host address in containers | found through the machine (`host.containers.internal`) | same | `host-gateway` |

Containers reach OmniRoute as `host.docker.internal`. On Linux the host service must listen where a
container can reach it (not only `127.0.0.1`), or set `AGENT_BOX_NETWORK=host` and
`OMNIROUTE_BASE_URL=http://localhost:20128/v1`. `AGENT_BOX_HOST_IP` overrides the address on any
platform. Tested on Windows 10 with Podman 6.1 (2026-10-17); the unit tests and `doctor` also run in
a Linux container. macOS and Docker Engine on Linux are untested.

## Project settings

**Toolchain.** The base image has Node only (plus make, g++, python3 for node-gyp). A project that
needs Go, Rust, CMake or a JDK gets its own image, built on the base (`setup` writes it, or by hand):

```bash
cp projects/example.Dockerfile projects/myrepo.Dockerfile    # uncomment what the project needs
./delegate.sh build /path/to/myrepo                          # builds agent-box-myrepo, used for every run
./delegate.sh config /path/to/myrepo                         # image, caches, every setting the .env sets
```

**Settings.** Any `agent-box.conf` key can be set in the project's `.env` and wins there. The ones
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
`projects/<repo>.env` overrides `agent-box.conf` for that project, in `delegate.sh` and in ticket mode
alike. `delegate.sh roles <repo>` prints what is in effect and marks the project's own lines.

## Concurrency and memory

At most `AGENT_BOX_SLOTS` containers run at once (default 4), whatever starts them; the rest wait for a
slot. A project's `PROJECT_SLOTS` caps its own share. `MEMORY` (default `8g`) is each container's
memory cap. A launch also waits while the caps of running agent-box containers, plus taken slots not up
yet, plus its own, exceed the engine's memory x `MEMORY_OVERCOMMIT` (default 1.5; 0 turns the check
off). One container alone always starts. `doctor` warns when memory, not slots, limits how many run.

## Caches

- The npm cache is a shared named volume (`agent-box-npm-cache`); npm checks lockfile integrity hashes.
  Other caches are the project's `CACHES` volumes, shared by every project that names the same one
  (RakunMiniItems: `gradle`, holding the wrapper, dependencies and toolchain JDKs). Each concurrency
  slot mounts its own copy, `agent-box-<name><slot>-cache`, seeded once from `agent-box-<name>-cache`:
  two containers on one Gradle cache deadlock on its journal lock (RakunMiniItems, 2026-10-15).
  `AGENT_BOX_SLOT_CACHES=0` shares one volume again.
  Java projects: `{tests}` in `test_file_command` expands to `--tests <class>` for each sibling `*Test.java`.
