# AACR benchmark — stopped findings

Stopped at the user's request on 2026-11-03. The original queue, zero-score rerun queue, watcher and heartbeat automation are stopped. The cancelled rerun's container output was copied before removing its container. Do not resume automatically.

## Measured snapshot

21 paired PRs were reviewed and scored, covering 279 reference comments. The planned sample was 30 PRs: 10 handpicked and 20 random. The unfinished snapshot is not the full planned benchmark.

| Metric | Boxie | OCR |
|---|---:|---:|
| Generated comments | 80 | 159 |
| Generated comments matching new references | 41 | 71 |
| Reference comments covered | 45 / 279 | 74 / 279 |
| Precision | 0.5125 | 0.4465 |
| Recall | 0.1613 | 0.2652 |
| F1 | 0.2454 | 0.3328 |
| Average attempt seconds | 506.4 | 347.3 |
| Median attempt seconds | 511.7 | 322.8 |
| Complete run verdicts | 0 / 21 | 21 / 21 |
| Timeout run verdicts | 15 | 0 |
| Startup failures | 6 | 0 |

These are reference-matching scores, not independent factual precision. Unmatched findings are not necessarily wrong. Quality includes partial Boxie findings and empty outputs from genuine startup failures. Attempt-time averages include failures; Boxie's cheap startup failures lower its average, so this is not a successful-review speed comparison. OCR's review preset was high; Boxie used its configured medium per-part reasoning on the requested Gemini high route. These were not equal-compute configurations. Boxie timing includes harness startup; OCR excludes container creation and checkout copy.

Versions: Boxie base `63a6e8e2f9bc5c43e20192c5246a7f25d079e371`; OCR `1.13.4` (`76ab46a`); reviewer and semantic judge `antigravity/gemini-3.8-flash-high` through OmniRoute. Invalid setup attempts were archived separately and replaced without discarding genuine measured timeouts. Same-family judging, a single pass, an incomplete sample and overlap with development PRs limit conclusions.

## Confirmed defects and observations

1. **Context-pack output buffer overflow.** The large-repository startup failures show `spawnSync git ENOBUFS` from `lib/pack.mjs` collecting `git ls-tree -r --name-only`. The default synchronous subprocess output buffer was too small. Six original attempts failed before review. The one tracked source change is an uncommitted `maxBuffer: 64 * 1024 * 1024` option on the Git helper. All four existing pack tests passed, and real ClickHouse context-pack generation succeeded. The later ClickHouse worker got past startup. This proves the startup fix, not overall review quality.

2. **Completion signals disagree.** Across 69 saved parts from original-version fanout artifacts, 22 exited 0 and 47 exited 124. Of the 47 timeout parts, **42 had final durable checkpoints with `complete: true`**, three had `complete: false`, and two had no checkpoint. This is the most useful unresolved lead. `image/fanout.mjs` waits for the attached OpenCode process to close; completion then requires `exit === 0 && !cut`. A durable complete report alone does not terminate that wait or establish a complete part. Checkpoint completeness is worker self-report, not proof of adequate review, and its timing must be reconstructed before drawing a causal conclusion.

3. **Live fanout progress looks idle.** The top-level progress file showed zero steps/tools/tokens while part event files grew and checkpoints were saved. The per-part evidence is useful; the aggregate live status is misleading. This does not prove final ledger accounting is wrong.

4. **Zero-score rows mix distinct outcomes.** Some are startup failures with no model review, some are timeout partial outputs, and others are completed OCR reviews that matched none of the references. Treating all zeros as one software bug is incorrect. Neither ground truth nor the judge was changed to force a nonzero result.

## Likely issue to investigate first

The combination of durable complete reports, attached OpenCode processes remaining alive, and a process-exit-based completion condition suggests a termination/lifecycle mismatch. Possible causes include an attached CLI waiting after the session has finished, the agent continuing after `review_report(complete=true)`, a missing explicit completion action, or a genuine time budget overrun despite a premature report. The evidence does not choose among these yet. Inspect tool and session event timestamps before changing verdict logic. Simply reclassifying all complete checkpoints as successes would conceal real coverage failures.

Increasing part budgets alone is not a demonstrated fix. The separately labeled zero-score experiment changed Boxie to 15 minutes/40 steps per part, a two-minute report turn and a 45-minute overall budget. Its first ClickHouse review reached actual worker execution and saved six complete checkpoints, while parts seven/eight were still running. The user cancelled it before final output and scoring. **No corrected-version precision, recall, F1 or speed result exists.**

## Benchmark orchestration faults, separate from Boxie

- OCR initially lacked Boxie's explicit Podman host-IP mapping. All four initial OCR attempts failed with zero model usage. After adding `--add-host host.docker.internal:<VM host IP>` and using that hostname, OCR's own model and tool-call smoke test passed and corrected reviews succeeded. Invalid attempts remain archived.
- Large Git downloads failed or took a long time. Shallow histories sped initial preparation but produced unusable Boxie bundles: container clones lacked parent objects. Complete history fixed that. The completeness check also originally ran before fresh commit fetches and was subsequently moved after them.
- Windows checkout needed repository-local `core.longpaths=true` for Elasticsearch.
- Incremental judging reused an asyncio semaphore/client across separately created event loops. Resetting those per scoring call addressed the observed failure.
- The live-table watcher and scorer initially shared one temporary filename. A concurrent write failed; process-specific temporary filenames passed a four-concurrent-refresh check.
- Initial retry supervision stopped without notifying the chat. A heartbeat was added later. It is now deleted at the user's request.
- File-size timestamps alone were an unreliable download-progress signal; Git I/O counters showed gigabytes transferred while metadata looked stale.

These mistakes cost time and weakened the experiment. They must not be presented as OCR review defects or as a clean, controlled comparison. One interrupted OCR PR22 run was cancelled when the original queue was stopped; it is not part of the 21-pair snapshot.

## Evidence map

- Original live table: `docs/aacr-bench-30-live.md`.
- Zero-score rerun table: `docs/aacr-zero-score-reruns-live.md` (all rerun scores pending).
- Selection, raw dataset hash, versions, methodology, logs: `runs/.tmp/aacr/bench30/`.
- Canonical original results: `runs/.tmp/aacr/aacr-bench/evaluation/results/bench30/{boxie,ocr}/fresh-high/`.
- Per-PR judge records: `runs/.tmp/aacr/bench30/scores/{boxie,ocr}/`.
- Startup overflow logs: `runs/<project>/.aacr-fresh-high-<sha>-review-both-gemini.log`.
- Part outcomes/checkpoints: `runs/<project>/aacr-fresh-high[-recovered]-<sha>-review-both-gemini/{fanout.json,review-state/,parts/,events.jsonl}`.
- Invalid setup archives: `runs/.tmp/aacr/bench30/{ocr-setup-failures,boxie-setup-failures}/`.
- Corrected-version manifest/config/patch: `runs/.tmp/aacr/bench30/zero-recovery/` (project env contains credentials; never print or share it).
- Cancelled corrected ClickHouse output: `runs/.tmp/aacr/bench30/zero-recovery/cancelled-clickhouse/out/`.

Scratch is under a directory that Boxie's GC may remove after a day. Preserve needed evidence before invoking cleanup. Source changes are uncommitted; there were no benchmark-related commits.
