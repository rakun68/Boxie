# Improving Boxie's review and implementation: what the AACR runs show, what others do

Date: 2026-11-04. Sources: AACR runs `dev2`, `held1`, `full1`, `full2` (partial), offline rescoring `off8`-`off10`,
Sol (cx/gpt-6.1-sol-medium, `runs/lvgl__lvgl/ask/20261104-223712-advise.md`), and the papers and posts listed at the end.

## 1. What the benchmark data shows

| Run | Boxie P / R | OCR P / R | Note |
| --- | --- | --- | --- |
| held1, 5 PRs: fanout + OCR, consolidated | 0.350 / 0.103 | 0.250 / 0.088 | 7 hits vs 6 |
| full1, 10 PRs: same hybrid | 0.432 / 0.235 | 0.466 / 0.235 | mpv failed on both arms (gateway) |
| full1 offline, 9 PRs: two OCR runs consolidated | 0.548 / 0.298 | 0.466 / 0.248 | the second OCR run is the baseline arm |
| dev2 + held1 offline: two OCR runs consolidated | 0.427 / 0.242 | 0.390 / 0.208 | dev2 gains, held1 ties |
| full2, 5 dev PRs: duo (two OCR runs) | 0.491 / 0.346 | 0.463 / 0.247 | the OCR arm lost files on 2 PRs, see below |

**Finding** `[1]` **full2's live win is mostly from failed OCR files.** The OCR baseline lost 5 of 23 files on
ClickHouse and 4 of 7 on ollama (`ocr.json` `manifest.coverage.failed`). It still reported success and was
scored as `complete_findings`. On the 3 clean PRs (lvgl, mpv, cline), duo and OCR tie: P 0.400 vs 0.414,
and both hit 13 of 48 reference notes. Duo really is more resilient, because two runs rarely lose the same file.
But it has not been shown to beat a healthy single OCR run live.

**Finding** `[2]` **Run-to-run variance is about as large as every effect measured.** Two OCR runs of the same
PR differ by about 0.05 P. The hybrid's own OCR half scored P 0.412, while the separate OCR arm scored 0.466.
Sol estimates that separating a 0.03 P difference needs about 22 paired PRs if the per-PR difference
has SD 0.05, and about 87 if it has SD 0.10. Ten PRs cannot separate the arms.

**Finding** `[3]` **Agreement predicts a hit.** In full1, a problem raised by all three sources hit 14 of 22. A problem
raised by one OCR run alone hit 4 of 11. A problem raised by the fanout reviewer alone hit 1 of 6. Scores from the
consolidator are not calibrated above 5: score 9 hit 3 of 11.

**Finding** `[4]` **The fanout reviewer is poor value.** Alone it scores P 0.513 R 0.156 at about 5x OCR's tokens.
After consolidation it adds only 0.01-0.04 R.

**Finding** `[5]` **Recall is capped by file coverage.** In full2's duo runs, 23 of 81 reference notes (28%) are in
files where Boxie posted no comment, and none of them were hit. Notes in files Boxie commented on were hit
28 of 58. By keyword class:

| Class | Hits |
| --- | ---: |
| Docs/comments | 3/12 |
| Typo/naming | 2/9 |
| Error handling, null, leak | 10/28 |
| Performance | 5/10 |
| Other logic | 8/22 |

The missed files include `.rst` docs and `xmls/*.xml` on lvgl, plus headers. OCR selected and reviewed them,
and produced nothing the judge matched.

**Finding** `[6]` **Consolidation drops some real issues.** A real issue worded as "verify X could be NULL"
was scored 2 and dropped, although it matched a reference note (valkey, held1).

## 2. What other tools and papers do

- **Cursor Bugbot, v1.**
  - The first version ran eight parallel passes, each on a differently ordered diff.
  - It grouped similar bugs, kept only bugs found by more than one pass, ran a validator model, and
    filtered unwanted categories.
  - Later versions moved to an agentic design that investigates where it chooses and was prompted to
    flag aggressively.
  - Resolution rate went from 52% to over 70%, measured on real merges, with an offline benchmark (BugBench)
    beside it.
  - This is closest to Boxie's duo plus consolidation. Boxie does not yet randomize the file order or require
    agreement.
- **SWR-Bench (arXiv 2509.01494).**
  - "Multi-Review" runs the reviewer n times and has one LLM call aggregate the reports.
  - Gemini-2.5-Flash with n=10 raised F1 by 43.67% and recall by 118.83%, to 30.44%.
  - Gains flatten after n=5. Precision barely moved.
  - Runs of the same model rarely overlap: only 27 change-actions were shared across five runs.
  - Recall falls from 38.35% on one-issue PRs to 8.88% on PRs with 5 or more issues.
- **AACR-Bench (arXiv 2601.19494).**
  - 47.1% of the notes are code defects and 41.6% maintainability/readability. Performance is 7.8%,
    security 3.5%.
  - Claude Code as an agent reached P 39.9% but R 10.1%. Without context the same model reached P 8.7%,
    R 42.9%.
  - Fewer comments mean higher precision. Pipelines that post more comments gain recall but lose precision.
- **Qodo PR-Agent.** A self-reflection pass scores each suggestion 0-10 with a reason and drops those
  under a threshold. Boxie's consolidation already does this.
- **Claude Code Review** (secondary sources only).
  - Specialist agents work in parallel, each looking for a different kind of problem.
  - A verification step checks each finding against the code, then duplicates are merged and ranked.
  - It reports under 1% of findings dismissed by developers, at about $15-25 a review.
- **CodeX-Verify (arXiv 2511.16708).** Agents specialised by bug type add recall as each agent joins.
  The sample was only 99 cases.
- **Implementation: CodeMonkeys (arXiv 2501.14723).**
  - It samples 10 (edit, test) candidate pairs per issue.
  - The best selector filtered to the top 3 by tests, then ran a selection agent that can write new tests.
  - That selector recovers about half the gap between random selection and an oracle.
- **Agentless.** Localize, repair, then validate with reproduction tests that fail on the old code. Selecting
  by reproduction test raised end-to-end repair from 96 to 115 of 300 (BLAgent's measurement).
- **R2E-Gym.** A verifier combining test runs with a model's judgement reached Best@26 51.0% against Pass@1 34.4%.
  Each kind alone plateaus at about 42-43%.
- **Self-review.** It helps only with an outside signal such as test results. A reviewer in the same
  session misses its own errors (arXiv 2603.12123). Review in a new context, by another model, does better.

## 3. Proposals for review, ranked by expected gain per token

| # | Change | Why | Measure |
| --- | --- | --- | --- |
| 1 | **Retry failed OCR files** (`ocr --resume <session>` once), and label a run with failed files `partial` | Finding 1: failed files go uncounted and silently cost recall on both arms | failed-file count per run, and R on runs that had failures |
| 2 | **Randomize file order per OCR run** (Bugbot) | Finding 3: the runs are only partly independent, so a different order should spread their coverage | overlap between the two runs and unique hits |
| 3 | **Score by agreement and evidence** | Findings 3 and 6. Score the claim, not hedged wording. Use the number of agreeing runs as a feature. Calibrate on unique hits, since duplicates count as misses. Fit on dev, freeze, then check held-out. | P-R curve and extra hits per million tokens |
| 4 | **Replace the fanout reviewer with a narrow pass for docs, names and consistency on the changed lines** | Findings 4 and 5: docs, comments and naming hit 5 of 21, and the fanout costs 5x | unique hits in docs and naming, and P of that pass alone |
| 5 | **A third OCR run, or a different model for the second run** | SWR-Bench gains until n=5. Same-model runs overlap little. | marginal hits at equal tokens |

Drop the fanout reviewer from the AACR configuration. Keep it for the gate reviews in the loop, where
reproductions prove findings.

## 4. Proposals for implementation

Boxie already has:
- sealed acceptance tests
- a review loop that proves findings with reproductions
- parallel candidates (`fanout`) with a comparison table
- `LOOP_FRESH` restarts on a stall

The ledger shows 86% verdict pass and 79% first-try task pass for `implement` (Gemini 3.8 Flash, 275 runs),
averaging 22m21s.

| # | Change | Evidence | Measure |
| --- | --- | --- | --- |
| 1 | **The worker must write or point to a failing check before editing, and confirm it fails for the stated reason** | Agentless and BLAgent: 96 → 115 of 300 | rate of tests that fail before and pass after, plus hidden-test pass |
| 2 | **Choose among parallel candidates by tests, not by the table alone**: top 3 by the sealed tests plus any reproduction, then one selection call that may write a deciding test | CodeMonkeys: recovers half the gap to the oracle | track oracle success against selected success, since the gap shows weak selection |
| 3 | **The diff is reviewed in a new session by another model, and findings are proven before the fix** | Same-session self-review fails. Boxie's loop already does this, so keep it. | — |
| 4 | **A short plan that names files, callers and tests, written after reading the code** | Aider's architect/editor split (numbers vary by source) | wasted rounds and tokens by task size |
| 5 | **Cap repair rounds on targeted tests, then run the full gate. Never weaken tests.** | R2E-Gym: test runs plus a model's judgement beat either alone | passes gained per round and per token |

Sol's first implementation experiment: compare the current loop with reproduction-first plus bounded targeted
repair, before adding candidates.

## 5. Benchmark protocol for the next round

- Count OCR file failures in every run, and rerun or exclude a run with failed files on either arm.
- About 20-30 paired PRs, several runs per arm on a subset to measure variance, with per-PR paired
  differences and resampling by PR.
- Compare at equal runs and at equal tokens: duo against a single OCR run given the same token budget.
- Freeze thresholds on dev, then run held-out once.

## Sources

- [Cursor: Building Bugbot](https://cursor.com/blog/building-bugbot)
- [SWR-Bench, arXiv 2509.01494](https://arxiv.org/html/2509.01494v2)
- [AACR-Bench, arXiv 2601.19494](https://arxiv.org/html/2601.19494v1)
- [Qodo Merge self-reflection](https://qodo-merge-docs.qodo.ai/core-abilities/self_reflection)
- [Claude Code Review coverage, heise](https://heise.de/-11205497)
- [CodeX-Verify, arXiv 2511.16708](https://arxiv.org/pdf/2511.16708)
- [CodeMonkeys, arXiv 2501.14723](https://arxiv.org/html/2501.14723v1)
- [Agentless, arXiv 2407.01489](https://www.arxiv.org/pdf/2407.01489)
- [BLAgent, arXiv 2605.17965](https://arxiv.org/pdf/2605.17965)
- [R2E-Gym, arXiv 2504.07164](https://arxiv.org/pdf/2504.07164)
- [Cross-Context Review, arXiv 2603.12123](https://arxiv.org/pdf/2603.12123)
- [Bigger Isn't Always Better, arXiv 2606.15689](https://arxiv.org/html/2606.15689v1)

## 6. Outcome (2026-11-05)

| # | Proposal | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Retry failed OCR files, label partial | Done, `3ddf0ab` | Checked live: the resume ran, and both logs were kept |
| 2 | Vary file order per run | Not possible | OCR 1.13.4 has no order or seed option, and groups files deterministically |
| 3 | Score by agreement and evidence | Dropped | See the variant table below |
| 4 | Wording pass beside the duo | Stays off | See the variant table below |
| 5 | Implementation changes | Done, `3ddf0ab` | Workers reproduce a bug before fixing it. `fanout --score` prints a pick. The loop already filters candidates by tests and lets a selector pick among ties. |
| 6 | Benchmark protocol | Done | `smoke.py` records failed files, `report.py --clean`, duo is the default arm, and the five missing repos are cloned |

The offline variants behind proposals 3 and 4, on full1:

| Variant | P | R |
| --- | ---: | ---: |
| Agreement bar 3 | 0.507 | 0.299 |
| Agreement bar 5 | 0.521 | 0.291 |
| Old rubric | 0.549 | 0.306 |
| Duo plus the wording pass | 0.526 | 0.298 |
| Duo alone, the same rerun | 0.520 | 0.291 |

The worker image was rebuilt with the new rule, open-code-review still at 1.13.4.

Proposal 5 (a third run), live on 19 PRs (full4, 2026-11-05): trio P 0.477 R 0.259 against a fresh OCR
run's 0.407 / 0.205, at 2.8x the tokens. See docs/aacr-hybrid-results.md.
