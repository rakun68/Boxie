# agent-box

Runs [OpenCode](https://opencode.ai) workers on a git repo inside disposable Podman or Docker
containers, with models served through OmniRoute. Built for Claude Code to orchestrate: it plans,
writes acceptance tests, runs the gate and merges; workers implement and review.

A worker's report is a claim. agent-box judges each run from the diff, the tests it runs itself and
the files changed, and records every outcome in a ledger.

## Requirements

| | |
| --- | --- |
| bash | Git Bash on Windows; bash 4+ on Linux or macOS |
| Node.js 20.11+ | host-side scripts (`lib/`); tested on 24.11 |
| git, jq, curl | on `PATH` |
| Podman or Docker | the worker containers. Podman is the default |
| OmniRoute | running on the host (default `http://localhost:20128/v1`), with an API key per project |
| `gh` (optional) | only for `issue: N` in a task |
| herdr (optional) | a live tab per run and per loop |

Tested on Windows 10 with Podman 6.1. macOS and Docker Engine on Linux are untested
([platforms](docs/configuration.md#platforms)).

## Install

```bash
git clone https://github.com/nudetiger/agent-box.git
cd agent-box
npm ci                          # one dependency: yaml
podman machine start            # Podman on Windows or macOS; skip on Linux or with Docker
./delegate.sh build             # the base worker image
./delegate.sh doctor            # checks everything; each failure prints its fix
```

## Set up a project

```bash
./delegate.sh setup    /path/to/myrepo         # projects/myrepo.env, .Dockerfile, .context.yaml from its manifests
                                               # fill OMNIROUTE_API_KEY in the .env; never commit it
./delegate.sh build    /path/to/myrepo         # only when setup wrote a Dockerfile (Go, Rust, CMake, JDK, Python)
./delegate.sh baseline /path/to/myrepo         # setup + tests with no agent: the starting state
```

`setup`'s commands are guesses; `baseline` shows whether they work. Settings per project:
[configuration](docs/configuration.md).

## Quick start

1. Write a task file. Frontmatter drives the context pack; the body is the request.

   ```markdown
   ---
   files: [src/parser.ts]
   sealed: [src/parser.accept.test.ts]   # your acceptance test: the worker cannot edit it
   test: "npx tsx --test src/parser.accept.test.ts"
   ---
   Make the parser accept trailing commas. Out of scope: the CLI.
   ```

2. Run a worker. The result comes back as branch `agent/<name>` in your repo.

   ```bash
   ./delegate.sh run /path/to/myrepo task.md --role implement --name parser-commas
   ```

3. Read the last line, not the worker's report: `verdict <v>  flags <F,...>  next <token>`.

4. For a non-trivial change, run the review and fix loop. It reviews once, proves each finding with a
   reproduction, sends the proven ones back to the same worker, and rechecks the fix.

   ```bash
   ./delegate.sh loop /path/to/myrepo parser-commas
   ./delegate.sh loop resume /path/to/myrepo loop-parser-commas --answer "..."   # when it stops for you
   ```

5. Read `git diff <base>..agent/<last>`, rerun your tests, merge, and record the decision:
   `./delegate.sh accept /path/to/myrepo <run> --why "..."`.

## Use from Claude Code

```bash
./delegate.sh install-skill        # writes ~/.claude/skills/agent-box/SKILL.md with this clone's path
```

Then ask Claude Code to "delegate this to agent-box".

## Trust boundary

- **In:** a `git bundle` of one committed revision, the task, a generated context pack, and the
  project's OmniRoute key. No host `.git`, home directory, SSH keys, `gh` token or uncommitted work.
- **Out:** a `git bundle` of the worker's commits, fetched as branch `agent/<name>`, plus logs. No file
  written by the container is ever executed on the host.
- **Container:** non-root `node` user, `--cap-drop ALL`, `no-new-privileges`, `--init`, pid and memory
  limits. Removed after every run.
- **Not covered:** network egress is open (needed for `npm ci`). A hostile model can send out the repo
  source and the OmniRoute key, nothing more. Shared kernel, not a VM.
- **Free models** (`opencode/*`) go to OpenCode's free tier, which may keep prompts for training.

## Documentation

| | |
| --- | --- |
| [docs/configuration.md](docs/configuration.md) | config files, platforms, project settings, concurrency and memory, caches |
| [docs/task-file.md](docs/task-file.md) | the task file, the context pack, sealed files, BLOCKED |
| [docs/commands.md](docs/commands.md) | every command, watching, questions, continue, ticket mode, benchmark |
| [docs/roles.md](docs/roles.md) | roles, models, review mode, budget |
| [docs/review-loop.md](docs/review-loop.md) | the review and fix loop |
| [docs/evidence-and-ledger.md](docs/evidence-and-ledger.md) | flags, verdicts, `next`, the ledger and dashboard |
| [docs/internals.md](docs/internals.md) | inside the container, speed, engine, source files |
| [docs/known-gaps.md](docs/known-gaps.md) | known bugs and gaps, with what fixed them |
| [research/](research/) | the evidence behind the design |
