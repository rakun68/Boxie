#!/usr/bin/env bash
# boxie: run an OpenCode worker on a git repo inside a disposable container (Podman by default).
# The repo goes in as a git bundle and comes back as a git bundle. The container never sees the
# host .git, your home directory, or any credential except the project's OmniRoute key.
set -Eeuo pipefail

BOX="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# fanout, review, explore and batch start runs of this script. "$0" is whatever the caller typed: a
# relative "delegate.sh" is not on PATH and fails with "command not found" (bench 2026-10-13).
SELF=(bash "$BOX/delegate.sh")
# Container engine: podman (default) or docker. Set BOXIE_ENGINE in the environment or in boxie.conf.
# boxie.local.conf (not in git) holds this machine's own overrides: slots, namespace, engine.
[ -f "$BOX/boxie.conf" ] && . "$BOX/boxie.conf"
[ -f "$BOX/boxie.local.conf" ] && . "$BOX/boxie.local.conf"
ENGINE="${BOXIE_ENGINE:-podman}"
# lib/phase.mjs (status) and lib/stats/live.mjs read the engine from the environment: an engine set in
# boxie.conf reached neither, and both ran podman.
export BOXIE_ENGINE="$ENGINE"
case "$ENGINE" in docker|podman) ;; *) echo "boxie: unknown engine $ENGINE" >&2; exit 1 ;; esac
# Namespace: a second checkout (a worktree, a test install) sets BOXIE_NS so its images, containers,
# cache volumes and herdr workspace never collide with the first one's. Empty: the plain names.
NS="boxie${BOXIE_NS:+-$BOXIE_NS}"
BASE_IMAGE="$NS:latest"
IMAGE="$BASE_IMAGE"
LABEL="boxie=1"
NS_LABEL="boxie.ns=${BOXIE_NS:-default}"
export BOXIE_NS

die() { echo "boxie: $*" >&2; exit 1; }
# The engine gets container paths verbatim; Git Bash would otherwise rewrite /in/... into C:/...
dk() { MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL="*" "$ENGINE" "$@"; }
cname_of() { echo "$NS-$PROJECT-${1//[^a-zA-Z0-9_.-]/-}"; }
# The engine answers, or the run stops with its own message. A stopped Podman machine otherwise read as
# "ended with no summary" 9 ms after a loop resume (Lykos L212, 2026-10-20).
engine_up() {
  local err
  err="$(dk info 2>&1 >/dev/null)" && return 0
  die "container engine $ENGINE is not reachable: $(printf '%s' "$err" | tr -d '\r' | tail -n 3 | tr '\n' ' ')$([ "$ENGINE" = podman ] && echo "(podman machine start?)")"
}
# The terminal's width for the feeds, or nothing: with no controlling terminal, opening /dev/tty
# printed "No such device or address" on every watch (RakunLoots P9, plain-pipe shells).
term_cols() { { stty size </dev/tty | cut -d' ' -f2; } 2>/dev/null || true; }
winpath() { if command -v cygpath >/dev/null; then cygpath -w "$1"; else echo "$1"; fi; }

usage() {
  cat <<'EOF'
Usage: delegate.sh <command> ...

  build    [<repo>]              Build the base worker image; with <repo>, also the project's own image
                                 from projects/<repo>.Dockerfile (its toolchain, FROM boxie:latest)
  models   <repo>                List models the project's OmniRoute key can use
  baseline <repo>                Clone + setup + tests in the container, no agent
  run      <repo> <task.md> [--role R[@EFFORT] | --model M] [--effort LEVEL] [--review] [--name N] [--base REF]
                            [--timeout MIN] [--variant V] [--web] [--test CMD]
                                 Run one task. Result lands as branch agent/<name> in <repo>.
                                 --effort none|low|medium|high|xhigh|max (or role@LEVEL; fanout, review,
                                 loop, explore, ask and council take it too): checked against OmniRoute,
                                 it may change the model id (deepseek-flash-max) or refuse (antigravity Claude).
                                 --role picks the model from boxie.conf. --review (or a read-only
                                 role) discards every edit and skips tests; the output is the report.
  continue <repo> <run-name> (-m TEXT | -f FILE) [--name N] [--timeout MIN] [--steps N] [--at BRANCH (review runs)]
                            [--reseal COMMIT] [--seal GLOB ...]
                                 Resume that run's worker session with a follow-up (answer to its
                                 BLOCKED question, review findings, next step). Same model, sealed
                                 files and test; starts on its branch. Result: agent/<run>-r2, -r3...
                                 --reseal: start from COMMIT (your corrected sealed test on top of the
                                 run's head) in the same session; --seal adds sealed globs
  watch    <repo> <run-name>     Live feed of a running worker: harness steps, tool calls, messages.
                                 With herdr running, every run opens one automatically in a tab of
                                 the "boxie" workspace (BOXIE_HERDR=0 turns that off)
  questions <repo> <run-name> [--wait]
                                 Open ask_orchestrator questions of a running worker. --wait blocks
                                 until one appears (exit 0) or the run ends (exit 1)
  wait     <repo> <name>... [--any] [--questions] [--timeout MIN]
                                 Block until these runs or loops end, then print each one's short report.
                                 Run it in the background: one notice instead of polling. --any: return at
                                 the first; --questions: also return when a worker asks
  answer   <repo> <run-name> <id> (-m TEXT | -f FILE)
                                 Answer a running worker's question; it continues where it stopped
                                 (run --no-ask: the worker gets no ask_orchestrator tool)
  fanout   <repo> <task.md> --roles a,b[,c] [--name N] [--score CMD] [run options]
                                 Same task on several roles in parallel; prints a comparison table.
                                 --score: CMD run on every result branch in a container (exit 0 = pass)
  review   <repo> <branch> [--spec FILE ...] [--review-mode split|both | --roles a,b] [--against REF] [--focus TEXT]
                            [--effort LEVEL] [--paths "a b"]
                                 Read-only review, every reviewer given the branch's task and every --spec.
                                 Review mode (REVIEW_MODE, per project): split = two reviewers in parallel,
                                 review-spec and review-std; both = one review-both covering both axes.
                                 --roles names the reviewers outright (one axis: --roles review-spec).
                                 --name P names the runs P-<role>; --prior spec=FILE|std=FILE|both=FILE
                                 puts the previous round's findings first, to recheck
                                 --advise (REVIEW_KIND=advise): every useful comment, not only proven
                                 blockers; the diff split into parts reviewed side by side in one
                                 container, no setup. --roles review-both-ocr runs open-code-review on
                                 the host instead (lib/ocr.mjs). Exits 3 when a reviewer did not finish
  loop    <repo> <run> [--spec FILE ...] [--name N] [--max-rounds N] [--reviews RV1,RV2] [--no-spec] [--add FILE]
                        [--review-mode split|both] [--roles a,b] [--fresh ROLES|none] [--max-fixes N] [--effort LEVEL]
                                 Review, rerun each finding's reproduction and the tests next to the
                                 change, fix what is proven, review the fix, until nothing blocks.
                                 Stuck findings, regressions, serious findings after 3 fix rounds or
                                 a failing fix move the work up implement -> implement-hard -> escalate.
                                 Prints a short summary (open items, spec questions, triage items with
                                 their text), ending in next: approve, answer_spec, triage,
                                 answer_question, decide, or the run's own. --json: the whole result
  loop resume <repo> <loop> [--answer TEXT|@FILE] [--drop ID,ID] [--retire ID,ID] [--add FILE] [-m TEXT|@FILE]
                        [--max-rounds N] [--review-mode split|both] [--roles a,b] [--fresh ROLES|none] [--max-fixes N]
                                 Your decisions on a stopped loop, then it goes on with a fix round.
                                 --drop: a false positive (labelled so); --retire: out of the loop, no
                                 label. --add: markdown for the fixer, or a JSON findings array whose
                                 items with a reproduction become proven open items
                                 --max-rounds raises the cap of a loop stopped at it; a new review mode
                                 or roles start the next review cold with those reviewers. --fresh: the
                                 roles of the fresh attempts on a stall (one role: a single implementer;
                                 none: a stall stops for you)
  loop-watch <repo> <loop>       Live view of a loop: rounds, the running step and its time, each
                                 finding and where it went, decisions, what to do when it stops.
                                 With herdr running, the loop opens it in a tab of its own
  ask     <repo> [--role advise|advise-alt | --model M] [--effort LEVEL] [--prompt FILE] [--file CTX ...]
                                 One-pass advisor (debate/critique), no tools; prompt from FILE or stdin.
                                 advise is Sol 6.1 (cx/; the Responses API when chat completions refuse)
  council  <repo> --prompt FILE [--file CTX ...] [--members a,b,c] [--effort LEVEL] [--name N] [--merge R]
                        [--with-box]
                                 COUNCIL's advisors in parallel (Sol, Gemini and DeepSeek: read-only
                                 runs that check the repo), merged into one digest: agreed,
                                 unique, contradicting, each item tagged. runs/<p>/_council/<name>/
                                 --merge: the merger, a role (merge, advise@high) or an OmniRoute
                                 model id; default COUNCIL_MERGE. A failed merge leaves the answers
                                 unmerged in digest.md. --with-box: Boxie's own source at .boxie-ref/
                                 in each member's clone, to check claims about Boxie
  phase-review <repo> --base REF [--head REF] [--name N] [--spec FILE ...] [--max-rounds N] [--roles a,b,c]
                                 The whole phase diff, split into areas under REVIEW_DIFF_MAX, one family
                                 per round (PHASE_REVIEW_ROLES, rotating) until two rounds in a row from
                                 different families find nothing medium+ on the same head. Exit 3: findings
  phase-close <repo> --base REF [--head REF] [--name N] [--issues 12,13]
                                 The phase checklist: phase-review clean on this head, clean tree, no
                                 unmerged agent/* branch of the phase, HOST_GATE_CMD green, no loop
                                 waiting, issues closed. Prints ready or the first failing item
  status   <repo>                Unfinished runs, loops waiting on you, open phase reviews, each with
                                 its next command
  show     <repo> <name> [--full] A finished run in a few lines again; --full: summary, test tail, final message
  hunt     <repo> <bug.md> [--base REF] [--name N]
                                 A reported bug with no known location: bughunt (Gemini Flash high)
                                 reproduces it, locates it and commits a failing test, checked red
                                 by the harness. Prints JSON with fix_task: run it with --role implement
                                 --base agent/<hunt run>
  roles    <repo>                The roles in effect for the project: boxie.conf, overridden by
                                 any ROLE_*, REVIEW_MODE, REVIEW_ROLES, SCOUT_MODEL, LOOP_MAX_ROUNDS or
                                 TICKET_ESCALATE_* line in its projects/<repo>.env
  config   <repo>                The project's image, caches and every setting its .env sets
  setup    <repo> [--dry-run] [--init-git]
                                 --init-git: a plain folder becomes a git repo with one commit first.
                                 First-time projects/<repo>.env, .Dockerfile and .context.yaml from the
                                 repo's manifests (Node, Go, Rust, CMake, Gradle, Maven, Python); never
                                 overwrites a file
  install-skill [<dir>]          The Claude Code skill, with this clone's path, into ~/.claude/skills/boxie
  doctor   [<repo>]              Check everything boxie needs (bash, node, engine, images, OmniRoute
                                 from the host and from inside a container), each failure with its fix
  gc       [--days N] [--volumes] [--yes]
                                 Disk: model lists and session archives older than N days (14) in runs/,
                                 agent/* branches and worktrees of runs older than N days, scratch and
                                 temp leftovers, untagged images, stopped containers. --volumes: also
                                 the per-slot cache volumes (reseeded on next use). Dry run unless --yes
  bench    list|run ...          Frozen benchmark suites (bench/README.md); BOXIE_REPOS points real-
                                 history tasks at another checkout
  clean    [<repo>] [--all]     Remove leftover containers: stopped, or whose run is over. A live run's and a
                                 parked one are kept (--all: every one, parked included)
  stop     <repo> <run|loop>...  Stop runs now (and <run>-*: a loop's rounds and base suite): container removed
  unpark   <repo> <run>...|--all Remove parked containers of these runs (and <run>-*); the loop does it itself
  spec-check <repo> <task.md|dir> [--role R] [--name N] [--base REF]
                                 A dir: every .md in it checked together, for gaps between tickets too.
                                 Read-only pass (review-spec-alt, DeepSeek) listing what the task leaves
                                 undecided or where it contradicts its docs, before anyone implements it.
                                 `run` folds it into the implementer for a task with `issue:`: edits wait
                                 until it records the check or asks (SPEC_CHECK=session: this session
                                 first, as with --no-ask; SPEC_CHECK=0 or --no-spec-check: off)

Engine: podman (default) or docker, from BOXIE_ENGINE or boxie.conf. Build once per engine.
Parallel: at most BOXIE_SLOTS containers at once (default 4); each slot has its own CACHES volumes.
PROJECT_SLOTS=N in a project's .env caps that project's containers (checks and base suites included).
An npm repo set up by the default `npm ci` keeps node_modules per slot (NODE_MODULES_CACHE=0: off).
A run's launch runs `gc --yes` on runs/, branches and scratch at most once a day (AUTO_GC=0: off). Host scratch lives in runs/.tmp.

<repo> is the repo's path; a bare name works when projects/<name>.env sets REPO_PATH.
Per-project settings: projects/<repo-folder-name-lowercase>.env (see projects/example.env)
EOF
}

# <repo> is the repo's path. A bare name with no such folder is looked up as projects/<name>.env's
# REPO_PATH (Lykos P3, 2026-10-22: `doctor lykos` failed "not a git repo").
repo_path() {
  [ -d "$1" ] && { echo "$1"; return; }
  local env="$BOX/projects/$(tr '[:upper:]' '[:lower:]' <<<"$1").env" p=""
  [ -f "$env" ] && p="$(sed -nE "s/^(export[[:space:]]+)?REPO_PATH=['\"]?([^'\"]*)['\"]?[[:space:]]*$/\2/p" "$env" | tail -n 1)"
  [ -n "$p" ] && [ -d "$p" ] && { echo "$p"; return; }
  die "not a folder: $1 (pass the repo's path, e.g. /c/Workspace/Projects/Lykos; a bare name works when projects/<name>.env sets REPO_PATH)"
}

# Loads projects/<name>.env into this shell. Sets PROJECT and REPO.
load_project() {
  local dir; dir="$(repo_path "$1")" || exit 1
  REPO="$(cd "$dir" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null)" || die "not a git repo: $dir"
  PROJECT="$(basename "$REPO" | tr '[:upper:]' '[:lower:]')"
  local env="$BOX/projects/$PROJECT.env"
  # Benchmark fixture repos share one settings file (projects/bench.env).
  [ -f "$env" ] || [ -z "${BOXIE_PROJECT_ENV:-}" ] || env="$BOXIE_PROJECT_ENV"
  [ -f "$env" ] || die "no project file $env (copy projects/example.env)"
  PROJECT_ENV="$env"
  # A project with its own Dockerfile runs in its own image; IMAGE in the .env file wins over both.
  [ -f "$BOX/projects/$PROJECT.Dockerfile" ] && IMAGE="$NS-$PROJECT:latest"
  set -a; # shellcheck disable=SC1090
  . "$env"; set +a
  OMNIROUTE_BASE_URL="${OMNIROUTE_BASE_URL:-http://host.docker.internal:20128/v1}"
  OMNIROUTE_HOST_URL="${OMNIROUTE_HOST_URL:-http://localhost:20128/v1}"
  TEST_CMD="${TEST_CMD:-npm test}"
  TIMEOUT_MIN="${TIMEOUT_MIN:-60}"
  export OMNIROUTE_BASE_URL TEST_CMD TIMEOUT_MIN
}

# Host scratch files live in runs/.tmp, never in the system temp folder: gc clears it (97 boxie
# files had piled up in the system temp folder, 2026-10-24).
scratch() { mkdir -p "$BOX/runs/.tmp" && mktemp "$BOX/runs/.tmp/$1.XXXXXX"; }

need_key() { [ -n "${OMNIROUTE_API_KEY:-}" ] || die "OMNIROUTE_API_KEY is empty in projects/$PROJECT.env"; }

# MODEL and EFFORT from a role, "role" or "role@effort". The effort (the second argument wins over the
# @ part) goes through lib/effort.mjs: it may change the id (deepseek-flash-high → -max) or refuse.
role_model() {
  local role="${1%%@*}" eff="${2:-}" var
  [[ "$1" == *@* ]] && [ -z "$eff" ] && eff="${1#*@}"
  var="ROLE_${role//-/_}"
  [ -n "${!var:-}" ] || die "unknown role $role (define $var in boxie.conf)"
  read -r MODEL EFFORT <<<"${!var}"
  [ -z "$eff" ] || set_effort "$eff"
}
set_effort() {
  local r; r="$(OMNIROUTE_HOST_URL="$OMNIROUTE_HOST_URL" node "$(winpath "$BOX/lib/effort.mjs")" "$MODEL" "$1")" || die "effort $1 refused for $MODEL"
  read -r MODEL EFFORT <<<"$r"
}

cmd_build() {
  dk build -t "$BASE_IMAGE" "$(winpath "$BOX/image")" || return 1
  # A rebuild leaves the previous image untagged; nothing uses it again (245 such images, 7 GB, 2026-10-17).
  dk image prune -f >/dev/null 2>&1 || true
  [ -n "${1:-}" ] || return 0
  load_project "$1"
  local df="$BOX/projects/$PROJECT.Dockerfile"
  [ -f "$df" ] || die "no $df: $PROJECT runs in the base image, nothing more to build"
  # The context is an empty folder holding only the Dockerfile: projects/ has the .env secrets.
  local ctx="$BOX/runs/.build-$PROJECT"
  rm -rf "$ctx"; mkdir -p "$ctx"
  # FROM boxie:latest in a project Dockerfile means this checkout's base image (its namespace).
  sed -E "s#^FROM[[:space:]]+boxie:latest#FROM $BASE_IMAGE#" "$df" >"$ctx/Dockerfile"
  dk build -t "$IMAGE" "$(winpath "$ctx")"; local e=$?
  dk image prune -f >/dev/null 2>&1 || true
  rm -rf "$ctx"; return $e
}

# -v flags for CACHES="name:/container/path ..." in the project's .env: named volumes kept across runs
# (Go modules, cargo registry, Gradle). Each concurrency slot gets its own copy, boxie-<name><slot>-cache:
# two containers on one Gradle cache deadlock on its journal lock ("Timeout waiting to lock journal
# cache", RakunMiniItems 2026-10-15). A slot's volume missing is seeded once from boxie-<name>-cache,
# so it starts warm. BOXIE_SLOT_CACHES=0: every run shares boxie-<name>-cache, as before.
# The npm cache is always mounted and shared (npm's cache is safe to share).
cache_volumes() {
  local c vol base n="${SLOT##*/}"
  CACHE_ARGS=(-v boxie-npm-cache:/home/node/.npm -v "$NS-api-cache:/home/node/.cache/boxie-api")
  for c in ${CACHES:-}; do
    [[ "$c" == ?*:/?* ]] || die "CACHES entry '$c' is not name:/path"
    base="boxie-${c%%:*}-cache"; vol="$NS-${c%%:*}-cache"
    # Another namespace seeds its own volumes from the shared one and never writes to it.
    [ "$vol" = "$base" ] || seed_volume "$base" "$vol"
    if [ -n "$n" ] && [ "${BOXIE_SLOT_CACHES:-1}" != 0 ]; then base="$vol"; vol="$NS-${c%%:*}$n-cache"; seed_volume "$base" "$vol"; fi
    CACHE_ARGS+=(-v "$vol:${c#*:}")
  done
}
# A new slot volume, copied from the shared one when that exists. Gradle's daemon state and journal
# locks are left behind: they belong to processes of the container that wrote them.
seed_volume() {
  dk volume inspect "$2" >/dev/null 2>&1 && return 0
  dk volume create "$2" >/dev/null || die "could not create volume $2"
  dk volume inspect "$1" >/dev/null 2>&1 || return 0
  echo "boxie: seeding cache volume $2 from $1 (once per slot)" >&2
  dk run --rm --entrypoint sh -v "$1:/from:ro" -v "$2:/to" "$IMAGE" \
    -c 'cp -a /from/. /to/ && rm -rf /to/daemon /to/caches/journal-1/*.lock' >/dev/null 2>&1 \
    || echo "boxie: could not seed $2; it starts empty" >&2
}

cmd_models() {
  load_project "$1"; need_key
  curl -fsS -H "Authorization: Bearer $OMNIROUTE_API_KEY" "$OMNIROUTE_HOST_URL/models" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const m of JSON.parse(s).data||[])console.log(m.id)})'
}

# Leftover containers of this namespace: stopped ones, and running ones whose run is over or whose
# launcher is gone. A live run's container and a parked one are kept, so another session's work survives
# (Lykos P7, 2026-10-25: clean removed a RakunLoots container). <repo>: that project only. --all: every
# container and parked marker, as before.
cmd_clean() {
  local all=0 a scoped=0 filt=(--filter "label=$LABEL" --filter "label=$NS_LABEL")
  for a in "$@"; do
    case "$a" in
      --all) all=1 ;;
      -*) die "clean: unknown option $a" ;;
      *) load_project "$a"; scoped=1; filt+=(--filter "label=boxie.project=$PROJECT") ;;
    esac
  done
  local ids; ids="$(dk ps -aq "${filt[@]}")"
  if [ "$all" = 1 ]; then
    if [ "$scoped" = 1 ]; then rm -f "$BOX/runs/$PROJECT"/*/parked; else rm -f "$BOX"/runs/*/*/parked; fi
    [ -z "$ids" ] && { echo "nothing to clean"; return; }
    dk rm -f $ids; return
  fi
  [ -z "$ids" ] && { echo "nothing to clean"; return; }
  local id c pr running dir rm=() kept=()
  while IFS='|' read -r id c pr running; do
    c="${c#/}"; dir="$(clean_run_dir "$c" "$pr")"
    if [ "$running" = true ] && [ -n "$dir" ] && { [ -f "$dir/parked" ] || ! run_over "$dir"; }; then kept+=("$c"); else rm+=("$id"); fi
  done < <(dk inspect -f '{{.Id}}|{{.Name}}|{{index .Config.Labels "boxie.project"}}|{{.State.Running}}' $ids)
  [ "${#rm[@]}" = 0 ] || dk rm -f "${rm[@]}"
  [ "${#kept[@]}" = 0 ] || echo "boxie: kept ${#kept[@]} running (a live run or parked): ${kept[*]}. stop <repo> <run> or unpark removes one, clean --all every one"
  [ "${#rm[@]}" != 0 ] || [ "${#kept[@]}" != 0 ] || echo "nothing to clean"
}
# The run directory of container <name> of project <pr>, or nothing. cname_of may have replaced
# characters of the run name, so a miss looks through the project's runs.
clean_run_dir() {
  local c="$1" pr="$2" d n
  [ -n "$pr" ] || return 0
  d="$BOX/runs/$pr/${c#"$NS-$pr-"}"
  [ -d "$d" ] && { echo "$d"; return 0; }
  for d in "$BOX/runs/$pr"/*/; do
    d="${d%/}"; n="${d##*/}"
    [ "$NS-$pr-${n//[^a-zA-Z0-9_.-]/-}" = "$c" ] && { echo "$d"; return 0; }
  done
  return 0
}

# Stops runs: each one's container is removed, so its launch ends (slot freed, <run>/ended written) and a
# loop driving it stops at that step. <run> also matches <run>-*, so a loop's name stops its rounds and
# its base suite. Lykos P7 (2026-10-25): a leftover base suite held the project's only slot for 15 min,
# and killing its process by hand was refused.
cmd_stop() {
  [ $# -ge 2 ] || die "usage: stop <repo> <run|loop>..."
  load_project "$1"; shift
  local d n p c hit=0
  for d in "$BOX/runs/$PROJECT"/*/; do
    d="${d%/}"; n="${d##*/}"
    for p in "$@"; do
      [ "$n" = "$p" ] || [[ "$n" == "$p"-* ]] || continue
      c="$(cname_of "$n")"
      if dk inspect "$c" >/dev/null 2>&1; then dk rm -f "$c" >/dev/null 2>&1 || true; rm -f "$d/parked"; echo "boxie: stopped $n"; hit=1; fi
      break
    done
  done
  [ "$hit" = 1 ] || echo "boxie: no container of $PROJECT matches $*"
}

# Removes parked containers (see launch): those of the named runs and of runs named <name>-*, or every
# one of the project with --all. The review loop unparks its own when it ends.
cmd_unpark() {
  load_project "$1"; shift
  local f d n c p hit
  for f in "$BOX/runs/$PROJECT"/*/parked; do
    [ -f "$f" ] || continue
    d="${f%/parked}"; n="${d##*/}"; hit=0
    for p in "$@"; do [ "$p" = --all ] || [ "$n" = "$p" ] || [[ "$n" == "$p"-* ]] && hit=1; done
    [ "$hit" = 1 ] || continue
    read -r c _ <"$f"; dk rm -f "$c" >/dev/null 2>&1 || true; rm -f "$f"
    echo "boxie: unparked $n"
  done
}

# A finished run in a few lines (lib/brief.mjs). --full, or BOXIE_FULL=1: the whole report, with the
# final agent message and token totals from OpenCode's JSON event stream.
report() {
  local dir="$1"
  if [ "${2:-}" != --full ] && [ "${BOXIE_FULL:-0}" != 1 ]; then
    (cd "$BOX" && node lib/brief.mjs "$(winpath "$dir")"); return 0
  fi
  [ -f "$dir/verdict.txt" ] && { echo "== verdict"; cat "$dir/verdict.txt"; }
  echo "== summary"; cat "$dir/summary.json" 2>/dev/null || echo "(no summary.json, see harness.log)"
  [ -f "$dir/commits.txt" ] && { echo "== commits"; cat "$dir/commits.txt"; }
  [ -f "$dir/diffstat.txt" ] && { echo "== diffstat"; tail -n 1 "$dir/diffstat.txt"; }
  echo "== test tail"; tail -n 15 "$dir/test.log" 2>/dev/null || echo "(no test.log)"
  if [ -s "$dir/events.jsonl" ]; then
    node - "$(winpath "$dir/events.jsonl")" <<'EOF'
const lines = require("fs").readFileSync(process.argv[2], "utf8").split("\n").filter(Boolean);
let last = "", tools = 0, tok = { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 }, errors = [];
for (const l of lines) {
  let e; try { e = JSON.parse(l); } catch { continue; }
  const p = e.part || {};
  if (e.type === "text" && p.text) last = p.text;
  if (e.type === "tool_use") tools++;
  if (e.type === "error") errors.push(JSON.stringify(e.error || e).slice(0, 300));
  const t = p.tokens;
  if (e.type === "step_finish" && t) {
    tok.input += t.input || 0; tok.output += t.output || 0; tok.reasoning += t.reasoning || 0;
    tok.cache_read += (t.cache && t.cache.read) || 0; tok.cache_write += (t.cache && t.cache.write) || 0;
  }
}
console.log("== agent (" + lines.length + " events, " + tools + " tool calls, tokens " + JSON.stringify(tok) + ")");
for (const e of errors) console.log("ERROR " + e);
console.log(last || "(no final text message)");
EOF
  fi
}

cmd_show() {
  load_project "$1"
  report "$BOX/runs/$PROJECT/$2" "${3:-}"
}

# Shared by run and baseline.
# `gc --yes` at most once a day, in the background, from a run's launch (runs/ had grown to 1.4 GB,
# 2026-10-23; gc was manual). Its report is runs/.gc.log. AUTO_GC=0 turns it off.
# Host side only: the engine part (image prune, container removal) ran while a council started its
# members, and twice the Podman VM dropped with it (2026-10-27, Lykos P18 2026-10-28). `gc --yes` by hand
# still does it.
auto_gc() {
  [ "${AUTO_GC:-1}" != 0 ] || return 0
  local stamp="$BOX/runs/.gc-last"
  [ -n "$(find "$stamp" -mmin -1440 2>/dev/null)" ] && return 0
  mkdir -p "$BOX/runs"; touch "$stamp"
  echo "boxie: daily cleanup in the background (runs/, branches, scratch; AUTO_GC=0 turns it off): runs/.gc.log" >&2
  (cmd_gc --yes --host-only >"$BOX/runs/.gc.log" 2>&1 &)
}

# runs/, branches, worktrees and scratch (lib/gc.mjs), then the engine: untagged images left by rebuilds,
# this namespace's stopped containers (parked ones keep running) and, with --volumes, its per-slot cache
# volumes (9.6 GB of the 16.6 GB of volumes, 2026-10-24; a slot's volume is seeded again when next used).
cmd_gc() {
  local a yes=0 vols=0 host=0 rest=()
  for a in "$@"; do case "$a" in --yes) yes=1; rest+=("$a") ;; --volumes) vols=1 ;; --host-only) host=1 ;; *) rest+=("$a") ;; esac; done
  node "$(winpath "$BOX/lib/gc.mjs")" "$(winpath "$BOX/runs")" "${rest[@]}"
  [ "$host" = 0 ] || return 0
  local ids slotvols=""
  # A slot's copy is <base><slot>-cache next to <base>-cache (m21 beside m2), or a node_modules one (-nm<slot>-).
  [ "$vols" = 1 ] && slotvols="$(all="$(dk volume ls -q 2>/dev/null)"; for v in $(grep -E "^$NS-.+[0-9]-cache\$" <<<"$all"); do
    { [[ "$v" == *-nm[0-9]-cache ]] || grep -qx "${v%?-cache}-cache" <<<"$all"; } || continue
    dk ps -q --filter "volume=$v" | grep -q . || echo "$v"; done)"
  if [ "$yes" = 1 ]; then
    dk image prune -f >/dev/null 2>&1 && echo "untagged images pruned"
    ids="$(dk ps -aq --filter "label=$NS_LABEL" --filter status=exited)"; [ -z "$ids" ] || { dk rm -f $ids >/dev/null; echo "stopped containers removed"; }
    [ -z "$slotvols" ] || { dk volume rm $slotvols >/dev/null && echo "slot cache volumes removed: $(echo $slotvols)"; }
  else
    echo "and with --yes: untagged images ($(dk images -f dangling=true -q 2>/dev/null | wc -l | tr -d ' ') now), stopped containers ($(dk ps -aq --filter "label=$NS_LABEL" --filter status=exited 2>/dev/null | wc -l | tr -d ' ') now)"
    [ -z "$slotvols" ] || echo "and slot cache volumes: $(echo $slotvols)"
  fi
}

launch() {
  local name="$1" task="$2" base="$3" skip_agent="$4"
  # set -e ends a launch on any failing command without a word: a council member died 3 s after the
  # daily gc started, with nothing in its log (2026-10-27): slot_acquire, below. Name the line instead.
  # Not in subshells: a failing command there is handled by its caller (compgen with no match).
  trap '[ "$BASH_SUBSHELL" != 0 ] || echo "boxie: launch stopped at delegate.sh:$LINENO: $BASH_COMMAND (exit $?)" >&2' ERR
  local run_dir="$BOX/runs/$PROJECT/$name" branch="agent/$name"
  [ -e "$run_dir" ] && die "run $name already exists"
  git -C "$REPO" show-ref --verify --quiet "refs/heads/$branch" && die "branch $branch already exists in $REPO"
  engine_up
  auto_gc
  mkdir -p "$run_dir"
  # gc prunes this project's old agent/* branches in this repo.
  winpath "$REPO" >"$BOX/runs/$PROJECT/.repo"
  # `wait` and `watch` know the run is over by <run>/ended, written however launch exits; launcher.pid
  # covers a launcher killed outright. A run stopped before its summary never woke `wait` (RakunLoots
  # baseline, 2026-10-21: run-task exited 137, the wait ran to its timeout).
  echo "$$" >"$run_dir/launcher.pid"
  trap "date +%s >'$run_dir/ended'" EXIT

  local base_sha; base_sha="$(git -C "$REPO" rev-parse --verify "$base^{commit}")" || die "bad base $base"
  # A continued round starts on its previous head but keeps the first round's base (ORIG_BASE).
  local start_sha="$base_sha"; [ -n "${ORIG_BASE:-}" ] && base_sha="$ORIG_BASE"
  [ -n "$(git -C "$REPO" status --porcelain)" ] && echo "boxie: note: uncommitted changes in $REPO are NOT sent; base is $base_sha" >&2
  local bundle_ref="$base" tmp_ref=""
  # Only a local branch bundles as itself: a clone of a bundle takes refs/heads, so origin/main or a tag
  # gave an empty clone and a checkout failure (exit 11).
  if [ "$base" != "HEAD" ] && ! git -C "$REPO" show-ref --quiet --verify "refs/heads/${base#refs/heads/}"; then
    # A bare commit (a sha, HEAD~2): bundled through a temporary branch (a clone of a bundle takes refs/heads only). Bundling HEAD instead lost a base
    # that HEAD does not contain ("reference is not a tree", Lykos peak-wrap, 2026-10-17).
    if git -C "$REPO" merge-base --is-ancestor "$start_sha" HEAD 2>/dev/null; then bundle_ref="HEAD"
    else tmp_ref="refs/heads/boxie-tmp/base-$name"; git -C "$REPO" update-ref "$tmp_ref" "$start_sha"; bundle_ref="$tmp_ref"; fi
  fi
  git -C "$REPO" bundle create -q "$(winpath "$run_dir/in.bundle")" "$bundle_ref" 2>/dev/null \
    || git -C "$REPO" bundle create -q "$(winpath "$run_dir/in.bundle")" --all
  [ -n "$tmp_ref" ] && git -C "$REPO" update-ref -d "$tmp_ref"
  if [ -n "${CONTINUE_SESSION:-}" ]; then
    # Follow-up: no new pack. The worker already has it in its session; the message is the task.
    cp "$task" "$run_dir/message.md"
    cp "$CONTINUE_FROM/task-body.md" "$run_dir/task-body.md" 2>/dev/null || true
    cp "$CONTINUE_FROM/task.md" "$run_dir/task.md" 2>/dev/null || true
    cp "$CONTINUE_FROM/pack.json" "$run_dir/pack.json" 2>/dev/null || true
  elif [ -n "$task" ]; then
    cp "$task" "$run_dir/task.md"
    # Deterministic context pack: files, areas, governing docs, traps, terms, tests, sealed globs.
    local map="$BOX/projects/$PROJECT.context.yaml" map_arg="-"
    [ -f "$map" ] && map_arg="$(winpath "$map")"
    local meta; meta="$(node "$(winpath "$BOX/lib/pack.mjs")" "$(winpath "$REPO")" "$(winpath "$task")" \
      "$map_arg" "$(winpath "$run_dir")" "$base_sha")" || die "context pack failed"
    printf '%s\n' "$meta" >"$run_dir/pack.json"
    SEALED="$(node -e 'console.log(JSON.parse(process.argv[1]).sealed.join("\n"))' "$meta")"
    local pack_test; pack_test="$(node -e 'console.log(JSON.parse(process.argv[1]).test)' "$meta")"
    if [ -z "${TEST_FROM_FLAG:-}" ] && [ -n "$pack_test" ]; then TEST_CMD="$pack_test"; fi
    node -e 'for (const w of JSON.parse(process.argv[1]).warnings) console.error("boxie: pack: " + w)' "$meta"
    SKILLS_ALLOW="$(node -e 'console.log(JSON.parse(process.argv[1]).skills.join(","))' "$meta")"
    # Red check (sealed tests must fail on the base) and the step budget, from the task frontmatter.
    [ "${NO_RED:-0}" = 1 ] || RED_CMD="$(node -e 'console.log(JSON.parse(process.argv[1]).red || "")' "$meta")"
    [ -n "${STEPS:-}" ] || STEPS="$(node -e 'console.log(JSON.parse(process.argv[1]).steps || "")' "$meta")"
    export SEALED TEST_CMD SKILLS_ALLOW RED_CMD STEPS
    # What reviews of this project kept finding (lib/examples.mjs --lessons), for implementers only.
    # LESSONS=0 turns it off; LESSONS_BEFORE (ISO time) keeps a benchmark replay from its own findings.
    if [ "${REVIEW:-0}" != 1 ] && [ "${LESSONS:-1}" != 0 ]; then
      (cd "$BOX" && node lib/examples.mjs "$PROJECT" --lessons) >>"$run_dir/context.md" 2>/dev/null || true
    fi
  fi
  # Everything `continue` needs to resume this run with the same model, rules and checks. SKIP_AGENT
  # first: the ledger reads a baseline from it (it was empty here, so every baseline's verdict was error).
  SKIP_AGENT="$skip_agent"
  local v; for v in MODEL EFFORT VARIANT ALLOW_WEB REVIEW SCOUT_MODEL TEST_CMD SEALED SKILLS_ALLOW TIMEOUT_MIN ASK ROLE STEPS AUTOFIX SKIP_AGENT REVIEW_TARGET PREAMBLE; do
    printf '%s=%q\n' "$v" "${!v:-}"
  done >"$run_dir/meta.sh"
  printf 'RUN_BASE_SHA=%q\nRUN_BASE_REF=%q\nRUN_ROUND=%q\n' "$base_sha" "$bundle_ref" "${ROUND:-1}" >>"$run_dir/meta.sh"

  dk image inspect "$IMAGE" >/dev/null 2>&1 \
    || die "no image $IMAGE: run delegate.sh build$([ "$IMAGE" = "$BASE_IMAGE" ] || echo " $REPO")"
  # Into the container as well: the project's SYNTAX_<ext> checks and the names in CONTAINER_ENV.
  local v extra_env=()
  for v in $(compgen -v SYNTAX_) ${CONTAINER_ENV:-}; do export "${v?}"; extra_env+=(-e "$v"); done
  local cname; cname="$(cname_of "$name")"
  # A parked container still mounts its slot's cache volumes: its next round waits for that same slot,
  # so no other container uses those volumes at the same time.
  local want_slot=""
  [ -n "${CONTINUE_SESSION:-}" ] && [ -f "$CONTINUE_FROM/parked" ] && read -r _ _ want_slot <"$CONTINUE_FROM/parked"
  # A parked container's next round runs in it: its memory is already counted.
  if [ -n "$want_slot" ]; then slot_acquire "$name" "$want_slot" 0; else slot_acquire "$name" ""; fi
  # Parking (BOXIE_PARK=1, set by the review loop): a finished worker's container stays up, marked
  # by <run>/parked, so `continue` on its session runs the next round in it: no new container, clone,
  # setup or session restore (40-90 s a round on RakunMiniItems). A parked container holds no slot;
  # `unpark` or `clean` removes it, and a continue that cannot use it starts fresh as before. It mounts
  # its old slot's cache volumes, so it is reused only in that slot; in another one it is removed.
  trap "[ -f '$run_dir/parked' ] || dk rm -f '$cname' >/dev/null 2>&1 || true; slot_release; date +%s >'$run_dir/ended'" EXIT
  trap "exit 130" INT TERM
  local reuse=0 pc pimg
  if [ -n "${CONTINUE_SESSION:-}" ] && [ -f "$CONTINUE_FROM/parked" ]; then
    read -r pc pimg _ <"$CONTINUE_FROM/parked"; rm -f "$CONTINUE_FROM/parked"
    [ "$SLOT_PREFERRED" = 1 ] || echo "boxie: slot $want_slot is busy: $name starts a fresh container in ${SLOT##*/} (session restored from ${CONTINUE_FROM##*/})" >&2
    if [ "$SLOT_PREFERRED" = 1 ] && [ "$pimg" = "$IMAGE" ] && [ "$(dk inspect -f '{{.State.Running}}' "$pc" 2>/dev/null)" = true ] \
       && dk rename "$pc" "$cname" >/dev/null 2>&1 \
       && dk exec "$cname" sh -c 'rm -rf /out/* /out/.[!.]* /in/* 2>/dev/null; mkdir -p /in/answers'; then
      reuse=1
    else
      dk rm -f "$pc" >/dev/null 2>&1 || true
    fi
  fi
  cache_volumes
  # node_modules kept per project and slot, for a repo set up by the default `npm ci` (run-task.sh
  # skips the install while the tree matches package-lock.json). NODE_MODULES_CACHE=0 turns it off.
  if [ "${NODE_MODULES_CACHE:-1}" != 0 ] && [ -z "${SETUP_CMD:-}" ] && [ -n "$SLOT" ] \
     && git -C "$REPO" cat-file -e "$start_sha:package-lock.json" 2>/dev/null; then
    CACHE_ARGS+=(-v "$NS-$PROJECT-nm${SLOT##*/}-cache:/work/repo/node_modules")
  fi
  # The real OpenCode TUI attaches to the worker when herdr shows the run (BOXIE_TUI=0: feed only).
  TUI=0
  if [ "$skip_agent" != 1 ] && [ "${BOXIE_TUI:-1}" != 0 ] && herdr_ok; then TUI=1; fi
  export TUI ROLE="${ROLE:-}" AUTOFIX="${AUTOFIX:-1}" HIDDEN="${HIDDEN_DIR:+1}" PREAMBLE="${PREAMBLE:-}"
  # Context management (image/make-config.mjs) and the self-check turn (run-task.sh), from the conf files.
  export COMPACT_AT="${COMPACT_AT:-}" COMPACT_KEEP="${COMPACT_KEEP:-}" SELF_CHECK="${SELF_CHECK:-}"
  # The paid model a free opencode/* model hands over to at its limit (image/run-task.sh).
  export FREE_FALLBACK="${FREE_FALLBACK:-}"
  # The model that copies a reviewer's prose findings into the block when the reviewer will not (run-task.sh 3f).
  local tr="${ROLE_transcribe:-}"; export TRANSCRIBE_MODEL="${tr%% *}"
  local host_ip; host_ip="$(host_address)"
  local net_args=(); [ -n "${BOXIE_NETWORK:-}" ] && net_args=(--network "$BOXIE_NETWORK")
  export BRANCH="$branch" BASE_SHA="$base_sha" START_SHA="$start_sha" SKIP_AGENT="$skip_agent"
  # The run's settings. A new container takes them by name; a reused one keeps its creation-time env,
  # so the round's values go to `exec` explicitly (the OmniRoute key is already in it, never on a command line).
  local envnames=(MODEL VARIANT ALLOW_WEB REVIEW REVIEW_ASK BRANCH BASE_SHA SKIP_AGENT TEST_CMD SETUP_CMD TIMEOUT_MIN SEALED
    EFFORT SCOUT_MODEL SKILLS_ALLOW START_SHA CONTINUE_SESSION ROUND ASK ASK_WAIT_S ASK_TIMEOUT_MIN RED_CMD STEPS AUTOFIX
    AUTOFIX_MIN TUI ROLE HIDDEN PREAMBLE COMPACT_AT COMPACT_KEEP SELF_CHECK SETUP_RETRIES SERVE_WAIT_S SPEC_GATE
    FREE_FALLBACK TRANSCRIBE_MODEL REVIEW_SETUP REVIEW_FANOUT REVIEW_PART_MIN REVIEW_REPORT_MIN REVIEW_FILTER REVIEW_FILTER_MIN FILTER_MODEL)
  local runenv=() execenv=(-e REUSE=1)
  for v in "${envnames[@]}"; do runenv+=(-e "$v"); execenv+=(-e "$v=${!v:-}"); done
  if [ "$reuse" = 1 ]; then
    for v in $(compgen -v SYNTAX_) ${CONTAINER_ENV:-}; do execenv+=(-e "$v=${!v:-}"); done
  else
    dk run -d --init --name "$cname" --label "$LABEL" --label "$NS_LABEL" --label "boxie.project=$PROJECT" \
      --cap-drop ALL --security-opt no-new-privileges --pids-limit 4096 --memory "${MEMORY:-8g}" \
      --add-host "host.docker.internal:$host_ip" "${net_args[@]}" \
      "${CACHE_ARGS[@]}" "${extra_env[@]}" -e OMNIROUTE_API_KEY -e OMNIROUTE_BASE_URL "${runenv[@]}" \
      "$IMAGE" >/dev/null
  fi
  # The inputs go in as one tar stream: each `cp` into the engine's VM cost 0.7 s (podman machine,
  # 2026-10-23), and a run made three or four. The bundle is moved, not copied: nothing reads it after.
  local stage="$run_dir/.in"
  mkdir -p "$stage" && mv "$run_dir/in.bundle" "$stage/repo.bundle"
  [ -n "${HIDDEN_DIR:-}" ] && mkdir -p "$stage/hidden" && cp -r "$HIDDEN_DIR/." "$stage/hidden/"
  [ -n "${REF_DIR:-}" ] && mkdir -p "$stage/ref" && cp -r "$REF_DIR/." "$stage/ref/"
  # An advise review's parts (cmd_review): image/fanout.mjs reads them.
  [ -n "${BUNDLES_FILE:-}" ] && cp "$BUNDLES_FILE" "$stage/bundles.json" && cp "$BUNDLES_FILE" "$run_dir/bundles.json"
  if [ -n "${CONTINUE_SESSION:-}" ]; then
    cp "$run_dir/message.md" "$stage/task.md"
    [ "$reuse" = 1 ] || cp "$CONTINUE_FROM/opencode-data.tgz" "$stage/opencode-data.tgz"
  elif [ -n "$task" ]; then
    cp "$run_dir/task-body.md" "$stage/task.md"
    cp "$run_dir/context.md" "$stage/context.md"
  fi
  tar -C "$stage" -cf - . | dk exec -i "$cname" tar -xf - -C /in || die "could not copy the inputs into $cname"
  rm -rf "$stage"

  [ "$skip_agent" = 1 ] || herdr_open "$name"
  echo "boxie: $name started ($ENGINE container $cname$([ "$reuse" = 1 ] && echo ", reused from ${CONTINUE_FROM##*/}"), base ${base_sha:0:10}, model ${MODEL:-none})" >&2
  if [ "$reuse" = 1 ]; then dk exec "${execenv[@]}" "$cname" /usr/local/bin/run-task.sh || echo "boxie: run-task exited $?" >&2
  else dk exec "$cname" /usr/local/bin/run-task.sh || echo "boxie: run-task exited $?" >&2; fi
  dk cp "$cname:/out/." "$(winpath "$run_dir")" || echo "boxie: could not copy /out" >&2
  rm -f "$run_dir/in.bundle"
  if [ "${BOXIE_PARK:-0}" = 1 ] && [ "$skip_agent" != 1 ] && [ -f "$run_dir/summary.json" ] && [ -n "$(jq -r '.session // empty' "$run_dir/summary.json" 2>/dev/null)" ]; then
    # Build daemons hold the cache volume's locks while idle: a parked Gradle daemon made the next run on
    # the slot fail with "Timeout waiting to lock journal cache" (RakunMiniItems #50 check, 2026-10-17).
    # Bracketed patterns: a plain one matches this sh -c's own command line and kills it first.
    dk exec "$cname" sh -c 'pkill -f "[G]radleDaemon"; pkill -f "[K]otlinCompileDaemon"; true' >/dev/null 2>&1 || true
    printf '%s %s %s\n' "$cname" "$IMAGE" "${SLOT##*/}" >"$run_dir/parked"
    echo "boxie: $name parked (container $cname kept for the next round; delegate.sh unpark)" >&2
  fi

  if [ -f "$run_dir/result.bundle" ]; then
    git -C "$REPO" fetch -q "$(winpath "$run_dir/result.bundle")" "refs/heads/$branch:refs/heads/$branch" \
      && echo "boxie: fetched into $REPO as branch $branch" >&2 \
      && node "$(winpath "$BOX/lib/own.mjs")" "$(winpath "$REPO")" "$base_sha" "$branch" "$(winpath "$run_dir")"
  fi
  slot_release
  # Checks, verdict, next action and the ledger entry (lib/ledger.mjs, docs/ledger.md).
  if [ -f "$run_dir/summary.json" ] && [ "${LEDGER_SKIP:-0}" != 1 ]; then
    local lopts=()
    [ -n "${LEDGER_MODE:-}" ] && lopts+=(--mode "$LEDGER_MODE")
    [ -n "${LEDGER_PARENT:-}" ] && lopts+=(--parent "$LEDGER_PARENT")
    [ -n "${LEDGER_BENCH:-}" ] && lopts+=(--bench "$LEDGER_BENCH")
    [ -n "${LEDGER_FEATURE:-}" ] && lopts+=(--feature "$LEDGER_FEATURE")
    [ -n "${LEDGER_TICKET:-}" ] && lopts+=(--ticket "$LEDGER_TICKET")
    [ -n "${REVIEW_TARGET:-}" ] && lopts+=(--target "$REVIEW_TARGET")
    node "$(winpath "$BOX/lib/ledger.mjs")" finish "$(winpath "$REPO")" "$(winpath "$run_dir")" "${lopts[@]}" >"$run_dir/verdict.txt" 2>>"$run_dir/harness.log" \
      || echo "ledger: could not record this run (see harness.log)" >"$run_dir/verdict.txt"
  elif [ ! -f "$run_dir/summary.json" ]; then
    # Stopped before its summary (container killed, engine gone): a verdict all the same, never a pass.
    # `discard <repo> <run> --why ...` records it in the ledger.
    echo "verdict interrupted  next fix_environment  (no summary.json: $(tail -n 1 "$run_dir/harness.log" 2>/dev/null | tr -d '\r' | cut -c1-200))" >"$run_dir/verdict.txt"
  fi
  report "$run_dir"
}

# The address containers reach the host (OmniRoute) at, as host.docker.internal. BOXIE_HOST_IP wins.
# Docker (Desktop, and Engine 20.10+) resolves host-gateway itself; Desktop forwards it to the host's
# loopback. Podman with a machine (Windows, macOS) needs the address the VM resolves for the host
# (gvproxy's .254): the gateway Podman would inject reaches the WSL interface, not loopback. Podman on
# Linux has no machine: host-gateway (Podman 4.7+). On Linux the host service must listen where the
# container can reach it (not only 127.0.0.1), or set BOXIE_NETWORK=host and OMNIROUTE_BASE_URL
# to http://localhost:<port>/v1. `delegate.sh doctor` checks the route from inside a container.
host_address() {
  if [ -n "${BOXIE_HOST_IP:-}" ]; then echo "$BOXIE_HOST_IP"; return; fi
  if [ "$ENGINE" = podman ] && [ "$(uname -s)" != Linux ]; then
    local ip cache="$BOX/runs/.host-ip"
    # The VM's view changes only when the machine restarts: reuse it for 10 minutes (1-2 s an ssh).
    if [ -f "$cache" ] && [ $(( $(date +%s) - $(cat "$cache.t" 2>/dev/null || echo 0) )) -lt 600 ]; then cat "$cache"; return; fi
    # podman machine ssh writes its known-hosts file to "NUL", a real file under Git Bash: run it in runs/.
    mkdir -p "$BOX/runs"
    ip="$(cd "$BOX/runs" && podman machine ssh getent hosts host.containers.internal 2>/dev/null | awk '{print $1; exit}' | tr -d '\r'; rm -f NUL)"
    if [ -n "$ip" ]; then echo "$ip" >"$cache"; date +%s >"$cache.t"; else ip="192.168.127.254"; fi
    echo "$ip"; return
  fi
  echo host-gateway
}

# Concurrency slots: at most BOXIE_SLOTS containers at once (default 4), whatever starts them
# (fanout, bench, ticket mode, several orchestrators). A slot whose owner process died is reclaimed.
# PROJECT_SLOTS (projects/<repo>.env): at most that many of them for this project, checks included, so
# PROJECT_SLOTS=1 runs one project serially while others use the rest (RakunLoots P9, 2026-10-21:
# BOXIE_SLOTS=1 meant "slot 1 only", busy with another project, while slot 4 was free).
SLOT=""
# slot_acquire <name> [slot]: with a slot number, that one is preferred (a parked container's next round
# keeps its cache volumes); SLOT_PREFERRED=1 when it got it. Another free slot is taken after
# SLOT_PREFER_WAIT seconds (default 0): Lykos 2026-10-19 and RakunLoots 2026-10-22 resumes waited an
# hour for their old slot while others were free.
slot_acquire() {
  local d="$BOX/runs/.slots" i pid pr n="${BOXIE_SLOTS:-4}" waited=0 want="${2:-}" cap="${PROJECT_SLOTS:-0}" t0 mine=0 holders
  local memw=0 memsaid=0 mem="${3-$(mem_bytes "${MEMORY:-8g}")}"
  mkdir -p "$d"; t0=$(date +%s); SLOT_PREFERRED=0
  [[ "$want" =~ ^[0-9]+$ ]] && [ "$want" -le "$n" ] || want=""
  [[ "$cap" =~ ^[0-9]+$ ]] || cap=0
  while :; do
    # Owners that died leave their slot behind.
    for i in $(seq 1 "$n"); do
      read -r pid _ 2>/dev/null <"$d/$i/owner" || continue
      if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then rm -rf "$d/$i"; fi
    done
    # The project cap is counted and taken under one lock, so two launches cannot both see room.
    if slot_lock "$d"; then
      mine=0
      if [ "$cap" -gt 0 ]; then
        for i in $(seq 1 "$n"); do read -r _ _ pr 2>/dev/null <"$d/$i/owner" && [ "$pr" = "${PROJECT:-}" ] && mine=$((mine + 1)); done
      fi
      if { [ "$cap" = 0 ] || [ "$mine" -lt "$cap" ]; } && { mem_room "$d" "$mem" || { memw=1; false; }; }; then
        local order; order="$(seq 1 "$n")"
        if [ -n "$want" ]; then
          order="$want"
          [ $(( $(date +%s) - t0 )) -ge "${SLOT_PREFER_WAIT:-0}" ] && order="$want $(seq 1 "$n" | grep -vx "$want")"
        fi
        for i in $order; do
          if mkdir "$d/$i" 2>/dev/null; then
            echo "$$ $1 ${PROJECT:-}" >"$d/$i/owner"; echo "$mem" >"$d/$i/mem"; SLOT="$d/$i"; [ "$i" = "$want" ] && SLOT_PREFERRED=1
            slot_unlock "$d"; return 0
          fi
        done
      fi
      slot_unlock "$d"
    fi
    if [ "$memw" = 1 ]; then
      [ "$memsaid" = 1 ] || echo "boxie: $1 waits for memory: running caps $((MEM_USED >> 20)) MiB + $((mem >> 20)) MiB > $((MEM_LIMIT >> 20)) MiB (engine memory x MEMORY_OVERCOMMIT=${MEMORY_OVERCOMMIT:-1.5})" >&2
      memw=0; memsaid=1
    elif [ "$waited" = 0 ]; then
      # || true: a free slot has no owner file, and under pipefail its failed read made this line, and so
      # the launch, exit without a word (a council member and a spec check under PROJECT_SLOTS=1, 2026-10-27).
      holders="$(for i in $(seq 1 "$n"); do read -r _ nm pr 2>/dev/null <"$d/$i/owner" && echo "$i:$nm${pr:+ ($pr)}" || true; done | paste -sd, -)"
      if [ "$cap" -gt 0 ] && [ "$mine" -ge "$cap" ]; then
        echo "boxie: $1 waits: $PROJECT already has $mine of PROJECT_SLOTS=$cap (slots: ${holders:-none})" >&2
      else
        echo "boxie: $1 waits for a free slot of $n (BOXIE_SLOTS; held: ${holders:-none})" >&2
      fi
    fi
    waited=1; sleep 3
  done
}
# Memory: the caps (--memory) of every running Boxie container, all namespaces (they share the
# engine's VM), plus taken slots whose container is not up yet, against the engine's memory x
# MEMORY_OVERCOMMIT (default 1.5; 0: no check). Lykos P7 (2026-10-25): 8g caps past a 15.9 GB Podman VM,
# and the VM died 3 times. mem_room <slots dir> <bytes>: 0 when the new container fits, or when nothing
# runs (one container is never refused), or when the engine's memory is unknown.
mem_bytes() {
  local v="${1,,}"
  [[ "$v" =~ ^([0-9]+)([kmg]?)b?$ ]] || { echo 0; return; }
  case "${BASH_REMATCH[2]}" in g) echo $(( BASH_REMATCH[1] << 30 )) ;; m) echo $(( BASH_REMATCH[1] << 20 )) ;; k) echo $(( BASH_REMATCH[1] << 10 )) ;; *) echo "${BASH_REMATCH[1]}" ;; esac
}
MEM_TOTAL="" MEM_USED=0 MEM_LIMIT=0
mem_room() {
  local d="$1" want="$2" ids up=" " c m i nm pr
  [ "${MEMORY_OVERCOMMIT:-1.5}" = 0 ] && return 0
  if [ -z "$MEM_TOTAL" ]; then
    if [ "$ENGINE" = podman ]; then MEM_TOTAL="$(dk info --format '{{.Host.MemTotal}}' 2>/dev/null || true)"
    else MEM_TOTAL="$(dk info --format '{{.MemTotal}}' 2>/dev/null || true)"; fi
    [[ "$MEM_TOTAL" =~ ^[0-9]+$ ]] || MEM_TOTAL=0
  fi
  [ "$MEM_TOTAL" -gt 0 ] || return 0
  MEM_LIMIT="$(awk -v t="$MEM_TOTAL" -v r="${MEMORY_OVERCOMMIT:-1.5}" 'BEGIN { printf "%.0f", t * r }')"
  MEM_USED=0
  ids="$(dk ps -q --filter "label=$LABEL" 2>/dev/null || true)"
  if [ -n "$ids" ]; then
    while read -r c m; do
      up+="${c#/} "; [[ "$m" =~ ^[0-9]+$ ]] && MEM_USED=$(( MEM_USED + m ))
    done < <(dk inspect -f '{{.Name}} {{.HostConfig.Memory}}' $ids 2>/dev/null || true)
  fi
  for i in "$d"/*/owner; do
    read -r _ nm pr 2>/dev/null <"$i" || continue
    [[ "$up" == *" $NS-$pr-${nm//[^a-zA-Z0-9_.-]/-} "* ]] && continue
    read -r m 2>/dev/null <"${i%/owner}/mem" || m=0
    [[ "$m" =~ ^[0-9]+$ ]] && MEM_USED=$(( MEM_USED + m ))
  done
  [ "$MEM_USED" = 0 ] || [ $(( MEM_USED + want )) -le "$MEM_LIMIT" ]
}
slot_release() { [ -n "$SLOT" ] && rm -rf "$SLOT"; SLOT=""; return 0; }
# A short mutex under runs/.slots; a lock older than 30 s is a dead holder's and is broken.
slot_lock() {
  local k
  for k in $(seq 1 50); do
    mkdir "$1/.lock" 2>/dev/null && return 0
    if [ -n "$(find "$1/.lock" -maxdepth 0 -mmin +0.5 2>/dev/null)" ]; then rm -rf "$1/.lock"; fi
    sleep 0.2
  done
  return 1
}
slot_unlock() { rm -rf "$1/.lock"; }

# Setup and a test command on any commit, no agent: a merged tree before it lands, a benchmark's hidden
# check (--hidden: files the worker never saw, copied in first). Not a run in the ledger.
cmd_check() {
  local repo="$1" ref="$2"; shift 2
  local name=""
  load_project "$repo"
  while [ $# -gt 0 ]; do
    case "$1" in
      --test) TEST_CMD="$2"; shift 2 ;;
      --hidden) HIDDEN_DIR="$2"; shift 2 ;;
      --name) name="$2"; shift 2 ;;
      *) die "unknown option $1" ;;
    esac
  done
  [ -n "$name" ] || name="check-$(date +%Y%m%d-%H%M%S)"
  export TEST_CMD
  MODEL="" LEDGER_SKIP=1 launch "$name" "" "$ref" 1 >/dev/null
  jq -r '"check \(.test_exit)"' "$BOX/runs/$PROJECT/$name/summary.json" 2>/dev/null || echo "check -1"
}

# Ticket mode (lib/ticket.mjs): to-tickets tickets, tests first, locked, implemented, reviewed, landed.
cmd_ticket_js() { local sub="$1" repo="$2"; shift 2; node "$(winpath "$BOX/lib/ticket.mjs")" "$sub" "$(winpath "$(cd "$(repo_path "$repo")" && pwd)")" "$@"; }

cmd_baseline() {
  load_project "$1"
  MODEL="" launch "baseline-$(date +%Y%m%d-%H%M%S)" "" HEAD 1
}

cmd_run() {
  local repo="$1" task="$2"; shift 2
  [ -f "$task" ] || die "task file not found: $task"
  load_project "$repo"; need_key
  local name="" base="HEAD" role="" rulings="" eff="" spec="" SPEC_GATE=0
  MODEL="${DEFAULT_MODEL:-}" EFFORT="" VARIANT="" ALLOW_WEB=0 REVIEW=0 ASK="${ASK:-1}"
  while [ $# -gt 0 ]; do
    case "$1" in
      --role) spec="$2"; role="${2%%@*}"; shift 2
        role_model "$spec"
        case " ${READ_ONLY_ROLES:-} " in *" $role "*) REVIEW=1 ;; esac ;;
      --review) REVIEW=1; shift ;;
      --model) MODEL="$2"; EFFORT=""; spec=""; shift 2 ;;
      --effort) eff="$2"; shift 2 ;;
      --name) name="$2"; shift 2 ;;
      --base) base="$2"; shift 2 ;;
      --timeout) TIMEOUT_MIN="$2"; shift 2 ;;
      --variant) VARIANT="$2"; shift 2 ;;
      --web) ALLOW_WEB=1; shift ;;
      --no-ask) ASK=0; shift ;;
      --test) TEST_CMD="$2"; TEST_FROM_FLAG=1; shift 2 ;;
      --steps) STEPS="$2"; shift 2 ;;
      --autofix) AUTOFIX="$2"; shift 2 ;;
      --no-autofix) AUTOFIX=0; shift ;;
      --no-red) NO_RED=1; shift ;;
      --hidden) HIDDEN_DIR="$2"; shift 2 ;;          # benchmark check: files copied in before the tests
      --ref) REF_DIR="$2"; shift 2 ;;                # read-only runs: reference files at .boxie-ref/ in the clone
      --bench) LEDGER_BENCH="$2"; shift 2 ;;          # benchmark attempt: suite/task in the ledger
      --mode) LEDGER_MODE="$2"; shift 2 ;;
      --preamble) PREAMBLE="$2"; shift 2 ;;
      --no-spec-check) SPEC_CHECK=0; shift ;;
      --rulings) rulings="$2"; shift 2 ;;            # TEXT or @FILE: the orchestrator's answers to the spec check
      *) die "unknown option $1" ;;
    esac
  done
  [ -n "$MODEL" ] || die "no model: pass --role, --model or set DEFAULT_MODEL"
  # --effort wins over role@effort, wherever it stood on the line.
  if [ -n "$eff" ]; then if [ -n "$spec" ]; then role_model "$spec" "$eff"; else set_effort "$eff"; fi; fi
  ROLE="$role"
  # Rulings join the task itself, so the worker and every later reviewer read them as binding.
  if [ -n "$rulings" ]; then
    [[ "$rulings" == @* ]] && { [ -f "${rulings#@}" ] || die "rulings file not found: ${rulings#@}"; rulings="$(cat "${rulings#@}")"; }
    local ruled; ruled="$(scratch rulings)"
    { cat "$task"; printf '\n\n## The orchestrator'"'"'s rulings (binding)\n\n%s\n' "$rulings"; } >"$ruled"
    task="$ruled"
  # A ticket (frontmatter `issue:`) gets a spec check first. Folded into the implementer (known gap 29):
  # its first step, edits refused until it records the check or asks (image/plugin.js). Without the ask
  # tool, or with SPEC_CHECK=session, a read-only session of its own whose questions stop here.
  elif [ "${SPEC_CHECK:-1}" != 0 ] && [ "$REVIEW" != 1 ] && [ -z "${LEDGER_BENCH:-}" ] \
     && awk 'NR==1 && $0 != "---" {exit 1} NR>1 && $0 == "---" {exit} /^issue:/ {f=1} END {exit !f}' "$task"; then
    if [ "$ASK" != 0 ] && [ "${SPEC_CHECK:-1}" != session ]; then
      SPEC_GATE=1
    else
      local sc="${name:-$(date +%Y%m%d-%H%M%S)}-spec" rc=0
      # A subshell: the check loads the project again, which would reset what this run already parsed.
      (cmd_spec_check "$repo" "$task" --name "$sc" --base "$base") || rc=$?
      if [ "$rc" = 4 ]; then
        echo
        echo "verdict spec_questions  next answer_spec  (rerun with --rulings \"1: ...; 2: ...\" or --rulings @FILE; --no-spec-check to skip)"
        exit 4
      fi
    fi
  fi
  # A review without setup builds nothing: REVIEW_MEMORY (default 2g) instead of MEMORY's 8g, so two
  # fit beside each other in a 3.8 GiB engine where 8g caps let only one run.
  # A review in parts installs nothing. Set here: boxie.conf, sourced again by this run, resets the
  # REVIEW_SETUP=0 the review passed in (AACR vllm smoke, 2026-11-02).
  [ -n "${BUNDLES_FILE:-}" ] && REVIEW_SETUP=0
  [ "$REVIEW" = 1 ] && [ "${REVIEW_SETUP:-1}" = 0 ] && MEMORY="${REVIEW_MEMORY:-2g}"
  export MODEL EFFORT VARIANT ALLOW_WEB REVIEW ASK ROLE SCOUT_MODEL="${SCOUT_MODEL:-}" STEPS="${STEPS:-}" AUTOFIX="${AUTOFIX:-1}" NO_RED="${NO_RED:-0}" SPEC_GATE REVIEW_SETUP="${REVIEW_SETUP:-1}" REVIEW_FANOUT="${REVIEW_FANOUT:-6}" REVIEW_PART_MIN="${REVIEW_PART_MIN:-7}" REVIEW_REPORT_MIN="${REVIEW_REPORT_MIN:-5}" REVIEW_FILTER="${REVIEW_FILTER:-1}" REVIEW_FILTER_MIN="${REVIEW_FILTER_MIN:-3}" FILTER_MODEL="${FILTER_MODEL:-}"
  [ -n "$name" ] || name="$(date +%Y%m%d-%H%M%S)-${role:-$(echo "$MODEL" | tr -c 'a-zA-Z0-9.\n' '-' | cut -c1-30)}"
  launch "$name" "$task" "$base" 0
}

# Resumes a finished run's OpenCode session in a fresh container: same worker, same model, same
# sealed files and test, starting on its own branch. Answers a BLOCKED question, passes review
# findings, or asks for the next step. Any earlier round can be continued again, which forks it.
cmd_continue() {
  local repo="$1" from="$2"; shift 2
  local msg_file="" name="" timeout="" findings="" drop="" cause="worker_careless" text="" at="" steps="" reseal="" seals=()
  while [ $# -gt 0 ]; do
    case "$1" in
      -m|--message) text="$2"; shift 2 ;;
      -f|--file) [ -f "$2" ] || die "message file not found: $2"; text="$(cat "$2")"; shift 2 ;;
      --findings) findings="$2"; shift 2 ;;   # REVIEW-RUN[:n,m][+REVIEW-RUN...]: forward these findings
      --drop) drop="$2"; shift 2 ;;           # REVIEW-RUN:n,m: findings checked and wrong (false positives)
      --cause) cause="$2"; shift 2 ;;
      --name) name="$2"; shift 2 ;;
      --timeout) timeout="$2"; shift 2 ;;
      # A reviewer resumed on a newer branch (the review loop): its session, the fix's code.
      --at) at="$2"; shift 2 ;;
      --steps) steps="$2"; shift 2 ;;
      # The orchestrator corrected a sealed file: the round starts on that commit (it must contain the
      # run's head), and sealed files are checked against it. --seal adds a sealed glob.
      --reseal) reseal="$2"; shift 2 ;;
      --seal) seals+=("$2"); shift 2 ;;
      *) die "unknown option $1" ;;
    esac
  done
  [ -n "$text" ] || [ -n "$findings" ] || die "continue needs -m TEXT, -f FILE or --findings REVIEW-RUN[:n,m]"
  load_project "$repo"; need_key
  msg_file="$(scratch message)"
  # Review findings go to the worker verbatim from findings.json, never retyped; the ledger records
  # which were forwarded and which were dropped as false positives.
  if [ -n "$findings" ]; then
    node "$(winpath "$BOX/lib/forward.mjs")" "$(winpath "$BOX/runs/$PROJECT")" "$findings" "$drop" "$cause" "$PROJECT" >"$msg_file" \
      || die "could not read the findings ($findings)"
  fi
  [ -n "$text" ] && printf '%s\n' "$text" >>"$msg_file"
  local prev="$BOX/runs/$PROJECT/$from"
  for f in summary.json meta.sh opencode-data.tgz; do
    [ -f "$prev/$f" ] || die "run $from cannot be continued: no $f (runs made before session saving have none)"
  done
  local session commits head
  read -r session commits head < <(node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log((s.session||"")+" "+s.commits+" "+s.head)' "$(winpath "$prev/summary.json")")
  [ -n "$session" ] || die "run $from recorded no session id"
  # shellcheck disable=SC1091
  . "$prev/meta.sh"
  [ -n "$timeout" ] && TIMEOUT_MIN="$timeout"
  [ -n "$steps" ] && STEPS="$steps"
  # Start where the previous round ended: its branch, or (no commits, e.g. a review or an early
  # BLOCKED) the commit it ran on, through a temporary ref so it can be bundled.
  local start="agent/$from" g
  for g in "${seals[@]}"; do SEALED="${SEALED:+$SEALED$'\n'}$g"; done
  if [ -n "$reseal" ]; then
    [ "${REVIEW:-0}" = 1 ] && die "--reseal is for implementation runs"
    [ -z "$at" ] || die "--reseal and --at do not go together"
    local rs; rs="$(git -C "$REPO" rev-parse --verify --quiet "$reseal^{commit}")" || die "no such commit $reseal"
    git -C "$REPO" merge-base --is-ancestor "$head" "$rs" || die "$reseal does not contain $from's head ${head:0:10}: commit the correction on top of agent/$from"
    echo "boxie: resealed: the next round of $from starts on ${rs:0:10}; sealed files are checked against it" >&2
    start="refs/heads/boxie-tmp/start-$from"
    git -C "$REPO" update-ref "$start" "$rs"
  elif [ -n "$at" ]; then
    [ "${REVIEW:-0}" = 1 ] || die "--at is for review runs: a worker continues on its own branch"
    git -C "$REPO" show-ref --verify --quiet "refs/heads/$at" || die "no such branch $at"
    start="refs/heads/$at"; export REVIEW_TARGET="$at"
  elif ! git -C "$REPO" show-ref --verify --quiet "refs/heads/$start"; then
    [ "$commits" = 0 ] || die "branch $start is gone from $REPO; fetch it again from $prev/result.bundle"
    start="refs/heads/boxie-tmp/start-$from"
    git -C "$REPO" update-ref "$start" "$head" || die "commit $head is not in $REPO"
  fi
  ROUND=$(( RUN_ROUND + 1 ))
  if [ -z "$name" ]; then
    local root; root="$(sed -E 's/-r[0-9]+[a-z]?$//' <<<"$from")"
    name="$root-r$ROUND"; local k; for k in b c d e f g h; do
      [ -e "$BOX/runs/$PROJECT/$name" ] || break; name="$root-r$ROUND$k"
    done
  fi
  export MODEL EFFORT VARIANT ALLOW_WEB REVIEW SCOUT_MODEL TEST_CMD SEALED SKILLS_ALLOW TIMEOUT_MIN ROUND ASK ROLE STEPS AUTOFIX
  CONTINUE_SESSION="$session" CONTINUE_FROM="$prev" ORIG_BASE="$RUN_BASE_SHA" LEDGER_PARENT="$from" \
    launch "$name" "$msg_file" "$start" 0
  case "$start" in refs/heads/boxie-tmp/*) git -C "$REPO" update-ref -d "$start" ;; esac
}

# Live feed of a run: harness steps, every tool call, the worker's messages. In a herdr pane it also
# reports the worker's state to herdr. Ends when the run's container is gone.
cmd_watch() {
  load_project "$1"
  local name="$2" c dir model="" role="" i
  c="$(cname_of "$name")"; dir="$BOX/runs/$PROJECT/$name"
  [ -f "$dir/meta.sh" ] && read -r model role < <(. "$dir/meta.sh"; echo "$MODEL ${ROLE:-}")
  # The exec ends with an error when the run removes its container: that is the normal end. It also
  # ends when the watch starts before the container is up, or while a parked container is renamed and
  # cleared for this round: the feed then reattaches until the run has ended (RakunLoots #107 rv2,
  # 2026-10-22: a watch opened early printed "no verdict" while the review ran 14 steps).
  {
    local k
    for k in $(seq 1 40); do
      for i in $(seq 1 60); do [ "$(dk inspect -f '{{.State.Running}}' "$c" 2>/dev/null)" = true ] && break; run_over "$dir" && break; sleep 1; done
      dk exec "$c" sh -c 'tail -n +1 -F /out/harness.log /out/events.jsonl 2>/dev/null' 2>/dev/null || true
      run_over "$dir" && break
      sleep 2
    done
  } | AB_COLS="$(term_cols)" node "$(winpath "$BOX/lib/watch.mjs")" "$name" "$model" "$role" || true
  # The verdict line comes from lib/ledger.mjs (checks + ledger), written after the container is gone.
  for i in $(seq 1 60); do [ -f "$dir/verdict.txt" ] && break; sleep 1; done
  local verdict="no verdict (run interrupted?)"
  [ -f "$dir/summary.json" ] && verdict="$(jq -r '"\(.verdict // "?"), tests \(if .test_exit == 0 then "pass" elif .test_exit == -1 then "not run" else "FAIL (\(.test_exit))" end)\(if (.autofix // 0) > 0 then " after \(.autofix) auto-fix" else "" end), \(.commits) commit(s), \(.seconds)s" + (if .blocked then ", BLOCKED: \(.blocked)" else "" end) + (if ((.flags // []) | length) > 0 then ", " + ([.flags[].flag] | join(" ")) else "" end)' "$dir/summary.json")"
  echo; printf '\e[1m== %s done: %s\e[0m\n' "$name" "$verdict"
  [ -f "$dir/summary.json" ] && jq -r '"   next: \(.next // "?")"' "$dir/summary.json"
  [ -f "$dir/diffstat.txt" ] && tail -n 1 "$dir/diffstat.txt"
  if [ "${HERDR_ENV:-}" = 1 ] && [ -n "${HERDR_PANE_ID:-}" ]; then
    local short="${model##*/}"; short="${short%-tiered}"
    "$HERDR_BIN_PATH" pane report-agent "$HERDR_PANE_ID" --source boxie --agent "$name${short:+ ($short)}" --state idle \
      --message "done: $verdict" --seq "$(( $(date +%s) * 1000 ))" >/dev/null 2>&1 || true
    herdr_close_tab
  fi
}

# A run is over when launch wrote <run>/ended (or a verdict), or its launcher is gone with no container
# left running (a launcher killed outright writes nothing).
run_over() {
  local dir="$1" pid
  [ -f "$dir/ended" ] || [ -f "$dir/verdict.txt" ] && return 0
  read -r pid 2>/dev/null <"$dir/launcher.pid" || return 1
  ! kill -0 "$pid" 2>/dev/null && [ "$(dk inspect -f '{{.State.Running}}' "$(cname_of "${dir##*/}")" 2>/dev/null)" != true ]
}

# In a herdr tab: Enter closes it. AB_TAB_LINGER (seconds) closes it by itself: benchmarks open many tabs.
herdr_close_tab() {
  [ "${HERDR_ENV:-}" = 1 ] && [ -n "${HERDR_PANE_ID:-}" ] || return 0
  if [ -n "${AB_TAB_LINGER:-}" ]; then read -r -t "$AB_TAB_LINGER" -p "Enter closes this tab (or wait ${AB_TAB_LINGER}s). " _ || true
  else read -r -p "Enter closes this tab. " _ || true; fi
  if [ -n "${AB_HERDR_TAB:-}" ]; then "$HERDR_BIN_PATH" tab close "$AB_HERDR_TAB" >/dev/null 2>&1 || true
  else "$HERDR_BIN_PATH" pane close "$HERDR_PANE_ID" >/dev/null 2>&1 || true; fi
}

# Live view of a review and fix loop: rounds, what runs now and for how long, each finding with where
# the harness routed it, decisions, and what the orchestrator does when it stops. Ends when it stops.
cmd_loop_watch() {
  load_project "$1"
  local name="$2" dir="$BOX/runs/$PROJECT/_loops/$2"
  [ -d "$dir" ] || die "no loop $name in runs/$PROJECT/_loops"
  AB_COLS="$(term_cols)" \
    node "$(winpath "$BOX/lib/loopwatch.mjs")" "$(winpath "$dir/progress.jsonl")" "$name" "$REPO" || true
  herdr_close_tab
}

# The loop's own herdr tab (lib/loop.mjs opens it when the loop starts or resumes).
cmd_loop_tab() {
  load_project "$1"
  local name="$2" ws tabjson pane dir="$BOX/runs/$PROJECT/_loops/$2"
  herdr_ok && [ -d "$dir" ] || return 0
  ws="$(herdr_ws)"; [ -n "$ws" ] && [ "$ws" != null ] || return 0
  tabjson="$(herdr tab create --workspace "$ws" --label "$name" --cwd "$(winpath "$BOX")" 2>/dev/null)" || return 0
  pane="$(jq -r '.result.root_pane.pane_id' <<<"$tabjson")"
  [ -n "$pane" ] && [ "$pane" != null ] || return 0
  printf '#!/usr/bin/env bash\nexport AB_HERDR_TAB=%q AB_TAB_LINGER=%q BOXIE_PROJECT_ENV=%q\nexec %q loop-watch %q %q\n' \
    "$(jq -r '.result.tab.tab_id' <<<"$tabjson")" "${AB_TAB_LINGER:-}" "${BOXIE_PROJECT_ENV:-}" "$BOX/delegate.sh" "$REPO" "$name" >"$dir/watch.sh"
  herdr_launch "$pane" "$dir/watch.sh"
}

# herdr: one tab per run in an "boxie" workspace, running `watch`. Silently does nothing when
# herdr is not installed or not running, or BOXIE_HERDR=0.
herdr_ok() {
  [ "${BOXIE_HERDR:-auto}" != 0 ] && command -v herdr >/dev/null \
    && herdr status server 2>/dev/null | grep -q 'status: running'
}
herdr_ws() {
  local ws
  ws="$(herdr workspace list 2>/dev/null | jq -r --arg ns "$NS" '.result.workspaces[] | select(.label == $ns) | .workspace_id' | head -n 1)"
  [ -n "$ws" ] || ws="$(herdr workspace create --label "$NS" --cwd "$(winpath "$BOX")" --no-focus 2>/dev/null | jq -r '.result.workspace.workspace_id')"
  echo "$ws"
}
# Each run's tab: the real OpenCode TUI attached to the worker on the left (TUI=1), the boxie feed
# (harness steps, tool calls, verdict; reports state to herdr) on the right.
herdr_open() {
  local name="$1" ws tabjson tab pane feed dir="$BOX/runs/$PROJECT/$1"
  herdr_ok || return 0
  ws="$(herdr_ws)"; [ -n "$ws" ] && [ "$ws" != null ] || return 0
  tabjson="$(herdr tab create --workspace "$ws" --label "$name" --cwd "$(winpath "$BOX")" 2>/dev/null)" || return 0
  tab="$(jq -r '.result.tab.tab_id' <<<"$tabjson")"; pane="$(jq -r '.result.root_pane.pane_id' <<<"$tabjson")"
  [ -n "$pane" ] && [ "$pane" != null ] || return 0
  # Script files, so no quoting has to survive the pane's shell (PowerShell on Windows).
  printf '#!/usr/bin/env bash\nexport AB_HERDR_TAB=%q AB_TAB_LINGER=%q BOXIE_PROJECT_ENV=%q\nexec %q watch %q %q\n' "$tab" "${AB_TAB_LINGER:-}" "${BOXIE_PROJECT_ENV:-}" "$BOX/delegate.sh" "$REPO" "$name" >"$dir/watch.sh"
  if [ "${TUI:-0}" = 1 ]; then
    printf '#!/usr/bin/env bash\nexport BOXIE_PROJECT_ENV=%q\nexec %q tui %q %q\n' "${BOXIE_PROJECT_ENV:-}" "$BOX/delegate.sh" "$REPO" "$name" >"$dir/tui.sh"
    feed="$(herdr pane split "$pane" --direction right --ratio "${BOXIE_TUI_RATIO:-0.66}" --cwd "$(winpath "$BOX")" 2>/dev/null | jq -r '.result.pane.pane_id')"
    herdr_launch "$pane" "$dir/tui.sh"
    if [ -n "$feed" ] && [ "$feed" != null ]; then herdr_launch "$feed" "$dir/watch.sh"; fi
  else
    herdr_launch "$pane" "$dir/watch.sh"
  fi
}
herdr_launch() {
  if command -v cygpath >/dev/null; then
    herdr pane run "$1" "& '$(cygpath -w "$(command -v bash)")' -l '$(cygpath -m "$2")'" >/dev/null 2>&1 || true
  else
    herdr pane run "$1" "bash -l '$2'" >/dev/null 2>&1 || true
  fi
}

# The real OpenCode TUI, attached to a running worker's session through the OpenCode server inside its
# container (run-task.sh starts it when TUI=1). Typing into it reaches the worker: that is steering.
cmd_tui() {
  load_project "$1"
  local name="$2" c sid="" i
  c="$(cname_of "$name")"
  printf '\e[2m%s: waiting for the worker to start (setup and checks run first)...\e[0m\n' "$name"
  for i in $(seq 1 900); do
    if [ "$(dk inspect -f '{{.State.Running}}' "$c" 2>/dev/null)" != true ]; then
      [ "$i" -gt 30 ] && break; sleep 1; continue
    fi
    sid="$(dk exec "$c" sh -c "jq -r 'select(.sessionID) | .sessionID' /out/events.jsonl 2>/dev/null | head -n 1" 2>/dev/null | tr -d '\r')"
    [ -n "$sid" ] && break
    sleep 2
  done
  if [ -n "$sid" ]; then
    dk exec -it "$c" opencode attach http://127.0.0.1:4096 --session "$sid" || true
  fi
  printf '\n%s: the worker is gone; its OpenCode session is saved for `continue`.\n' "$name"
  if [ "${HERDR_ENV:-}" = 1 ] && [ -n "${HERDR_PANE_ID:-}" ]; then sleep 2; "$HERDR_BIN_PATH" pane close "$HERDR_PANE_ID" >/dev/null 2>&1 || true; fi
}

# Open questions a running worker asked with ask_orchestrator. --wait blocks until one appears
# (exit 0) or the run ends (exit 1), so an orchestrator can watch a background run with it.
cmd_questions() {
  local repo="$1" name="$2" wait="${3:-}"
  load_project "$repo"
  local c out; c="$(cname_of "$name")"
  while :; do
    [ "$(dk inspect -f '{{.State.Running}}' "$c" 2>/dev/null)" = true ] || { echo "run $name is not running"; return 1; }
    out="$(dk exec "$c" sh -c 'cd /out/questions 2>/dev/null || exit 0
      for f in *.md; do
        [ -e "$f" ] || continue; case "$f" in *.answer.md) continue ;; esac
        n="${f%.md}"; [ -s "$f" ] || continue
        [ -e "/in/answers/$n.md" ] || [ -e "$n.answer.md" ] || [ -e "$n.timeout" ] || { printf "## question %s\n" "$n"; cat "$f"; }
      done')"
    [ -n "$out" ] && { printf '%s\n' "$out"; return 0; }
    [ "$wait" = --wait ] || { echo "no open questions"; return 0; }
    sleep 5
  done
}

# Blocks until the named runs and loops end, then prints each one's short report: one background
# command for the orchestrator instead of sleep-and-tail polling. A name is a run (runs/<project>/<name>)
# or a loop (runs/<project>/_loops/<name>); a name with no folder yet is waited for (a run still
# queued for a slot). --any: return when the first one ends. --questions: also return when a running
# worker asks with ask_orchestrator. Exit 0, or 3 when --timeout MIN ran out first.
cmd_wait() {
  local repo="$1"; shift
  local any=0 asks=0 timeout="" names=() n
  while [ $# -gt 0 ]; do
    case "$1" in
      --any) any=1; shift ;;
      --questions) asks=1; shift ;;
      --timeout) timeout="$2"; shift 2 ;;
      -*) die "unknown option $1" ;;
      *) names+=("$1"); shift ;;
    esac
  done
  [ "${#names[@]}" -gt 0 ] || die "wait needs one or more run or loop names"
  load_project "$repo"
  local runs="$BOX/runs/$PROJECT" start; start=$(date +%s)
  local qfile="$runs/.wait-q-$$"
  local -A shown=()
  ended() {
    local d="$runs/_loops/$1"
    # The base suite runs beside the loop and may log its "done" after the loop's "end".
    if [ -f "$d/progress.jsonl" ]; then grep -v '"what":"basesuite"' "$d/progress.jsonl" | tail -n 1 | grep -q '"ev":"end"'; return; fi
    d="$runs/$1"
    [ -d "$d" ] || return 1
    run_over "$d" && return 0
    [ -f "$d/summary.json" ] && [ "$(dk inspect -f '{{.State.Running}}' "$(cname_of "$1")" 2>/dev/null)" != true ]
  }
  show_one() {
    if [ -d "$runs/_loops/$1" ]; then
      echo "== loop $1"
      (cd "$BOX" && node --input-type=module -e 'import { loopBrief } from "./lib/loop.mjs"; import fs from "node:fs";
        const f = process.argv[1]; console.log(loopBrief(JSON.parse(fs.readFileSync(f, "utf8")), f));' "$(winpath "$runs/_loops/$1/state.json")")
    else
      report "$runs/$1"
    fi
  }
  while :; do
    local left=0
    for n in "${names[@]}"; do
      [ -n "${shown[$n]:-}" ] && continue
      if ended "$n"; then shown[$n]=1; show_one "$n"; echo
      else
        left=$((left + 1))
        if [ "$asks" = 1 ]; then
          # A loop asks through the runs of its current round (<loop>-fix*, <loop>-rv*): its live containers.
          local live=() r
          if [ -d "$runs/_loops/$n" ]; then
            mapfile -t live < <(dk ps --filter "label=boxie.project=$PROJECT" --format '{{.Names}}' 2>/dev/null | tr -d '\r' \
              | sed -n "s/^$NS-$PROJECT-//p" | grep -F -- "$n-" | grep -E "^$n-" || true)
          elif [ -d "$runs/$n" ]; then live=("$n"); fi
          # A parked container is idle between rounds: its old, answered questions are not new ones
          # (Lykos T197, 2026-10-22: a wait woke on one and printed an empty question).
          for r in "${live[@]}"; do
            [ -f "$runs/$r/parked" ] && continue
            if cmd_questions "$repo" "$r" >"$qfile" 2>/dev/null && grep -q '^## question ' "$qfile"; then
              echo "== $r asks:"; cat "$qfile"; rm -f "$qfile"; echo "answer: delegate.sh answer $REPO $r <id> -m TEXT"; return 0
            fi
          done
        fi
      fi
    done
    [ "$left" = 0 ] && { rm -f "$qfile"; return 0; }
    [ "$any" = 1 ] && [ "${#shown[@]}" -gt 0 ] && { rm -f "$qfile"; echo "still running: $left"; return 0; }
    if [ -n "$timeout" ] && [ $(( $(date +%s) - start )) -ge $(( timeout * 60 )) ]; then echo "wait: ${timeout} min passed, $left still running"; return 3; fi
    sleep 10
  done
}

# Answers question <id> of a running worker. Written atomically: the worker never reads half a file.
cmd_answer() {
  local repo="$1" name="$2" id="$3"; shift 3
  local msg_file=""
  case "${1:-}" in
    -m|--message) msg_file="$(scratch answer)"; printf '%s\n' "$2" >"$msg_file" ;;
    -f|--file) [ -f "$2" ] || die "answer file not found: $2"; msg_file="$2" ;;
    *) die "answer needs -m TEXT or -f FILE" ;;
  esac
  [[ "$id" =~ ^[0-9]+$ ]] || die "question id must be a number"
  load_project "$repo"
  local c; c="$(cname_of "$name")"
  dk exec -i "$c" sh -c "cat > /in/answers/.$id.tmp && mv /in/answers/.$id.tmp /in/answers/$id.md" <"$msg_file" \
    || die "could not deliver the answer (is run $name still running?)"
  echo "boxie: answered question $id of $name"
}

# One line per run: the evidence an orchestrator selects on. Agent claims are not in it.
table() {
  local dir="$1"; shift
  printf '%-28s %-34s %5s %5s %4s %6s %s\n' run model test agent cmts secs flags
  for n in "$@"; do
    local s="$dir/$n/summary.json"
    [ -f "$s" ] || { printf '%-28s (no summary)\n' "$n"; continue; }
    node -e '
      const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const flags = [s.blocked && "BLOCKED", (s.sealed_violation || []).length && "SEALED-EDIT", s.review_violation && "REVIEW-EDIT"].filter(Boolean).join(",");
      console.log([process.argv[2].padEnd(28), String(s.model).padEnd(34), String(s.test_exit).padStart(5), String(s.agent_exit).padStart(5),
        String(s.commits).padStart(4), String(s.seconds).padStart(6), flags].join(" "));
    ' "$(winpath "$s")" "$n"
  done
}

# Same task, several roles in parallel, each on its own branch. Selection is the caller's: by tests,
# then by diff review, never by the workers' own reports.
cmd_fanout() {
  local repo="$1" task="$2"; shift 2
  local roles="" name="" score="" passthru=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --roles) roles="$2"; shift 2 ;;
      --name) name="$2"; shift 2 ;;
      --score) score="$2"; shift 2 ;;   # a command run on every result branch in a container: exit 0 = pass
      *) passthru+=("$1"); shift ;;
    esac
  done
  [ -n "$roles" ] || die "fanout needs --roles a,b[,c]"
  load_project "$repo"
  herdr_ok && herdr_ws >/dev/null  # create the workspace once, before parallel runs race for it
  [ -n "$name" ] || name="fan-$(date +%Y%m%d-%H%M%S)"
  local names=() r
  for r in ${roles//,/ }; do
    "${SELF[@]}" run "$repo" "$task" --role "$r" --name "$name-${r/@/-}" "${passthru[@]}" >"$BOX/runs/$PROJECT/.$name-${r/@/-}.log" 2>&1 &
    names+=("$name-${r/@/-}"); sleep 2
  done
  wait
  table "$BOX/runs/$PROJECT" "${names[@]}"
  [ -n "$score" ] || return 0
  # Same check for every attempt (a judge, the hidden tests), so picking one is a number, not a reading.
  echo; echo "score: $score"
  for n in "${names[@]}"; do
    git -C "$REPO" rev-parse --verify --quiet "agent/$n^{commit}" >/dev/null || { echo "  $n  no branch"; continue; }
    echo "  $n  $( (cmd_check "$repo" "agent/$n" --test "$score" --name "$n-score") 2>/dev/null | tail -n 1)"
  done
}

# Read-only review of a branch by several reviewers in parallel. The review task is generated: the
# changed files feed the context pack, and when the branch came from a boxie run its original
# task is quoted so reviewers can check the change against what was asked.
# Two axes, the same prompts as ticket mode: review-spec (does it do what the spec asks, edge cases,
# tests) and review-std (the repo's standards); or, in review mode `both`, one review-both covering
# both (lib/reviewmode.mjs). Every reviewer gets the spec: the branch's own task when boxie made
# it, plus every --spec file.
# One review by open-code-review (lib/ocr.mjs) as a run of its own: meta.sh, the task, the ledger entry
# and verdict.txt as for a container review. The task the change was made for and any --spec go to OCR
# as its background. ocr_review <name> <model> <role> <base> <branch> <task> <paths> <origin> [spec...]
ocr_review() {
  local n="$1" model="$2" role="$3" base="$4" branch="$5" task="$6" paths="$7" origin="$8"; shift 8
  local dir="$BOX/runs/$PROJECT/$n" bg="" f
  [ -e "$dir" ] && die "run $n exists"
  mkdir -p "$dir"; cp "$task" "$dir/task.md"
  need_key
  if [ -f "$origin" ] || [ $# -gt 0 ]; then
    bg="$dir/background.md"
    { [ -f "$origin" ] && { echo "# The task the change was made for"; echo; cat "$origin"; echo; }
      for f in "$@"; do echo "# Spec: $(basename "$f")"; echo; cat "$f"; echo; done; } >"$bg"
  fi
  local v MODEL="ocr:$model" ROLE="$role" REVIEW=1 REVIEW_TARGET="$branch" TIMEOUT_MIN="${OCR_TIMEOUT_MIN:-15}"
  for v in MODEL ROLE REVIEW REVIEW_TARGET TIMEOUT_MIN; do printf '%s=%q\n' "$v" "${!v}"; done >"$dir/meta.sh"
  printf 'RUN_BASE_SHA=%q\nRUN_BASE_REF=%q\nENGINE=ocr\n' "$(git -C "$REPO" rev-parse "$base")" "$branch" >>"$dir/meta.sh"
  echo "boxie: $n: open-code-review on $model (host, read-only worktree)" >&2
  OCR_BIN="${OCR_BIN:-}" OMNIROUTE_HOST_URL="$OMNIROUTE_HOST_URL" OMNIROUTE_API_KEY="$OMNIROUTE_API_KEY" node "$(winpath "$BOX/lib/ocr.mjs")" review \
    "$(winpath "$REPO")" "$base" "$branch" "$(winpath "$dir")" --model "$model" --effort "${OCR_EFFORT:-medium}" \
    --concurrency "${OCR_CONCURRENCY:-8}" --timeout "${OCR_TIMEOUT_MIN:-15}" ${OCR_MAX_TOOLS:+--max-tools "$OCR_MAX_TOOLS"} \
    ${bg:+--background-file "$(winpath "$bg")"} ${paths:+--paths "$paths"} 2>&1 | tee "$dir/harness.log" >&2 || true
  if [ -f "$dir/summary.json" ]; then
    node "$(winpath "$BOX/lib/ledger.mjs")" finish "$(winpath "$REPO")" "$(winpath "$dir")" --mode review --target "$branch" >"$dir/verdict.txt" 2>>"$dir/harness.log" \
      || echo "ledger: could not record this run (see harness.log)" >"$dir/verdict.txt"
  else
    echo "verdict error  next fix_environment  (open-code-review wrote no summary: see harness.log)" >"$dir/verdict.txt"
  fi
  cat "$dir/verdict.txt" >&2
}

cmd_review() {
  local repo="$1" branch="$2"; shift 2
  local roles="" mode="" against="" focus="" prefix="" prior_spec="" prior_std="" prior_both="" specs=() effort="" paths="" kind=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --roles) roles="$2"; shift 2 ;;
      --effort) effort="$2"; shift 2 ;;   # every reviewer without its own role@effort
      --paths) paths="$2"; shift 2 ;;     # space-separated pathspecs: review only this area (phase-review)
      --review-mode) mode="$2"; shift 2 ;;
      --against) against="$2"; shift 2 ;;
      --focus) focus="$2"; shift 2 ;;
      --spec) [ -f "$2" ] || die "no such spec file $2"; specs+=("$2"); shift 2 ;;
      --name) prefix="$2"; shift 2 ;;        # review runs are named PREFIX-<role>
      # Advise: every useful comment, reviewed in parts side by side (image/fanout.mjs), no setup, no
      # reproductions. The default (gate) keeps few, proven findings for the loop.
      --advise) kind=advise; shift ;;
      # The previous round's findings for one axis, rechecked first (the review loop, lib/loop.mjs).
      --prior) [ -f "${2#*=}" ] || die "no such prior findings file ${2#*=}"
        case "$2" in spec=*) prior_spec="${2#*=}" ;; std=*) prior_std="${2#*=}" ;; both=*) prior_both="${2#*=}" ;; *) die "--prior takes spec=FILE, std=FILE or both=FILE" ;; esac
        shift 2 ;;
      *) die "unknown option $1" ;;
    esac
  done
  load_project "$repo"
  # After load_project: the project file may set its own REVIEW_MODE or REVIEW_ROLES.
  [ -n "$roles" ] || roles="$(node "$(winpath "$BOX/lib/reviewmode.mjs")" roles "$mode" "${REVIEW_ROLES:-}" "${REVIEW_MODE:-}")" || exit 1
  herdr_ok && herdr_ws >/dev/null
  git -C "$REPO" rev-parse --verify --quiet "$branch^{commit}" >/dev/null || die "no such branch $branch"
  [ -n "$against" ] || against="$(git -C "$REPO" symbolic-ref --short HEAD 2>/dev/null || echo HEAD)"
  local base; base="$(git -C "$REPO" merge-base "$against" "$branch")"
  local stamp; stamp="$(date +%Y%m%d-%H%M%S)"
  # The prefix too: phase-review starts one review per area in the same second.
  local tdir="$BOX/runs/$PROJECT/.review-$stamp${prefix:+-$prefix}"; mkdir -p "$tdir"
  local body="$tdir/body.md" origin="$BOX/runs/$PROJECT/${branch#agent/}/task-body.md" f
  # One pathspec per line when the list has a newline (phase-review sends that: a path may hold a space).
  local pspec=()
  if [[ "$paths" == *$'\n'* ]]; then mapfile -t pspec < <(grep -v '^$' <<<"$paths")
  elif [ -n "$paths" ]; then mapfile -t pspec < <(tr ' ' '\n' <<<"$paths" | grep -v '^$'); fi
  kind="${kind:-${REVIEW_KIND:-gate}}"
  [ "$kind" = gate ] || [ "$kind" = advise ] || die "REVIEW_KIND is gate or advise, not $kind"
  # Advise: the parts every reviewer of this round takes (lib/bundle.mjs), with open-code-review's
  # per-language checklists when its binary is here.
  local bundles=""
  if [ "$kind" = advise ]; then
    local ocrb; ocrb="$(OCR_BIN="${OCR_BIN:-}" node "$(winpath "$BOX/lib/ocr.mjs")" bin 2>/dev/null || true)"
    node "$(winpath "$BOX/lib/bundle.mjs")" "$(winpath "$REPO")" "$base" "$branch" --full ${ocrb:+--ocr "$ocrb"} \
      --max "${REVIEW_PARTS_MAX:-8}" --files "${REVIEW_PART_FILES:-3}" ${paths:+--paths "$paths"} >"$tdir/bundles-full.json" || die "could not split the diff into parts"
    bundles="$tdir/bundles.json"
    node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); require("fs").writeFileSync(process.argv[2], JSON.stringify(j.bundles)); console.error(`boxie: advise review in ${j.bundles.length} part(s): ${j.bundles.map((b)=>b.files.length).join("+")} files${j.skipped.length ? `, ${j.skipped.length} skipped (lockfiles, binaries, generated)` : ""}`)' \
      "$(winpath "$tdir/bundles-full.json")" "$(winpath "$bundles")"
  fi
  [ -f "$origin" ] || [ ${#specs[@]} -gt 0 ] || echo "boxie: warning: no spec: $branch was not made by boxie and no --spec was given" >&2
  {
    echo
    echo "Review the change on this branch: \`git diff $base..HEAD\` ($(git -C "$REPO" rev-list --count "$base..$branch") commits)."
    if [ ${#pspec[@]} -gt 0 ]; then
      echo
      echo "This review covers one area of a larger change: report findings in these files only. Read any other"
      echo "file when a seam needs it (callers, contracts, shared state)."
      printf -- '- %s\n' "${pspec[@]}"
    fi
    echo
    git -C "$REPO" log --format='- %h %s' "$base..$branch"
    if [ -f "$origin" ]; then
      echo; echo "## The task the change was made for (it was the implementer's; you review, you do not implement)"; echo; sed 's/^/> /' "$origin"
    fi
    for f in "${specs[@]}"; do
      echo; echo "## Spec: $(basename "$f")"; echo; sed 's/^/> /' "$f"
    done
    # The diff itself when it is small: reviewers otherwise spend their first steps on `git diff` file by
    # file (La-t50 review, 2026-10-17: 7 of 51 shell calls). After the task and spec, so the last
    # instructions a reviewer reads are not the implementer's: with the diff before them, a DeepSeek
    # review of RakunMiniItems #50 implemented the task instead (2026-10-17). REVIEW_DIFF_MAX chars, 0 = never.
    # An advise review gives each part its own diff instead (image/fanout.mjs).
    local diff=""; [ "$kind" = advise ] || diff="$(git -C "$REPO" diff "$base" "$branch" -- "${pspec[@]}" 2>/dev/null)"
    if [ -n "$diff" ] && [ "${#diff}" -le "${REVIEW_DIFF_MAX:-30000}" ]; then
      echo; echo "## The diff (\`git diff $base..HEAD\`, already read for you)"; echo
      echo '````diff'; printf '%s\n' "$diff"; echo '````'
    fi
    [ -n "$focus" ] && { echo; echo "Focus especially on: $focus"; }
    echo
    echo "## Reminder: you are the reviewer"
    echo
    echo "Do not implement, fix or edit anything in the repository; the task above was the implementer's."
    echo "Review the change against it and end with the \`boxie-findings\` block (\`[]\` when nothing blocks)."
  } >"$body"
  # The spec reviewer (and review-both) is never the implementer's family: it gets its -alt role.
  local impl="" r var alt
  [ -f "$BOX/runs/$PROJECT/${branch#agent/}/summary.json" ] \
    && impl="$(sed -n 's/.*"model": *"\([^"]*\)".*/\1/p' "$BOX/runs/$PROJECT/${branch#agent/}/summary.json" | head -n 1)"
  local swapped="" b
  for r in ${roles//,/ }; do
    b="${r%%@*}"
    if [ -n "$impl" ] && { [ "$b" = review-spec ] || [ "$b" = review-both ]; }; then
      var="ROLE_${b//-/_}"; alt="${var}_alt"
      if [ "$(node "$(winpath "$BOX/lib/family.mjs")" use-alt "$impl" "${!var%% *}" "${!alt:-}")" = alt ]; then
        echo "boxie: $impl wrote this branch and $b is the same family: that review goes to $b-alt (${!alt%% *})" >&2
        r="$b-alt${r#"$b"}"; b="$b-alt"
      fi
    fi
    # --effort: a model whose effort is fixed (antigravity Claude) keeps its own, with a warning.
    # Advise parts read, they do not search: medium effort. On high, steps of 50-125 s were common.
    [ "$kind" = advise ] && [ -z "$effort" ] && [ -n "${REVIEW_PART_EFFORT:-medium}" ] && effort="${REVIEW_PART_EFFORT:-medium}"
    if [ -n "$effort" ] && [[ "$r" != *@* ]]; then
      if (role_model "$b" "$effort") 2>/dev/null; then r="$r@$effort"; else echo "boxie: $b keeps its own effort: $effort refused for its model" >&2; fi
    fi
    swapped="${swapped:+$swapped,}$r"
  done
  roles="$swapped"
  # Findings this project already accepted and rejected, as calibration (lib/examples.mjs). Read once,
  # so every reviewer of this round gets the same text; a ledger error never stops the review.
  local examples; examples="$(node "$(winpath "$BOX/lib/examples.mjs")" "$PROJECT" 2>/dev/null || true)"
  local names=() prompt prior
  for r in ${roles//,/ }; do
    case "${r%%@*}" in
      review-spec|review-spec-alt) prompt="$BOX/lib/ticket/review-spec.md"; prior="$prior_spec" ;;
      review-std) prompt="$BOX/lib/ticket/review-standards.md"; prior="$prior_std" ;;
      review-both*) prompt="$BOX/lib/ticket/review-both.md"; prior="$prior_both" ;;
      *) prompt=""; prior="" ;;
    esac
    [ "$kind" = advise ] && prompt="$BOX/lib/ticket/review-advise.md"
    {
      echo "---"; echo "files:"; git -C "$REPO" diff --name-only "$base" "$branch" -- "${pspec[@]}" | head -n 40 | sed 's/^/  - /'; echo "---"
      [ -n "$prompt" ] && cat "$prompt"
      [ -n "$examples" ] && { echo; printf '%s\n' "$examples"; }
      [ -n "$prior" ] && { echo; cat "$prior"; }
      cat "$body"
    } >"$tdir/task-${r/@/-}.md"
    local n="${prefix:-rv-$stamp}-${r%%@*}" rvar="ROLE_${r%%@*}"; rvar="${rvar//-/_}"
    # A role whose model is ocr:<model> runs open-code-review on the host (lib/ocr.mjs), no container.
    if [[ "${!rvar:-}" == ocr:* ]]; then
      local om="${!rvar%% *}"
      ocr_review "$n" "${om#ocr:}" "$r" "$base" "$branch" "$tdir/task-${r/@/-}.md" "$(printf '%s\n' "${pspec[@]}")" "$origin" "${specs[@]}" >"$BOX/runs/$PROJECT/.$n.log" 2>&1 &
    elif [ "$kind" = advise ]; then
      # REVIEW_PART_STEPS caps each part's session; open-code-review's groups used 31-98 tool calls a PR.
      BUNDLES_FILE="$bundles" REVIEW_SETUP=0 REVIEW_TARGET="$branch" "${SELF[@]}" run "$repo" "$tdir/task-${r/@/-}.md" --role "$r" --review --base "$branch" \
        --name "$n" --mode review --preamble advise --steps "${REVIEW_PART_STEPS:-30}" >"$BOX/runs/$PROJECT/.$n.log" 2>&1 &
    else
      REVIEW_TARGET="$branch" "${SELF[@]}" run "$repo" "$tdir/task-${r/@/-}.md" --role "$r" --review --base "$branch" --name "$n" --mode review ${REVIEW_STEPS:+--steps "$REVIEW_STEPS"} >"$BOX/runs/$PROJECT/.$n.log" 2>&1 &
    fi
    names+=("$n"); sleep 2
  done
  wait
  table "$BOX/runs/$PROJECT" "${names[@]}"
  local unfinished=0
  for n in "${names[@]}"; do
    echo; echo "################ $n"; cat "$BOX/runs/$PROJECT/$n/final.md" 2>/dev/null || echo "(no final message)"
    grep -q '^verdict review ' "$BOX/runs/$PROJECT/$n/verdict.txt" 2>/dev/null || unfinished=$((unfinished + 1))
  done
  # A review that did not finish exits 3: a script reading only the exit code logged two failed AACR-Bench
  # reviews (setup_failed, timeout) as success (2026-11-02).
  for n in "${names[@]}"; do echo "$n: $(cat "$BOX/runs/$PROJECT/$n/verdict.txt" 2>/dev/null || echo "no verdict")"; done
  # Several reviewers: one list, repeats merged (lib/merge-reviews.mjs). Merged independent passes
  # raise recall; the repeats would cost precision (research/review-tools-survey.md).
  if [ "${#names[@]}" -gt 1 ]; then
    local merged="$BOX/runs/$PROJECT/${prefix:-rv-$stamp}-merged.json" dirs=()
    for n in "${names[@]}"; do dirs+=("$(winpath "$BOX/runs/$PROJECT/$n")"); done
    node "$(winpath "$BOX/lib/merge-reviews.mjs")" "$(winpath "$merged")" "${dirs[@]}" && echo "merged findings: $merged"
  fi
  [ "$unfinished" = 0 ] || return 3
}

# Ledger: reasons and decisions. note labels why something failed; accept/reject/merged/discard record
# the orchestrator's decision on a run (the trust ledger). refs lists what still needs a reason.
cmd_note() {
  if [ $# -lt 2 ]; then
    echo "usage: note <repo-path> <run> (--refs a,b | --all) --cause CAUSE --why TEXT   (refs <repo-path> <run> lists the refs)"
    echo "causes: $(cd "$BOX" && node --input-type=module -e 'import { CAUSES } from "./lib/ledger.mjs"; console.log(CAUSES.join(", "))')"
    return 0
  fi
  local repo="$1" run="$2"; shift 2
  load_project "$repo"
  node "$(winpath "$BOX/lib/ledger.mjs")" note "$PROJECT" "$run" "$@"
}
cmd_outcome() {
  local result="$1" repo="$2" run="$3"; shift 3
  load_project "$repo"
  node "$(winpath "$BOX/lib/ledger.mjs")" outcome "$PROJECT" "$run" --result "$result" "$@"
}
cmd_refs() {
  load_project "$1"
  node "$(winpath "$BOX/lib/ledger.mjs")" refs "$PROJECT" "$2"
}

# The roles in effect for one project. boxie.conf is sourced first and the project file second, so
# a line there wins; "project" marks the settings it sets.
cmd_roles() {
  load_project "$1"
  local v src name
  for v in $(compgen -v | grep -E '^(ROLE_[A-Za-z0-9_]+|REVIEW_MODE|REVIEW_ROLES|READ_ONLY_ROLES|SCOUT_MODEL|TICKET_ESCALATE_ROLE|TICKET_ESCALATE_AFTER|LOOP_MAX_ROUNDS)$'); do
    src=conf; grep -qE "^(export[[:space:]]+)?$v=" "$PROJECT_ENV" && src=project
    name="$v"; [[ "$v" == ROLE_* ]] && { name="${v#ROLE_}"; name="${name//_/-}"; }
    printf '%-22s %-8s %s\n' "$name" "$src" "${!v}"
  done
}

# First-time project files from the repo's manifests (lib/setup.mjs); never overwrites one.
cmd_setup() {
  local repo="${1:?usage: setup <repo> [--dry-run] [--init-git]}"; shift
  # --init-git: a plain folder (contest solutions, scratch work) becomes a repo with one commit first.
  if [ "${1:-}" = --init-git ] || [ "${2:-}" = --init-git ]; then
    [ -d "$repo" ] || die "not a folder: $repo"
    if ! git -C "$repo" rev-parse --git-dir >/dev/null 2>&1; then
      git -C "$repo" init -q && git -C "$repo" add -A && git -C "$repo" commit -qm "Initial commit (boxie setup --init-git)"         && echo "boxie: $repo is a git repo now, one commit"
    fi
    set -- $(for a in "$@"; do [ "$a" = --init-git ] || echo "$a"; done)
  fi
  node "$(winpath "$BOX/lib/setup.mjs")" "$(winpath "$(cd "$(repo_path "$repo")" && pwd)")" "$@"
}

# Everything the project's .env sets (the OmniRoute key only as set/empty), its image and its caches.
cmd_config() {
  load_project "$1"
  local k state=built
  dk image inspect "$IMAGE" >/dev/null 2>&1 || state="not built: delegate.sh build $REPO"
  printf '%-22s %s\n' image "$IMAGE ($state)" caches "boxie-npm-cache ${CACHES:-}"
  for k in $(grep -oE '^(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*=' "$PROJECT_ENV" | sed -E 's/^export[[:space:]]+//; s/=$//' | sort -u); do
    if [ "$k" = OMNIROUTE_API_KEY ]; then printf '%-22s %s\n' "$k" "$([ -n "${!k:-}" ] && echo set || echo empty)"
    else printf '%-22s %s\n' "$k" "${!k-}"; fi
  done
}

# Read-only research: a worker answers one question about the code with file:line evidence, so the
# orchestrator reads a digest instead of the files. Follow up with `continue <repo> <run> -m ...`.
cmd_explore() {
  local repo="$1" question="$2"; shift 2
  local role="explore" name="" passthru=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --role) role="$2"; shift 2 ;;
      --name) name="$2"; shift 2 ;;
      *) passthru+=("$1"); shift ;;
    esac
  done
  load_project "$repo"
  [ -n "$name" ] || name="ex-$(date +%Y%m%d-%H%M%S)"
  local task="$BOX/runs/$PROJECT/.$name.md"
  mkdir -p "$BOX/runs/$PROJECT"
  printf '%s\n' "$question" >"$task"
  "${SELF[@]}" run "$repo" "$task" --role "$role" --review --preamble explore --mode explore --name "$name" "${passthru[@]}" >"$BOX/runs/$PROJECT/.$name.log" 2>&1 \
    || { tail -n 20 "$BOX/runs/$PROJECT/.$name.log"; die "explore run failed"; }
  local out="$BOX/runs/$PROJECT/$name"
  echo "== $name ($(jq -r '"\(.seconds)s"' "$out/summary.json" 2>/dev/null))"
  cat "$out/final.md" 2>/dev/null || echo "(no answer; see $out)"
}

# What a task leaves undecided or gets wrong against its docs, before anyone implements it: a read-only
# run on the task itself (so it gets the same context pack and issue text a worker would), DeepSeek by
# default (Opus quota stays for prose and spec reviews). RakunMiniItems #49: the task asked for a
# listener ADR 0003 gives to MythicLib; the review loop found it only after the implementation.
# Exit 0: nothing to decide; 4: questions, printed and in <run>/spec-questions.json.
cmd_spec_check() {
  local repo="$1" task="$2"; shift 2
  local role="review-spec-alt" name="" base="HEAD"
  while [ $# -gt 0 ]; do
    case "$1" in
      --role) role="$2"; shift 2 ;;
      --name) name="$2"; shift 2 ;;
      --base) base="$2"; shift 2 ;;
      *) die "unknown option $1" ;;
    esac
  done
  load_project "$repo"
  # A folder: the phase's tickets checked together (spec.md, issues/*.md, any *.md), for gaps and
  # contradictions between them, before any is published or run. One ticket at a time never sees those.
  if [ -d "$task" ]; then
    local set_files=() sf f; mapfile -t set_files < <(find "$task" -name '*.md' -type f | sort)
    [ ${#set_files[@]} -gt 0 ] || die "no .md files in $task"
    sf="$(scratch spec-set)"
    {
      echo "# Spec check of a whole ticket set (${#set_files[@]} files)"
      echo
      echo "These are the tickets of one phase, checked together before any is implemented. Besides each one's"
      echo "own gaps, find what lies between them: two tickets deciding the same thing differently, a ticket"
      echo "relying on what no ticket delivers, an order that cannot work, a doc or ADR one of them contradicts."
      echo "Name the tickets each point concerns."
      for f in "${set_files[@]}"; do echo; echo "## ${f#"$task"/}"; echo; cat "$f"; done
    } >"$sf"
    task="$sf"
  fi
  [ -f "$task" ] || die "task file not found: $task"
  [ -n "$name" ] || name="spec-$(date +%Y%m%d-%H%M%S)"
  local out="$BOX/runs/$PROJECT/$name" log="$BOX/runs/$PROJECT/.$name.log"
  SPEC_CHECK=0 BOXIE_PARK=0 "${SELF[@]}" run "$repo" "$task" --role "$role" --review --no-red --no-ask --steps 30 \
    --preamble speccheck --mode speccheck --name "$name" --base "$base" >"$log" 2>&1 \
    || { tail -n 20 "$log"; die "spec check run failed"; }
  node -e '
    const fs = require("fs"), [dir] = process.argv.slice(1);
    let t = ""; try { t = fs.readFileSync(dir + "/final.md", "utf8"); } catch {}
    const b = t.match(/```[^\n`]*?(?:\r?\n[ \t]*)?boxie-spec-questions[^\n]*\n([\s\S]*?)\n\s*```/);
    let q = null; try { q = b ? JSON.parse(b[1]) : null; } catch {}
    if (!Array.isArray(q)) { console.log("spec check: no readable boxie-spec-questions block; see " + dir + "/final.md"); process.exit(5); }
    fs.writeFileSync(dir + "/spec-questions.json", JSON.stringify(q, null, 2));
    if (!q.length) { console.log("spec check: nothing to decide"); process.exit(0); }
    console.log(`spec check: ${q.length} point(s) to rule on before implementing`);
    for (const x of q) console.log(`\n${x.id}. [${x.kind ?? "open"}] ${x.question}\n   ${(x.options ?? []).join("\n   ")}\n   recommend: ${x.recommend ?? "-"}\n   basis: ${x.basis ?? "-"}`);
    process.exit(4);
  ' "$(winpath "$out")"
}

# Different tasks in parallel, each its own worker and branch (concurrency capped by the slots).
cmd_batch() {
  local repo="$1"; shift
  local tasks=() passthru=()
  while [ $# -gt 0 ]; do
    case "$1" in
      *.md) tasks+=("$1"); shift ;;
      *) passthru+=("$1"); shift ;;
    esac
  done
  [ "${#tasks[@]}" -gt 0 ] || die "batch needs one or more task.md files"
  load_project "$repo"
  herdr_ok && herdr_ws >/dev/null
  local stamp names=() t n; stamp="$(date +%Y%m%d-%H%M%S)"
  local k=0
  for t in "${tasks[@]}"; do
    # The index keeps two spec.md files (or names alike in their first 30 characters) apart.
    k=$((k + 1)); n="b$stamp-$k-$(basename "$t" .md | tr -c 'a-zA-Z0-9\n' '-' | cut -c1-30)"
    "${SELF[@]}" run "$repo" "$t" --name "$n" "${passthru[@]}" >"$BOX/runs/$PROJECT/.$n.log" 2>&1 &
    names+=("$n"); sleep 2
  done
  wait
  table "$BOX/runs/$PROJECT" "${names[@]}"
}

# Single-pass advisor: debate, critique or brainstorm with another model. No container, no tools.
# Several advisors from different families on one question, in parallel, then one merged digest.
# RakunLoots P10 (2026-10-26): an Opus plan took fixes from DeepSeek and Gemini, and Codex still found a
# gap in it; one advisor misses what three catch. Members in COUNCIL_ASK_ONLY answer single-pass (no
# tools; empty by default: cx/gpt-6.1-sol calls tools through OpenCode, 2026-10-28); the rest are read-only
# runs that read the repo to check the plan's claims. COUNCIL_MERGE writes the digest.
# A tool member's answer from run <run> into <base>.md, or <base>.short.md when under COUNCIL_MIN_ANSWER
# characters (lib/council.mjs: the report, not a closing offer after it).
member_answer() {
  local rc=0
  rm -f "$2.md" "$2.short.md"
  node "$(winpath "$BOX/lib/council.mjs")" answer "$(winpath "$BOX/runs/$PROJECT/$1")" "$(winpath "$2.md")" "${COUNCIL_MIN_ANSWER:-1000}" || rc=$?
  [ "$rc" != 3 ] || mv "$2.md" "$2.short.md"
  return 0
}
cmd_council() {
  local repo="$1"; shift
  local prompt="" members="" name="" eff="" merge="" files=() f withbox=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --prompt) prompt="$2"; shift 2 ;;
      --file) [ -f "$2" ] || die "no such file $2"; files+=("$2"); shift 2 ;;
      --members) members="${2//,/ }"; shift 2 ;;
      --name) name="$2"; shift 2 ;;
      --effort) eff="$2"; shift 2 ;;
      --merge) merge="$2"; shift 2 ;;
      --with-box) withbox=1; shift ;;
      *) die "unknown option $1" ;;
    esac
  done
  [ -f "$prompt" ] || die "council needs --prompt FILE"
  load_project "$repo"; need_key
  members="${members:-${COUNCIL:-advise advise-gemini advise-deepseek}}"
  [ -n "$name" ] || name="council-$(date +%Y%m%d-%H%M%S)"
  local dir="$BOX/runs/$PROJECT/_council/$name"; mkdir -p "$dir"
  cp "$prompt" "$dir/prompt.md"
  # --with-box: Boxie's own tracked source goes into each tool member's clone at .boxie-ref/. Lykos P18
  # (2026-10-28): members reported lib/*.mjs and docs/known-gaps.md absent, so claims about Boxie went unchecked.
  local ref=()
  if [ "$withbox" = 1 ]; then
    rm -rf "$dir/boxie-ref"; mkdir -p "$dir/boxie-ref"
    (cd "$BOX" && git ls-files -z lib docs image claude-skill delegate.sh boxie.conf | tar --null -T - -cf -) | tar -xf - -C "$dir/boxie-ref" \
      || die "could not copy Boxie's source for --with-box"
    ref=(--ref "$dir/boxie-ref")
  fi
  herdr_ok && herdr_ws >/dev/null
  # The tool members' task: the question and the attached files inline (a plan file is often uncommitted,
  # so the run's clone would not have it).
  {
    echo "# Advise the orchestrator"
    echo
    echo "You are one of several independent advisors from different model families. Do not implement."
    echo "Check every claim the material makes about this repository against the code: paths, functions,"
    echo "existing behaviour, what the docs and ADRs already decide. Find what is wrong, missing or inconsistent."
    echo
    echo "Answer: your recommendation first; then every gap, inconsistency or wrong premise, each with a"
    echo "severity (critical, high, medium, low) and \`path:line\` evidence; then the strongest argument"
    echo "against your recommendation; then what you did not verify."
    echo "Your last message is your whole answer: write the full report there, not a question or an offer."
    [ "$withbox" = 0 ] || { echo; echo "Boxie's own source (lib/, docs/, image/, claude-skill/, delegate.sh, boxie.conf) is at \`.boxie-ref/\`"; echo "in your clone, to check claims about Boxie. It is reference only: not part of this repository."; }
    echo; echo "## The question"; echo; cat "$prompt"
    for f in "${files[@]}"; do echo; echo "## Attached: $f"; echo; echo '````'; head -c 60000 "$f"; echo; echo '````'; done
  } >"$dir/task.md"
  local m b names=()
  for m in $members; do
    b="${m%%@*}"
    if [[ " ${COUNCIL_ASK_ONLY-advise} " == *" $b "* ]]; then
      local fa=(); for f in "${files[@]}"; do fa+=(--file "$f"); done
      "${SELF[@]}" ask "$repo" --role "$m" ${eff:+--effort "$eff"} --prompt "$dir/task.md" >"$dir/$b.md" 2>"$dir/$b.log" &
    else
      ( BOXIE_PARK=0 "${SELF[@]}" run "$repo" "$dir/task.md" --role "$m" ${eff:+--effort "$eff"} --review --no-ask --no-red \
          --preamble explore --mode council --name "$name-$b" --steps "${COUNCIL_STEPS:-60}" "${ref[@]}" >"$dir/$b.log" 2>&1
        member_answer "$name-$b" "$dir/$b" ) &
    fi
    names+=("$b"); sleep 2
  done
  wait
  # A tool member that died without a word, or answered under COUNCIL_MIN_ANSWER characters, gets one more
  # try, alone. A short answer stands when the retry gives nothing longer.
  for m in $members; do
    b="${m%%@*}"
    [[ " ${COUNCIL_ASK_ONLY-advise} " == *" $b "* ]] || [ -s "$dir/$b.md" ] || {
      echo "council: $b gave $([ -s "$dir/$b.short.md" ] && echo "only a short answer" || echo "no answer"); trying once more" >&2
      cp "$dir/$b.short.md" "$dir/$b.first.md" 2>/dev/null || true
      BOXIE_PARK=0 "${SELF[@]}" run "$repo" "$dir/task.md" --role "$m" ${eff:+--effort "$eff"} --review --no-ask --no-red \
        --preamble explore --mode council --name "$name-$b-2" --steps "${COUNCIL_STEPS:-60}" "${ref[@]}" >>"$dir/$b.log" 2>&1 || true
      member_answer "$name-$b-2" "$dir/$b"
      if [ ! -s "$dir/$b.md" ]; then
        # Neither try reached the floor: the longer short answer stands.
        f="$dir/$b.short.md"; [ "$(wc -c <"$dir/$b.first.md" 2>/dev/null || echo 0)" -gt "$(wc -c <"$f" 2>/dev/null || echo 0)" ] && f="$dir/$b.first.md"
        [ ! -s "$f" ] || { echo "council: $b's answer is short; kept as it is" >&2; cp "$f" "$dir/$b.md"; }
      fi
      rm -f "$dir/$b.first.md"
    }
  done
  local answers=() n
  for n in "${names[@]}"; do
    if [ -s "$dir/$n.md" ]; then answers+=("$dir/$n.md"); echo "council: $n answered ($dir/$n.md)"
    else echo "council: $n gave no answer; see $dir/$n.log" >&2; fi
  done
  [ ${#answers[@]} -gt 0 ] || die "no council member answered"
  {
    echo "Merge these ${#answers[@]} independent advisors' answers to the question below into one digest."
    echo "Sections: ## Agreed (two or more advisors), ## Unique (one advisor), ## Contradicting (each side)."
    echo "Tag every item with its advisors in brackets, by file name: [advise], [advise-gemini]."
    echo "Keep every critical, high and medium item, with its evidence. Drop nothing for being unique:"
    echo "a gap only one advisor saw is the reason for asking several. End with ## Recommendation."
    echo
    echo "Be impartial. You may be the same model as one of the advisors: give its answer no more weight"
    echo "than the others, and never side with an answer for its model, its length or its confidence."
    echo "Weigh each claim by its evidence alone (a cited path:line beats an assertion). In ## Contradicting,"
    echo "state each side as its advisor argued it, then name which side the evidence supports, or say it"
    echo "is undecided. The recommendation follows the evidence, not the majority."
    echo; echo "## The question"; echo; cat "$prompt"
  } >"$dir/merge-prompt.md"
  local fa=(); for f in "${answers[@]}"; do fa+=(--file "$f"); done
  # The merger: a role, or a model id (it has a slash). Single-pass: it only reads the answers.
  merge="${merge:-${COUNCIL_MERGE:-merge}}"
  local mergeby=(--role "$merge"); [[ "$merge" == */* ]] && mergeby=(--model "$merge")
  "${SELF[@]}" ask "$repo" "${mergeby[@]}" --prompt "$dir/merge-prompt.md" "${fa[@]}" >"$dir/digest.md" 2>"$dir/merge.log" \
    || {
      # The members' work stays in digest.md, under their names. Lykos P18 (2026-10-28): five merges failed
      # and left an empty digest, the reports only in the member files.
      { echo "# Council $name: the merge failed"; echo
        echo "The merger ($merge) failed: $(tail -n 3 "$dir/merge.log" | tr -d '\r' | head -c 600)"
        echo; echo "Below are the ${#answers[@]} members' answers as they gave them, not merged."
        for f in "${answers[@]}"; do echo; echo "## ${f##*/}"; echo; cat "$f"; done; } >"$dir/digest.md"
      echo "council: the merge failed ($dir/merge.log); digest.md holds the answers unmerged: $dir/digest.md" >&2
      return 1
    }
  echo; cat "$dir/digest.md"; echo; echo "council: digest $dir/digest.md"
}

cmd_ask() {
  local repo="$1"; shift
  local role="advise" model="" prompt="-" files=() eff=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --role) role="$2"; shift 2 ;;
      --model) model="$2"; shift 2 ;;
      --effort) eff="$2"; shift 2 ;;
      --prompt) prompt="$2"; shift 2 ;;
      --file) files+=("$(winpath "$2")"); shift 2 ;;
      *) die "unknown option $1" ;;
    esac
  done
  load_project "$repo"; need_key
  if [ -z "$model" ]; then role_model "$role" "$eff"; else MODEL="$model" EFFORT=""; [ -z "$eff" ] || set_effort "$eff"; fi
  model="$MODEL"; role="${role%%@*}"
  [[ "$model" != opencode/* ]] || die "$model is OpenCode's own provider: it answers only inside a run, not in ask"
  mkdir -p "$BOX/runs/$PROJECT/ask"
  local out; out="$BOX/runs/$PROJECT/ask/$(date +%Y%m%d-%H%M%S)-$role.md"
  [ "$prompt" = - ] || prompt="$(winpath "$prompt")"
  OMNIROUTE_HOST_URL="$OMNIROUTE_HOST_URL" EFFORT="${EFFORT:-}" \
    node "$(winpath "$BOX/lib/ask.mjs")" "$model" "$prompt" "$(winpath "$out")" "${files[@]}"
}

# A command given fewer arguments than its usage line names prints that usage and exits 2. Lykos P18
# (2026-10-28): `council` alone died with "$1: unbound variable".
usage_of() { usage | awk -v c="$1" 'index($0, "  " c " ") == 1 { p = 1; print; next } p && /^ {20,}/ { print; next } p { exit }'; }
check_args() {
  local c="$1" n="$2" want="${3:-}" t toks=() words=()
  if [ -z "$want" ]; then
    want=0; read -ra toks <<<"$(usage_of "$c" | head -n 1)"; read -ra words <<<"$c"
    for t in "${toks[@]:${#words[@]}}"; do case "$t" in "<"*) want=$((want + 1)) ;; *) break ;; esac; done
  fi
  [ "$n" -ge "$want" ] && return 0
  { usage_of "$c" | grep . || echo "usage: delegate.sh $c: needs $want argument(s), see docs/commands.md"; } >&2
  exit 2
}
case "${1:-}" in
  ticket|feature|defect|hunt) check_args "$1" $(($# - 1)) 2 ;;
  ticket-review|land|batch) check_args "$1" $(($# - 1)) 1 ;;
  # No usage line to count from: `accept` alone died with "$2: unbound variable".
  note|refs|accept|reject|merged|discard|explore|check) check_args "$1" $(($# - 1)) 2 ;;
  loop) if [ "${2:-}" = resume ]; then check_args "loop resume" $(($# - 2)); else check_args loop $(($# - 1)); fi ;;
  ?*) check_args "$1" $(($# - 1)) ;;
esac
case "${1:-}" in
  build) shift; cmd_build "$@" ;;
  ask) shift; cmd_ask "$@" ;;
  council) shift; cmd_council "$@" ;;
  phase-review) shift; node "$(winpath "$BOX/lib/phase.mjs")" review "$(winpath "$(cd "$(repo_path "${1:?usage: phase-review <repo> --base REF}")" && pwd)")" "${@:2}" ;;
  phase-close) shift; node "$(winpath "$BOX/lib/phase.mjs")" close "$(winpath "$(cd "$(repo_path "${1:?usage: phase-close <repo> --base REF}")" && pwd)")" "${@:2}" ;;
  status) shift; node "$(winpath "$BOX/lib/phase.mjs")" status "$(winpath "$(cd "$(repo_path "${1:?usage: status <repo>}")" && pwd)")" ;;
  fanout) shift; cmd_fanout "$@" ;;
  review) shift; cmd_review "$@" ;;
  models) shift; cmd_models "$@" ;;
  baseline) shift; cmd_baseline "$@" ;;
  run) shift; cmd_run "$@" ;;
  continue) shift; cmd_continue "$@" ;;
  questions) shift; cmd_questions "$@" ;;
  watch) shift; cmd_watch "$@" ;;
  loop-watch) shift; cmd_loop_watch "$@" ;;
  loop-tab) shift; cmd_loop_tab "$@" ;;
  answer) shift; cmd_answer "$@" ;;
  wait) shift; cmd_wait "$@" ;;
  show) shift; cmd_show "$@" ;;
  tui) shift; cmd_tui "$@" ;;
  note) shift; cmd_note "$@" ;;
  refs) shift; cmd_refs "$@" ;;
  roles) shift; cmd_roles "$@" ;;
  config) shift; cmd_config "$@" ;;
  setup) shift; cmd_setup "$@" ;;
  accept) shift; cmd_outcome accepted "$@" ;;
  reject) shift; cmd_outcome rejected "$@" ;;
  merged) shift; cmd_outcome merged "$@" ;;
  discard) shift; cmd_outcome discarded "$@" ;;
  explore) shift; cmd_explore "$@" ;;
  batch) shift; cmd_batch "$@" ;;
  check) shift; cmd_check "$@" ;;
  ticket) shift; repo="$1" t="$2"; shift 2; cmd_ticket_js run "$repo" "$(winpath "$t")" "$@" ;;
  ticket-review) shift; cmd_ticket_js review "$@" ;;
  land) shift; cmd_ticket_js land "$@" ;;
  feature) shift; repo="$1" f="$2" sub="${3:-status}"; shift 2; [ $# -gt 0 ] && shift
    case "$sub" in run) sub=run-feature ;; esac
    cmd_ticket_js "$sub" "$repo" "$(winpath "$f")" "$@" ;;
  defect) shift; repo="$1" f="$2"; shift 2; cmd_ticket_js defect "$repo" "$(winpath "$f")" "$@" ;;
  hunt) shift; repo="$1" f="$2"; shift 2; cmd_ticket_js hunt "$repo" "$(winpath "$f")" "$@" ;;
  loop) shift; sub=(); [ "${1:-}" = resume ] && { sub=(resume); shift; }
    repo="$1"; shift; node "$(winpath "$BOX/lib/loop.mjs")" "${sub[@]}" "$(winpath "$(cd "$(repo_path "$repo")" && pwd)")" "$@" ;;
  stats) shift; node "$(winpath "$BOX/lib/stats.mjs")" "$@" ;;
  install-skill) shift
    # The Claude Code skill with this clone's path written in (claude-skill/boxie/SKILL.md).
    dest="${1:-$HOME/.claude/skills/boxie}"; mkdir -p "$dest"
    sed "s#<boxie>#$(cd "$BOX" && pwd -W 2>/dev/null || pwd)#g" "$BOX/claude-skill/boxie/SKILL.md" >"$dest/SKILL.md"
    echo "boxie: skill installed at $dest/SKILL.md" ;;
  doctor) shift
    if [ -n "${1:-}" ]; then load_project "$1"; else OMNIROUTE_BASE_URL="${OMNIROUTE_BASE_URL:-http://host.docker.internal:20128/v1}"; fi
    AB_BASH="$BASH_VERSION" AB_ENGINE="$ENGINE" AB_IMAGE="$IMAGE" AB_BASE_IMAGE="$BASE_IMAGE" AB_BOX="$(winpath "$BOX")" \
      AB_PROJECT_ENV="${PROJECT_ENV:-}" AB_REPO="${REPO:-}" AB_HOST_IP="$(host_address)" AB_NETWORK="${BOXIE_NETWORK:-}" \
      AB_SLOTS="${BOXIE_SLOTS:-4}" AB_MEMORY="${MEMORY:-8g}" AB_OVERCOMMIT="${MEMORY_OVERCOMMIT:-1.5}" OMNIROUTE_API_KEY="${OMNIROUTE_API_KEY:-}" \
      OMNIROUTE_HOST_URL="${OMNIROUTE_HOST_URL:-http://localhost:20128/v1}" OMNIROUTE_BASE_URL="$OMNIROUTE_BASE_URL" OCR_BIN="${OCR_BIN:-}" \
      node "$(winpath "$BOX/lib/doctor.mjs")" ;;
  gc) shift; cmd_gc "$@" ;;
  bench) shift; BOXIE_REPOS="${BOXIE_REPOS:-}" node "$(winpath "$BOX/lib/bench.mjs")" "$@" ;;
  dash) shift; node "$(winpath "$BOX/lib/stats.mjs")" tui "$@" ;;
  clean) shift; cmd_clean "$@" ;;
  stop) shift; cmd_stop "$@" ;;
  unpark) shift; cmd_unpark "$@" ;;
  spec-check) shift; cmd_spec_check "$@" ;;
  ""|help|-h|--help) usage ;;
  *) usage; echo; die "unknown command $1" ;;
esac
