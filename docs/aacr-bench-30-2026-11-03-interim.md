# AACR-Bench 30 PR comparison — interim status

**Recovery update:** The queue has restarted. OCR's missing explicit host mapping was corrected; `ocr llm test` now passes both connection and tool-call round-trip checks in its container. Four invalid OCR attempts were archived separately, and are being rerun. The four partial Boxie results are retained. Repository preparation now fetches shallow commit history over HTTP/1.1 rather than cloning full history. Versions and selection remain unchanged. No final quality scores exist yet.

**Incomplete; no valid winner or speed comparison yet.** Four PR pairs were attempted. The queue stopped while downloading ClickHouse after repeated network failures. All four Boxie results are partial timeout outputs; all four OCR results failed at the provider stage and report no model usage. OCR failure times measure failed attempts, not review speed.

Frozen versions: Boxie 63a6e8e, OCR 1.13.4. Requested model: Gemini 3.8 Flash High through OmniRoute. Selection: 10 deliberate + 20 reproducibly random PRs; 321 reference comments, 9 languages.

| PR | Boxie seconds | Boxie comments | Boxie status | OCR seconds | OCR status |
|---|---:|---:|---|---:|---|
| CherryHQ/cherry-studio | 486.1 | 13 | timeout / partial | 418.8 | provider failure |
| cline/cline | 505.0 | 2 | timeout / partial | 563.0 | provider failure |
| immich-app/immich | 799.0 | 4 | timeout / partial | 644.0 | provider failure |
| lvgl/lvgl | 1238.5 | 17 | timeout / partial | 837.9 | provider failure |

Quality precision, recall and F1: **unmeasured**. Completed valid comparisons: **0/30**. Attempted reviews: **8/60**.

| Tool | Precision | Recall | F1 | Avg seconds | Basis |
|---|---:|---:|---:|---:|---|
| Boxie | Unmeasured | Unmeasured | Unmeasured | 757.2 | Four partial timeout attempts |
| OCR | Unmeasured | Unmeasured | Unmeasured | Unmeasured | Corrected review still running |

The initial four OCR setup failures averaged 615.9 seconds; they are excluded from review speed comparisons. Quality scoring has not run. Run semantic judging between measured reviews or after the review queue, so judge traffic does not interfere with speed measurements.

Observed Boxie weaknesses: all four reviews hit timeout; live progress can show zero steps despite active review parts. These require investigation; partial findings alone are not evidence of success.

Benchmark orchestration weaknesses: the initial OCR container connection was not validated by an actual model call; retries repeated an expensive full-history repository download; failure did not notify the chat. These are setup/orchestration faults, not evidence that OCR is a weak reviewer.

Next: validate container connectivity and an OCR model call, retain failed attempts as setup evidence, resume the unchanged selection with shallow commit downloads, then score and inspect the results.

Raw evidence and methodology: runs/.tmp/aacr/bench30 and runs/.tmp/aacr/aacr-bench/evaluation/results/bench30.
