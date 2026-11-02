# Brief: improving Boxie review

For the session that picks this up. The aim is a Boxie review that matches or beats open-code-review
(OCR) on AACR-Bench, in less time. The numbers come from [aacr-bench.md](aacr-bench.md). This brief
covers what they mean, where the evidence is, and what to try.

## Constraints from the user

- Gemini only (`antigravity/gemini-3.8-flash-high`). Do not use DeepSeek until the user allows it,
  and then the cap is $4. No Sol 6.1.
- Never print the OmniRoute key. `runs/.tmp/aacr/env.sh` loads it from `projects/lykos.env`.
- Ask before any download or install.
- 15 more AACR PRs are to run after Boxie is fixed. Do not start them until a rerun of the 5 shows
  Boxie is no longer clearly worse.
- A separate grill topic is open: Boxie speed, and containers not being the default for every run.
  See "Next grill" in [known-gaps.md](known-gaps.md). Every speed fix here feeds into it.

## Result in one table

Both tools used the same model and the same judge.

| | Precision | Recall | F1 | Avg secs |
| --- | --- | --- | --- | --- |
| OCR, the 3 PRs Boxie finished | 0.611 | 0.343 | 0.439 | 236 |
| Boxie, the same 3 | 0.286 | 0.114 | 0.163 | 1,089 |

2 of 5 Boxie runs produced no review: cline (`setup_failed`) and react (`timeout`).

## What went wrong, by cause

### 1. Setup ran on a review (cline)

`verdict setup_failed next fix_environment`. `setup.log` shows `npm ci` failing. Per
`lib/setup.mjs:144`, `npm ci` runs by itself when `package-lock.json` is at the root.
`projects/bench.env` sets no `SETUP_CMD`.

A review reads a diff and does not need dependencies to find most issues. The prompt still says
"Dependencies are already installed" and invites reproductions under `/tmp`.

Try: review runs skip setup by default. Setup runs only when a reproduction needs it, or setup
failure downgrades to a warning on a review.

### 2. Too many steps (react timed out, everything is slow)

| PR | Lines changed | Steps | Tool calls | Secs |
| --- | --- | --- | --- | --- |
| mpv#15828 | 56 | 136 | 134 | 1,528 |
| react#32499 | 599 | 148 | 147 | 1,843 (timeout at `TIMEOUT_MIN=30`) |
| cherry-studio#5540 | 345 | 93 | 94 | 917 |
| vllm#17425 | 154 | 91 | 91 | 821 |

Tool mix for mpv: grep 53, read 49, bash 26. For react: read 76, grep 44, bash 22.

The ledger figure is about 11 s per step (`modelSecsPerStep` 11.2 over the last 30 days), so time
tracks step count. On a 56-line C diff Boxie took 136 steps. OCR took 462 s on the same PR.

Cache reads per review run were 6.5M to 12.2M tokens, against 0.27M to 0.58M fresh input. Each
step resends the growing context.

Try, in order of expected gain:

- Cap the steps for a review, scaled to diff size.
- Run one reviewer per changed file (or hunk group) in parallel, each with a small tool budget.
  This is OCR's shape: `--max-tools 30` per file.
- Run review on the host, read-only, with no container. The repo is only read, and git worktree
  isolation is enough. This is also the grill topic.
- Have the timeout end the review with the findings so far, never with an empty result. react's
  147 calls produced nothing.

### 3. Prompt filters out what the benchmark counts

Ground truth for the 5 PRs: 60 comments.

| Category | Count | OCR covered | Boxie covered |
| --- | --- | --- | --- |
| Code Defect | 33 | 5+ | 4 |
| Maintainability and Readability | 23 | 1+ | 0 |
| Performance | 4 | 1+ | 0 |

| Context | Count |
| --- | --- |
| Repo Level | 27 |
| File Level | 19 |
| Diff Level | 14 |

OCR's per-category counts are a floor: 5 of its 12 covered comments did not map back to a category
because the note text did not match.

48 of the 60 ground-truth comments are AI-written (`is_ai_comment`).

The Boxie review prompt (`runs/<project>/<run>/prompt.md`, 827 lines for mpv) says:

- "do not pad the list with style preferences"
- smells are "at most low"
- critical, high and medium findings need a quoted `basis`

That shape suits gating a merge in Lykos. It suppresses the 23 maintainability comments AACR
rewards. Boxie's 4 hits were all Code Defect, and 3 of them were Repo Level, so cross-file reasoning
works when it fires.

Decide this first: is Boxie review a merge gate (few, proven findings) or a reviewer (all useful
comments)? A possible answer is two modes: a `gate` mode as today and an `advise` mode that lets
maintainability and performance through at low severity. Benchmark the advise mode.

### 4. Precision misses

mpv: 4 comments, 0 hits. One example from the judge: Boxie flagged `UPDATE_OPTS_MASK` deferral at
`player/command.c` L7827-L7830, and the reference flagged an array-coalescing shift bug at
L7706-L7719 in the same file. Boxie went to a side effect of the change and missed the bug in the
loop the PR adds. Read `findings.json` for each run beside the reference notes in the metrics file
before you change the prompt.

### 5. The benchmark script hid both failures

`runs/.tmp/aacr/boxie_arm.py` logged cline and react as `exit 0` because `delegate.sh` returns 0.
Make it read `verdict.txt` and record the verdict in the result JSON. Also record tokens. The result
JSONs have `tokens_total: null`, and the numbers above came from summing `events.jsonl`.

## Where the evidence is

| What | Path (under `C:/Workspace/Tools/Boxie/`) |
| --- | --- |
| Boxie runs | `runs/{cherryhq__cherry-studio,cline__cline,facebook__react,mpv-player__mpv,vllm-project__vllm}/aacr-<sha>-review-both-gemini/` |
| Per run | `prompt.md`, `context.md`, `findings.json`, `events.jsonl`, `verdict.txt`, `summary.json`, `setup.log` |
| Benchmark scratch | `runs/.tmp/aacr/` |
| AACR scorer | `runs/.tmp/aacr/aacr-bench/evaluation/` (`.venv`, `pipeline.py`) |
| Sample | `.../evaluation/data/sample5.jsonl`; raw rows with category in `runs/.tmp/aacr/data/dataset.json` |
| OCR results and metrics | `.../evaluation/results/sample5/ocr/gemini/`, `.../evaluation/metrics/sample5/ocr/gemini/metrics_ocr_20261102_115545.json` |
| Boxie results and metrics | `.../evaluation/results/sample5/boxie/gemini/` (metrics file `metrics_ocr_20261102_132821.json` is in the same folder) |
| Logs | `runs/.tmp/aacr/{ocr-run,ocr-eval,boxie-run,boxie-eval}.log` |

In the metrics files, `eval_res[].generated_comments[].hit_new_gt` is a precision hit,
`eval_res[].comments[].file_semantic_match` is a recall hit, and `judge_reason` is why.

## How to rerun

From `runs/.tmp/aacr/`, with Git Bash:

```bash
source env.sh
python boxie_arm.py            # skips samples whose result JSON exists; delete one to rerun it
cd aacr-bench/evaluation
.venv/Scripts/python.exe -m pipeline run --stage eval --reviewer ocr \
  --dataset data/sample5.jsonl --results-dir results/sample5/boxie/gemini
```

`--reviewer ocr` is deliberate: it makes the scorer read Boxie's output in OCR's comment format.
Podman must be up (`podman machine start`), and only one container runs at a time (the machine has
3.8 GiB).

## Done looks like

- All 5 PRs produce a review, with no `setup_failed` or `timeout`.
- Rerun F1 on the 5 is at or above OCR's 0.290, and the average is under 600 s per PR.
- Each change lands with its own before and after numbers in [aacr-bench.md](aacr-bench.md).
