# Boxie review: progress, remaining gaps, and outside tools

Research date: 2026-11-03. Source snapshot: Boxie HEAD `2dafae6`. Research only: no tools installed, no paid reviews launched, no product code changed. External capabilities below are documented features or vendor descriptions, not independently measured advantages over Boxie.

This is the preimplementation assessment. Subsequent changes and development measurements are in
[the unified review pipeline](../docs/unified-review.md).

## What improved

The latest five-PR rerun in [docs/aacr-bench.md](../docs/aacr-bench.md) is the relevant comparison; the initial failure report in `docs/review-improvement-brief.md` is historical.

| Metric | Original Boxie | Boxie advise rerun | OCR original baseline |
| --- | ---: | ---: | ---: |
| Precision | 0.286 | 0.571 | 0.524 |
| Recall | 0.067 | 0.200 | 0.200 |
| F1 | 0.109 | 0.296 | 0.290 |
| Average seconds | 1,180 | 450 | 220 |

These are five PRs reviewed with the same model and judge. The tiny F1 lead is not evidence that Boxie beats OCR generally. OCR was not rerun. The measured improvement comes from the whole set of changes, not a controlled ablation of each one.

The checked local scorer artifact `metrics_ocr_20261102_202638.json` records 5 PRs, 60 reference issues, 21 generated comments, 12 matched comments, F1 0.296, and 450.37 seconds average. This supersedes the old survey's pre-rerun opening comparison.

Concrete changes include skipping dependency setup for reviews; bounded review steps; parallel parts targeting three files (atomic groups and the bundle-count cap can exceed this target); one shared OpenCode server to avoid database locking; recovery of the final findings from session storage; medium effort for parts and low effort for the filter; maintainability/performance feedback through advise mode; merging and deduplicating output; and recording benchmark verdicts and token usage. Sources: [image/fanout.mjs](../image/fanout.mjs), [image/filter.mjs](../image/filter.mjs), [lib/ticket/review-advise.md](../lib/ticket/review-advise.md), [lib/merge-reviews.mjs](../lib/merge-reviews.mjs), [bench/aacr/boxie_arm.py](../bench/aacr/boxie_arm.py), and the rerun report.

All five PRs emitted aggregate output, but that does **not** mean complete coverage: cline still lost one of six parts to timeout with no readable findings. Both tools covered none of React's 16 reference issues. Boxie still covered none of mpv's eight. OCR remains roughly twice as fast on this sample.

## Outside tools and the capability Boxie could borrow

### PR-Agent / Qodo

PR-Agent documents parallel chunk calls, suggestion scoring, configurable score thresholds, persistent inline fingerprints, and a coverage footer identifying failed chunks or omitted files. Its configuration also exposes the score assigned when reflection fails, explicitly allowing teams to drop unvetted suggestions. These are especially relevant to Boxie's missing-part reporting and filter failure policy. Qodo's hosted offering and PR-Agent should be evaluated separately; a feature in one should not automatically be attributed to the other. [PR-Agent configuration reference](https://docs.pr-agent.ai/usage-guide/configuration_reference/).

**Boxie already has:** parallel parts, score-based filtering, local output, normalized findings and a merge helper. **The gap:** complete coverage accounting in the final result; stable identities across review reruns; an explicit unverified state when filtering fails. Borrow these small contracts rather than replacing the execution harness.

### CodeRabbit

CodeRabbit documents persistent learnings associated with repositories, file paths and users, with usage information, editing, deletion, export, and optional approval delay. Its guidance distinguishes recurring team preferences from one-off exceptions and warns about conflicting or stale learnings. [CodeRabbit learnings documentation](https://docs.coderabbit.ai/knowledge-base/learnings).

Its current review product describes code graph context, sandbox reproductions for selected findings, suggested fixes and pre-merge checks. Those are product claims, not a public comparison showing it is more accurate than Boxie. [CodeRabbit review product](https://www.coderabbit.ai/review).

**Boxie already has:** project context, rules, independent reviewer roles, and executable reproduction verification in its loop. **The gap:** a feedback trail distinguishing correct, incorrect, intentional and obsolete review comments across runs. A small explicit decisions file would be enough initially; no dashboard or vector database is needed. Preserve the reason for a dismissal and its scope, rather than teaching the reviewer that all similar-looking code is safe.

### Greptile

Greptile describes graph indexing of functions/classes/dependencies and repository-wide impact analysis; its overview also documents passing findings to coding agents with paths and suggested changes. Index completeness and accuracy improvements are vendor claims, not locally validated properties. [Greptile overview](https://www.greptile.com/docs/introduction).

Its changelog documents directory-scoped rules/context files, related repositories, hypothesis-scoped parallel reviewers, static scanning plus AI security review, and TREX tests run in sandboxes with artifacts on findings. These are useful architectural ideas; the changelog's performance numbers are vendor results on a different workload and are not comparable to AACR. [Greptile changelog](https://www.greptile.com/changelog).

**Boxie already has:** repository reading and context packing; it does not lack all cross-file reasoning. **The gap:** reliably including callers, consumers, schemas and contracts across partition boundaries. First add a bounded cross-part contract pass or symbol-reference context. Test that on the missed React/mpv cases before building a persistent graph service. Its targeted-test approach supports extending Boxie's existing verification to selected high-impact advise findings.

### reviewdog

reviewdog is a publishing and filtering tool, not an AI reviewer. It accepts diagnostic formats including RDJSON and SARIF, filters by diff, and posts GitHub/GitLab comments and suggestions. Reporter capabilities differ; the default added-lines filter can hide findings on unchanged lines of changed files. [reviewdog source and README](https://github.com/reviewdog/reviewdog).

**Boxie's gap:** a standard diagnostic interchange and ready-made provider publishing. If inline PR reviews become a requirement, adopt reviewdog through a small findings exporter instead of writing GitHub/GitLab comment placement. Keep export read-only by default and publishing explicit. This improves delivery, not detection quality.

### Semgrep and GitHub CodeQL

Semgrep offers deterministic rules and taint analysis. Its documentation distinguishes per-file Community Edition analysis from proprietary cross-file analysis; assuming all Semgrep editions have interfile analysis would be wrong. [Semgrep analysis glossary](https://semgrep.dev/docs/writing-rules/glossary). Diff-aware CI scanning is also documented. [Semgrep CI configuration](https://semgrep.dev/docs/semgrep-ci/sample-ci-configs).

CodeQL represents code in databases and runs queries to identify security problems; it supports default, advanced and external-CI setup. Private-repository availability has product requirements. [GitHub CodeQL documentation](https://docs.github.com/en/code-security/concepts/code-scanning/codeql/codeql-code-scanning). External tools can upload SARIF to GitHub where supported. [GitHub external CI documentation](https://docs.github.com/en/code-security/how-tos/find-and-fix-code-vulnerabilities/integrate-with-existing-tools/use-with-existing-ci-system).

**Boxie already has:** arbitrary check/test commands, so running a scanner is possible today. **The gap:** a first-class scanner-results channel with rule IDs, locations, provenance and deduplication against AI findings. Start with an available scanner appropriate to the target language; do not add every scanner. For Boxie's own Bash and Node code, compiler/linter checks and targeted shell checks complement logical review. Static warnings are not automatically proven exploits.

## What to improve next

1. **Make incomplete review impossible to mistake for clean review.** Record each part's files, state, timeout, readable-result status and whether its findings were recovered. Distinguish `complete`, `partial` and `failed`; a usable findings list can accompany a partial result. Require an explicit empty list for a successfully reviewed part. `image/fanout.mjs` currently counts unreadable parts but only treats cut-and-unreadable as timeout; successful exit without a readable block can still disappear into an aggregate empty list. PR-Agent's coverage footer is the useful precedent.

2. **Separate plausible findings from verified findings.** `image/filter.mjs` sees the diff, not the repository. Scores 3-5 explicitly mean plausible but unproven; the default threshold of 3 retains them. Failed calls and missing scores preserve candidates. That is a valid recall-oriented advise policy, but it must not be called proof. Retain a verification status, and use a bounded repo-reading verifier for selected defect/security candidates. Preserve failed-filter output as unverified rather than suppressing it silently or treating it as confirmation.

3. **Improve context across partitions.** File-count groups are a speed optimization, not a correctness boundary. Include direct callers/contracts across groups and run a small cross-group consistency pass when an API, state model or schema changes. Measure its additional findings and latency against the existing pipeline. A graph database is not the first implementation.

4. **Use stronger finding identities and location evidence.** Fanout deduplication uses opening words and nearby lines; the offline merger uses word overlap and nearby lines. Neither identifies root causes reliably. Start with consistent normalized records and explicit provenance; verify the quoted code maps unambiguously to head. Unmatched quotes should not silently imply verified line numbers. Then add stable IDs for reruns and scoped decisions. Avoid automatically merging different issues merely because they occur close together.

5. **Reuse the evidence machinery Boxie already owns.** `lib/verify.mjs` and `lib/loop.mjs` already rerun reproductions in containers, compare base/head behavior, retain proofs and detect reopened regressions. Extend this selectively to advise output; do not rebuild a second verifier or claim Boxie lacks a finding lifecycle. Preserve container confinement. The OCR host adapter needs to be reconciled with the literal worker-isolation policy before presenting it as an equally isolated worker backend.

6. **Measure the next change on a larger held-out set.** Continue the planned additional 15 PRs once completeness semantics are fixed. Keep model, prompts/configuration, judge and revisions recorded. Report failed/missing parts, valid review completion, precision, recall, category, diff size, wall time and measured tokens/cost separately. Keep some tuning cases separate from evaluation cases. Add a few truly clean changes to expose noise. No promised percentage improvement is justified before this experiment.

## Adoption order

First: completeness contract, honest verification labels, cross-part context. Next: standard scanner artifacts and stable finding decisions. Use reviewdog if publishing becomes useful. Evaluate a hosted reviewer on the same frozen sample only if the user wants the integration and permits its data/cost requirements.

The offline OCR+Boxie ensemble reached F1 0.315 at lower precision (0.385) and higher recall (0.267). This shows complementary candidates on these five PRs, not that another permanent review dependency is warranted. Its 484-second side-by-side time is projected from existing runs, not a measured concurrent ensemble run. A verifier over the union is an experiment worth testing, not a proven improvement.

## What remains unmeasured

No external product was run against Boxie, no new benchmark was executed, and no production code was changed. Vendor descriptions establish available workflow ideas, not that their detection is superior. Larger-scale accuracy, actual paid cost, real ensemble latency and benefit from each individual proposed change remain unmeasured.

