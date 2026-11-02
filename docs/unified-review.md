# One advisory review pipeline

`delegate.sh review <repo> <branch> --advise` prepares one set of bundles, reviews each part once,
validates the candidates, and emits one report. It borrows OCR's deterministic preparation, rules,
bounded contexts and quote-based placement; it does not run an OCR review beside Boxie's review.
Gate reviews and the reproduction-based fix loop keep their existing behavior.

## Execution

1. Resolve base/head to commit IDs and prepare file groups, diffs and language rules once.
   Advisory mode defaults to one `review-both` role; explicit role/mode overrides remain supported.
2. Each part runs in one OpenCode session in the disposable container. Reviewers check assigned files
   and both sides of changed contracts, including callers owned by other parts. They use the native
   `review_report` tool after each file to save new findings and completed files under
   `/out/review-state/`. They do not resend saved findings in a final response.
3. Each finding can cite up to four `{file, line}` evidence references. The harness captures bounded
   source windows from inside the repository, rejecting traversal and out-of-repository symlinks.
   This carries evidence into validation without another agent searching the repository.
4. Anchor quotes where they match uniquely, then deduplicate candidates with the same helper used by
   offline comparisons. Sharing one quoted line is insufficient to merge different problems. Repeated
   identical diagnoses backed by the same external definition retain their fix sites in `locations`.
5. Validate each remaining candidate once against its changed-code window and captured evidence.
   Groups of eight run with at most three validation requests concurrently, at low reasoning effort,
   sharing one two-minute wall-clock deadline including queued batches.
   This checks candidates; it does not perform another full review. No call is made for an empty list.
6. Emit `findings.json`, `filtered.json`, `final.md` and `fanout.json`. The host records coverage in
   `summary.json`. A partial review cannot produce a clean ledger review event.

## What the labels mean

- `location_status: anchored`: the quoted code matched one location. `unverified` means no unique
  match was established; the proposed line remains available for manual inspection.
- `verification: supported`: validation score 6–10, supported by supplied code. This is **not** an
  executed reproduction. `plausible` is score 3–5; `rejected` is 0–2. The default report threshold is 6;
  withheld candidates and reasons remain in `filtered.json`. `REVIEW_FILTER_MIN=3` restores the older
  recall-oriented threshold.
- `verification: unverified`: filtering was disabled, unavailable, failed, or omitted that candidate.
  These candidates remain visible, with their status, rather than disappearing on provider failure.
- Coverage `complete`: every part exited normally and explicitly completed its assigned files, or a
  legacy reviewer returned a readable findings list. `partial`: some structured results were saved,
  but at least one part did not finish. `failed`: no part produced readable results. An empty change
  is complete. Partial/failed runs exit nonzero; useful findings remain available.

Timeout checkpoints remove the need for a report-only model turn on the normal structured path.
Older reviewers without the tool retain their fenced-block recovery path. A recovered report from a
timed-out reviewer remains partial. The harness never claims that output recovery completed coverage.

## Frozen surfaces and reuse

At OpenCode server boot, the native tool schema and prepared bundle assignment/diffs are frozen.
Language rules and the shared task/context are prepared once for the run. Per-part sessions retain
their own append-only conversation. Candidate-validation requests share a fixed system rubric; their
code windows and evidence vary. No provider cache-hit rate or latency gain is assumed from this.

The installed OpenCode plugin API was checked in the worker image (`tool`, Zod argument schemas,
`ToolContext.sessionID`). Using it avoids another MCP server, LLM client, or review engine. Boxie owns
coverage, source confinement, artifact durability and validation policy. OCR remains an optional
no-model rule provider and a separate benchmark comparator, not a second production review stage.

## Validation

Tests cover durable checkpoints, completion, ownership, bounded evidence, ambiguous locations,
independent findings on the same line, failed validation and bounded request concurrency. Replay
historical prompt sizes with `node bench/review-filter.mjs <run-dir> <bundles-full.json>`.
Prompt characters measure input size only; end-to-end speed and finding quality require live runs.

### Development measurements (2026-11-03)

One live smoke review used the existing AACR vLLM PR `vllm-project__vllm@134705b`, with the same
effective reviewer model as the saved baseline (`antigravity/gemini-3.8-flash-medium`). No OCR review
was run. All five parts explicitly completed; the harness reported no repository modifications.

| Measurement | Saved advise baseline | Unified live review |
| --- | ---: | ---: |
| Host command wall time | 311.49 s | 133.71 s |
| Container total time | 298 s | 106 s |
| Generated comments before the final deduplication adjustment | 2 | 2 |
| Reference issues covered | 1 of 8 | 1 of 8 |

This is one historical-baseline comparison, not repeated trials or a controlled attribution of the
speed gain. The judge was `antigravity/gemini-3.8-flash-high` through the existing AACR scorer.

The live output exposed identical diagnoses at lines 217 and 242 of `vllm/multimodal/profiling.py`,
backed by the same logger definition. Replaying those saved findings through the final deduplicator
produced one finding retaining both locations. No reviewer or candidate validator ran again. A new
judge evaluation matched that finding: precision 1/1, recall 1/8, F1 0.222 versus 0.200 before
deduplication. This single finding cannot establish general accuracy. The replay result inherits
the live run's duration; it is not a separately timed full run of the final revision.

Replaying the historical vLLM candidates through the prompt-size benchmark reduced user-message
characters from 6,861 to 4,437. Historical findings lack the new captured evidence, so this measures
changed-code selection only, not total live tokens, cost or latency.

Local evidence (gitignored):

- `runs/vllm-project__vllm/aacr-unified-134705b-review-both-gemini/`: checkpoints, source evidence,
  per-part events, completion metadata and harness summary.
- `runs/.tmp/aacr/aacr-bench/evaluation/results/sample5/boxie/unified/`: live result and judge metrics.
- The sibling `unified-dedup/`: deterministic replay result, both locations and its judge metrics.
- `runs/.tmp/unified-tests-final.log`: host suite output; the container-only spec-gate tests also
  passed in the built worker image.

The remaining benchmark PRs, repeated speed trials and performance on other models are unmeasured.
