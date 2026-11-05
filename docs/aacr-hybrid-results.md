# AACR-Bench: Boxie hybrid review against open-code-review

Date: 2026-11-04. Pipeline frozen at `ca56fb2`.

## Setup

- **Boxie arm** (`hybrid`): `delegate.sh review --roles review-both-gemini,review-both-ocr --advise`.
  The fanout reviewer runs at medium effort and OCR runs in the worker image, both in parallel. Then
  `lib/consolidate.mjs` groups the findings by problem and scores each group 0-10, one model call per file.
  A group scoring below 5 is dropped. A group found only by the fanout reviewer is dropped below 7.
  The prose pass is off.
- **OCR arm**: OCR alone, a fresh run in the same image (high effort, 30-minute groups).
- **Judge**: the AACR scorer, file_semantic mode. Ground truth and judge criteria are unchanged.
- One review at a time, on an otherwise idle machine, so the times are comparable.
- Dev set, used for tuning: lvgl e526b2a, ollama 2ed14f2, ClickHouse 3143520, mpv 0729afe, cline 2195a68.
- Held-out set, never tuned on: immich 5f47591 and elastic a9973f6 (handpicked), plus valkey 8b2137d,
  svelte 4bf1f91 and dbeaver dc67ca7 (random).

## Held-out set (label `held1`)

| Slice | Arm | P | R | Hits / notes | Hits / expected | Seconds | Tokens |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| All 5 | hybrid | 0.350 | 0.103 | 7/20 | 7/68 | 3058 | 38.6M |
| All 5 | OCR | 0.250 | 0.088 | 6/24 | 6/68 | 2526 | 6.9M |
| Handpicked | hybrid | 0.800 | 0.114 | 4/5 | 4/35 | 1111 | 15.5M |
| Handpicked | OCR | 0.750 | 0.086 | 3/4 | 3/35 | 1008 | 1.2M |
| Random | hybrid | 0.200 | 0.091 | 3/15 | 3/33 | 1947 | 23.2M |
| Random | OCR | 0.150 | 0.091 | 3/20 | 3/33 | 1518 | 5.7M |

Per PR, as P / R:

| PR | hybrid | OCR |
| --- | --- | --- |
| immich | 0.667 / 0.071 | 0.667 / 0.071 |
| elastic | 1.0 / 0.286 | 1.0 / 0.143 |
| valkey | 0.0 / 0.0 | 0.111 / 0.125 |
| svelte | 0.0 / 0.0 | 0.0 / 0.0 |
| dbeaver | 0.375 / 0.273 | 0.333 / 0.182 |

The goal was P ≥ OCR and R ≥ OCR, with at least one strictly greater. The hybrid meets it on the pooled
set and on each slice. The margin is one hit (7 against 6), so this sample cannot separate the two arms
with confidence.

Svelte's repo was missing from the bench checkout, so its first run failed in 0.13 s on both arms. That
evidence is kept in `results/smoke/held1/startup-failed-norepo/`. Svelte was rerun once, on the same frozen
pipeline. `boxie_arm.py` now exits when the repo is missing, and no longer records a startup failure.

## Dev set

| Arm | P | R | Hits / notes | Hits / expected | Seconds | Tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| hybrid, as run (`dev2`, prose on, min 2) | 0.463 | 0.395 | 31/67 | 32/81 | 3189 | 54.4M |
| hybrid, rescored with the frozen policy (`off8`) | 0.551 | 0.346 | 27/49 | 28/81 | n/a | n/a |
| OCR, fresh (`dev2`) | 0.434 | 0.296 | 23/53 | 24/81 | 3116 | 13.3M |

The `off8` row reuses `dev2`'s raw reviews and runs only the new consolidation offline (`bench/aacr/offline.py`).

## What moved the numbers

- **Consolidation by problem.** The old merge needed the same category and lines within 3 of each other,
  so OCR and fanout findings almost never joined. A single model call per file now groups findings by
  "the same fix resolves both" and keeps the most specific one.
- **Score bands**, pooled over the offline variants:

  | Band | Hits |
  | --- | ---: |
  | Score 2-4 | 8/67 |
  | Score 5 | 10/32 |
  | Score 6-10 | 153/298 |
  | Fanout alone at 5-6 | 0/12 |
  | Fanout alone at 7+ | 10/29 |

  These numbers set min 5 and fanout-only min 7.
- **Prose pass**: a model check of the added text's wording. It hit 2 of 10, so it is off.

## Gaps left

- **Cost.** The hybrid uses 4-6x OCR's tokens. Wall time is 2-21% longer.
- **Part timeouts.** Fanout parts hit the 7-minute cap on most PRs. Their findings so far are kept.
- **Dropped real issue.** On valkey, the only hit OCR found was also in the hybrid's OCR half, but
  consolidation scored it 2 ("asks to verify") and dropped it. The rule was not retuned on held-out data.
- **Low recall.** Recall is low for both arms on held-out data (about 0.1). The ground truth has many
  notes that neither arm finds.

## Later runs: full1, full2 and the duo (2026-11-04 to 2026-11-05)

| Run | Boxie arm | Boxie P / R | OCR P / R | Note |
| --- | --- | --- | --- | --- |
| full1, 10 PRs | hybrid, 10-minute parts | 0.432 / 0.235 | 0.466 / 0.235 | mpv failed on both arms (gateway) |
| full1, 9 PRs, offline | two OCR runs consolidated | 0.548 / 0.298 | 0.466 / 0.248 | the second OCR run is the OCR arm |
| dev2 + held1, offline | two OCR runs consolidated | 0.427 / 0.242 | 0.390 / 0.208 | dev2 gains, held1 ties |
| full2, 5 dev PRs | duo (`review-both-ocr,review-both-ocr2`) | 0.491 / 0.346 | 0.463 / 0.247 | stopped by a Podman outage |

full2's live margin came mostly from failed files. The OCR arm lost 5 of 23 files on ClickHouse and 4 of 7 on
ollama, yet was scored as complete. On the 3 clean PRs, duo and OCR tie: P 0.400 vs 0.414, and both hit
13 of 48 reference notes. Since `3ddf0ab`, an OCR run retries its failed files once from its session, and a run
with files still failed is partial. `smoke.py` records failed files per run, and `report.py --clean` leaves
those PRs out.

Rerunning the same consolidation on the same input moves P by about 0.03 (full1: 0.548, 0.520). Two
OCR runs of a PR differ by about 0.05. Ten PRs cannot separate arms closer than that. The next benchmark uses
the 20 bench30 PRs not run here (`research/review-improvement-research-2026-11-04.md` §5).

Tried and not kept, measured offline on full1's two OCR runs:

| Variant | P | R |
| --- | ---: | ---: |
| Old rubric (o57) | 0.549 | 0.306 |
| New rubric: hedged wording no longer scores 2, agreement bar 5 | 0.521 | 0.291 |
| New rubric, agreement bar 3 | 0.507 | 0.299 |
| Duo plus the wording pass | 0.526 | 0.298 |
| Duo alone, the same rerun | 0.520 | 0.291 |

The first three rows leave out cline, whose judge call failed for two of them. Neither change beat the
consolidation's own run-to-run spread, so both were dropped.

## full3 and full4: 19 PRs, duo and trio against a fresh OCR run (2026-11-05)

Same 19 PRs (5 handpicked, 14 random), one review at a time, nothing else running. No run on either arm
had a failed start or a file left failed after its retry, so the `--clean` pool equals the raw pool.

| Run | Arm | P | R | Seconds | Tokens |
| --- | --- | ---: | ---: | ---: | ---: |
| full3 | duo | 0.424 (36/85) | 0.235 (39/166) | 6875 | 75.6M |
| full3 | OCR | 0.382 (34/89) | 0.217 (36/166) | 5876 | 39.4M |
| full4 | trio | 0.477 (42/88) | 0.259 (43/166) | 8371 | 103.3M |
| full4 | OCR | 0.407 (33/81) | 0.205 (34/166) | 6938 | 37.2M |

full4 by group: handpicked trio 0.520 / 0.217 against OCR 0.370 / 0.167, random 0.460 / 0.283 against
0.426 / 0.226. Per PR, trio found more reference notes on 6, fewer on 3 (react, PowerToys, vllm 075f1b5,
one note each), the same on 10. full3's duo lost handpicked precision (0.500 against 0.571).

Offline on full3's runs (`off12`):

- Each duo run alone: P 0.447 R 0.211 and P 0.374 R 0.229. Their plain union: P 0.282 R 0.271.
- The comments consolidation scored out hit 4 of 27, so the bar is right. Grouping loses a few notes
  the union had (45 to 40).
- Carrying the other reports' wording on a merged comment: P 0.410 R 0.217 against 0.416 / 0.241. Dropped.
- Three runs consolidated: P 0.451 R 0.271 and 0.446 / 0.277, which full4 then confirmed live.

Cost: trio uses 2.8x OCR's tokens and 1.2x its time (the runs go side by side). Five PRs score zero
on every arm (react, cline, hyperswitch, elasticsearch, codex: 48 reference notes): the next recall gap.
