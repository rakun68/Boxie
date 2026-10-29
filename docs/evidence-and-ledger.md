# Evidence and the ledger

Back to the [README](../README.md).

## Evidence per run

`lib/checks.mjs` computes on the host, from git and the run's files: `SEALED-EDIT`, `OUT-OF-SCOPE`
(changed files outside `files:`, `scope:` and their tests), `MISREPORT` (the worker's report block
claims passing tests and the harness's run failed), `WEAK-SPEC` (the sealed tests already passed on
the base; the container stops before the agent), `STAND-IN` (added skip/only/TODO), `SENSITIVE`
(dependencies, CI, build scripts, deletions), `LEFTOVERS`, `REVIEW-EDIT`. The run gets a verdict and
one `next` token (`review_or_accept`, `inspect_flags`, `continue_with_failure`, `answer_question`,
`fix_sealed_test`, `triage_findings`, ...) in `summary.json`, and one line in the ledger.

Inside the container: a red check runs the sealed tests before the worker (frontmatter `red: false`
skips it); a plugin parses every file the worker edits and puts any syntax error into that tool's
result; when the harness's tests fail after a worker that finished normally, one automatic fix round
resumes the same session with the failing tail (`--no-autofix`, `--autofix N`). `exits.first_test` in
the ledger keeps the result before that round, so rescued runs are counted apart. `steps: N` in the
frontmatter is a step budget.

Each run leaves `runs/<project>/<name>/`: `summary.json` (setup/agent/test exit codes, commits,
`blocked`, `sealed_violation`, `review_violation`), `final.md` (the worker's last message),
`prompt.md` (exactly what it was given), `context.md`, `test.log`, `events.jsonl`. The worker's message
is a claim; `test_exit`, the flags and the diff are evidence.

## The ledger and the dashboard

`ledger/events.jsonl` (schema: [ledger.md](ledger.md)): every run, review, label, outcome,
ticket test gate, landing and benchmark result, with the harness version (content hash of `image/`,
`lib/pack.mjs`, `lib/checks.mjs`). Obvious causes are labelled automatically; the orchestrator labels
the rest with `note` and records each decision with `accept`/`reject`, which is the trust record per
model. `stats` and `dash` (Node, no dependencies) show it: KPIs with deltas against the previous
window, models (pass, first-try pass, rescue rate, seconds per step, cache hit, flags per run, accepted),
flags and causes with trends, reviews (confirmed and false-positive rates), the benchmark matrix,
harness versions side by side, and live cards for running workers.
