# AACR-Bench: Boxie review vs open-code-review

Status: **sketch done**, 5 PRs. 15 more are scheduled after this.

Both tools use the same reviewer model, `antigravity/gemini-3.8-flash-high`, through OmniRoute. Scoring uses AACR-Bench's own scorer (file-level semantic matching), with the same Gemini model as judge. DeepSeek is not used.

- Boxie: `delegate.sh review --roles review-both-gemini`. No spec is given.
- OCR: `open-code-review v1.13.3`, run through `pipeline.py`, `--max-tools 30`.

## Sample

Picked for the most repository-level ground-truth comments, the ones a per-file reviewer is most likely to miss.

| PR | Language | Lines changed | Ground truth | Repo-level |
| --- | --- | --- | --- | --- |
| [cherry-studio#5540](https://github.com/CherryHQ/cherry-studio/pull/5540) | TypeScript | 345 | 19 | 8 |
| [cline#5524](https://github.com/cline/cline/pull/5524) | TypeScript | 333 | 9 | 6 |
| [mpv#15828](https://github.com/mpv-player/mpv/pull/15828) | C | 56 | 8 | 5 |
| [vllm#17425](https://github.com/vllm-project/vllm/pull/17425) | Python | 154 | 8 | 4 |
| [react#32499](https://github.com/facebook/react/pull/32499) | JavaScript | 599 | 16 | 4 |

## Results

### Review stage

| PR | OCR comments | OCR secs | OCR tokens in / out | Boxie comments | Boxie secs | Boxie tokens in / cache read / out | Boxie verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| cherry-studio#5540 | 13 | 172 | 646,693 / 9,185 | 8 | 917 | 300,218 / 6,554,082 / 19,157 | done |
| cline#5524 | 0 | 147 | 886,216 / 8,754 | 0 | 793 | none | `setup_failed` (`npm ci`) |
| mpv#15828 | 3 | 462 | 505,340 / 5,567 | 4 | 1,528 | 575,909 / 10,766,169 / 9,039 | done |
| vllm#17425 | 2 | 75 | 296,060 / 8,756 | 2 | 821 | 273,979 / 6,973,458 / 15,818 | done |
| react#32499 | 3 | 243 | 1,257,738 / 9,390 | 0 | 1,843 | 486,067 / 12,237,515 / 5,400 | `timeout` |
| **Total** | **21** | **1,099** | **3,592,047 / 41,652** | **14** | **5,902** | | 3 of 5 done |

OCR's token column is what its CLI reports. Whether it includes cache reads is unmeasured.

### Scores

Precision = comments that hit a new ground-truth issue / comments. Recall = ground-truth issues covered / ground truth.

| PR | Ground truth | OCR hits / comments | OCR covered | Boxie hits / comments | Boxie covered |
| --- | --- | --- | --- | --- | --- |
| cherry-studio#5540 | 19 | 9 / 13 | 10 | 3 / 8 | 3 |
| cline#5524 | 9 | 0 / 0 | 0 | failed | 0 |
| mpv#15828 | 8 | 1 / 3 | 1 | 0 / 4 | 0 |
| vllm#17425 | 8 | 1 / 2 | 1 | 1 / 2 | 1 |
| react#32499 | 16 | 0 / 3 | 0 | failed | 0 |
| **Total** | **60** | **11 / 21** | **12** | **4 / 14** | **4** |

| | Precision | Recall | Balanced (F1) | Avg secs | Avg tokens |
| --- | --- | --- | --- | --- | --- |
| OCR, all 5 | 0.524 | 0.200 | 0.290 | 220 | 726,740 |
| Boxie, all 5 | 0.286 | 0.067 | 0.109 | 1,180 | |
| OCR, 3 PRs Boxie finished | 0.611 | 0.343 | 0.439 | 236 | |
| Boxie, 3 PRs it finished | 0.286 | 0.114 | 0.163 | 1,089 | |

Precision and recall for the 3-PR rows are computed from the per-PR counts above (35 ground truth).

## Verdict

**Boxie is noticeably worse. Stop and fix before the other 15.**

- On the 3 PRs both tools finished: half the precision, a third of the recall, 4.6x the time.
- 2 of 5 Boxie runs never produced a review: cline failed `npm ci` in setup, react hit the 30-minute timeout.
- mpv: 4 comments, 0 hits. cherry-studio: 3 hits against OCR's 9.

Fixes to try first:

1. Review runs skip project setup. A review reads a diff and needs no `npm ci`.
2. Review timeout scales with diff size, or the reviewer reads fewer files.
3. The benchmark script reads `verdict.txt`. It logged both failures as `exit 0`.
