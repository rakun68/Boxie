# AACR benchmark — live progress

**STOPPED at user request. This is a saved snapshot; automatic updates are disabled.**

Updated: 2026-11-03T16:37:03+07:00

Frozen 30 PRs: 10 handpicked, 20 random. Partial results are labeled. Pending scores are not zero. Setup failures are archived separately. Judging does not overlap measured reviews.

Quality scores cover evaluated rows only; average seconds covers all saved attempts, including labeled timeouts. These denominators differ while scoring catches up.

| Tool | Results saved / 30 | Complete | Partial / failed | Scored | Precision | Recall | F1 | Avg seconds (saved attempts) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| boxie | 21 | 0 | 21 | 21 | 0.512 | 0.161 | 0.245 | 506.4 |
| ocr | 21 | 21 | 0 | 21 | 0.447 | 0.265 | 0.333 | 347.3 |

| PR | Group | Tool | Status | Seconds | Comments | Precision | Recall | F1 |
|---|---|---|---|---:|---:|---:|---:|---:|
| https://github.com/CherryHQ/cherry-studio/pull/5540 | handpicked | boxie | partial / timeout | 486.1 | 13 | 0.769 | 0.526 | 0.625 |
| https://github.com/CherryHQ/cherry-studio/pull/5540 | handpicked | ocr | complete | 127.1 | 17 | 0.647 | 0.579 | 0.611 |
| https://github.com/cline/cline/pull/5524 | handpicked | boxie | partial / timeout | 505.0 | 2 | 0.500 | 0.222 | 0.307 |
| https://github.com/cline/cline/pull/5524 | handpicked | ocr | complete | 200.9 | 1 | 0.000 | 0.000 | 0.000 |
| https://github.com/lvgl/lvgl/pull/8689 | handpicked | boxie | partial / timeout | 1238.5 | 17 | 0.588 | 0.333 | 0.425 |
| https://github.com/lvgl/lvgl/pull/8689 | handpicked | ocr | complete | 364.5 | 21 | 0.476 | 0.333 | 0.392 |
| https://github.com/immich-app/immich/pull/17535 | handpicked | boxie | partial / timeout | 799.0 | 4 | 1.000 | 0.143 | 0.250 |
| https://github.com/immich-app/immich/pull/17535 | handpicked | ocr | complete | 253.2 | 10 | 0.500 | 0.179 | 0.264 |
| https://github.com/ClickHouse/ClickHouse/pull/82441 | handpicked | boxie | failed / partial | 48.2 | 0 | 0.000 | 0.000 | 0.000 |
| https://github.com/ClickHouse/ClickHouse/pull/82441 | handpicked | ocr | complete | 472.2 | 11 | 0.364 | 0.308 | 0.334 |
| https://github.com/elastic/elasticsearch/pull/118626 | handpicked | boxie | failed / partial | 5.8 | 0 | 0.000 | 0.000 | 0.000 |
| https://github.com/elastic/elasticsearch/pull/118626 | handpicked | ocr | complete | 220.5 | 4 | 1.000 | 0.571 | 0.727 |
| https://github.com/mpv-player/mpv/pull/15828 | handpicked | boxie | partial / timeout | 812.3 | 1 | 0.000 | 0.000 | 0.000 |
| https://github.com/mpv-player/mpv/pull/15828 | handpicked | ocr | complete | 456.6 | 4 | 0.250 | 0.125 | 0.167 |
| https://github.com/facebook/react/pull/32499 | handpicked | boxie | partial / timeout | 559.6 | 1 | 1.000 | 0.062 | 0.117 |
| https://github.com/facebook/react/pull/32499 | handpicked | ocr | complete | 647.4 | 7 | 0.143 | 0.062 | 0.086 |
| https://github.com/vllm-project/vllm/pull/17425 | handpicked | boxie | partial / timeout | 476.7 | 2 | 0.500 | 0.125 | 0.200 |
| https://github.com/vllm-project/vllm/pull/17425 | handpicked | ocr | complete | 83.4 | 2 | 0.500 | 0.125 | 0.200 |
| https://github.com/juspay/hyperswitch/pull/7353 | handpicked | boxie | failed / partial | 3.9 | 0 | 0.000 | 0.000 | 0.000 |
| https://github.com/juspay/hyperswitch/pull/7353 | handpicked | ocr | complete | 61.2 | 0 | 0.000 | 0.000 | 0.000 |
| https://github.com/FreeCAD/FreeCAD/pull/22744 | random | boxie | partial / timeout | 580.8 | 1 | 0.000 | 0.000 | 0.000 |
| https://github.com/FreeCAD/FreeCAD/pull/22744 | random | ocr | complete | 98.5 | 2 | 0.000 | 0.000 | 0.000 |
| https://github.com/browser-use/browser-use/pull/3172 | random | boxie | partial / timeout | 472.5 | 2 | 0.500 | 0.500 | 0.500 |
| https://github.com/browser-use/browser-use/pull/3172 | random | ocr | complete | 68.0 | 2 | 0.500 | 0.500 | 0.500 |
| https://github.com/cline/cline/pull/4786 | random | boxie | returned | 402.2 | 3 | 0.333 | 0.143 | 0.200 |
| https://github.com/cline/cline/pull/4786 | random | ocr | complete | 80.0 | 2 | 0.500 | 0.143 | 0.222 |
| https://github.com/dbeaver/dbeaver/pull/36789 | random | boxie | partial / timeout | 573.9 | 7 | 0.286 | 0.182 | 0.222 |
| https://github.com/dbeaver/dbeaver/pull/36789 | random | ocr | complete | 322.8 | 9 | 0.333 | 0.364 | 0.348 |
| https://github.com/openai/codex/pull/3212 | random | boxie | partial / timeout | 511.7 | 4 | 0.000 | 0.000 | 0.000 |
| https://github.com/openai/codex/pull/3212 | random | ocr | complete | 348.3 | 5 | 0.000 | 0.000 | 0.000 |
| https://github.com/ollama/ollama/pull/9746 | random | boxie | partial / timeout | 516.9 | 7 | 0.429 | 0.150 | 0.222 |
| https://github.com/ollama/ollama/pull/9746 | random | ocr | complete | 530.0 | 12 | 0.750 | 0.450 | 0.563 |
| https://github.com/bluewave-labs/Checkmate/pull/2883 | random | boxie | partial / timeout | 787.2 | 8 | 0.500 | 0.133 | 0.210 |
| https://github.com/bluewave-labs/Checkmate/pull/2883 | random | ocr | complete | 227.2 | 12 | 0.417 | 0.200 | 0.270 |
| https://github.com/FreeCAD/FreeCAD/pull/19411 | random | boxie | partial / timeout | 908.2 | 4 | 0.750 | 0.263 | 0.389 |
| https://github.com/FreeCAD/FreeCAD/pull/19411 | random | ocr | complete | 399.6 | 22 | 0.409 | 0.474 | 0.439 |
| https://github.com/microsoft/typescript-go/pull/831 | random | boxie | failed / partial | 5.3 | 0 | 0.000 | 0.000 | 0.000 |
| https://github.com/microsoft/typescript-go/pull/831 | random | ocr | complete | 1093.2 | 9 | 0.444 | 0.267 | 0.333 |
| https://github.com/elastic/elasticsearch/pull/126376 | random | boxie | failed / partial | 145.7 | 0 | 0.000 | 0.000 | 0.000 |
| https://github.com/elastic/elasticsearch/pull/126376 | random | ocr | complete | 363.4 | 0 | 0.000 | 0.000 | 0.000 |
| https://github.com/valkey-io/valkey/pull/1485 | random | boxie | partial / timeout | 793.9 | 4 | 0.000 | 0.000 | 0.000 |
| https://github.com/valkey-io/valkey/pull/1485 | random | ocr | complete | 874.5 | 7 | 0.286 | 0.250 | 0.267 |
| https://github.com/vllm-project/vllm/pull/12608 | random | boxie | queued | — | — | pending | pending | pending |
| https://github.com/vllm-project/vllm/pull/12608 | random | ocr | queued | — | — | pending | pending | pending |
| https://github.com/microsoft/typescript-go/pull/1000 | random | boxie | queued | — | — | pending | pending | pending |
| https://github.com/microsoft/typescript-go/pull/1000 | random | ocr | queued | — | — | pending | pending | pending |
| https://github.com/astral-sh/uv/pull/12941 | random | boxie | queued | — | — | pending | pending | pending |
| https://github.com/astral-sh/uv/pull/12941 | random | ocr | queued | — | — | pending | pending | pending |
| https://github.com/comfyanonymous/ComfyUI/pull/6542 | random | boxie | queued | — | — | pending | pending | pending |
| https://github.com/comfyanonymous/ComfyUI/pull/6542 | random | ocr | queued | — | — | pending | pending | pending |
| https://github.com/langflow-ai/langflow/pull/5896 | random | boxie | queued | — | — | pending | pending | pending |
| https://github.com/langflow-ai/langflow/pull/5896 | random | ocr | queued | — | — | pending | pending | pending |
| https://github.com/comfyanonymous/ComfyUI/pull/9560 | random | boxie | queued | — | — | pending | pending | pending |
| https://github.com/comfyanonymous/ComfyUI/pull/9560 | random | ocr | queued | — | — | pending | pending | pending |
| https://github.com/gofr-dev/gofr/pull/1681 | random | boxie | queued | — | — | pending | pending | pending |
| https://github.com/gofr-dev/gofr/pull/1681 | random | ocr | queued | — | — | pending | pending | pending |
| https://github.com/sveltejs/svelte/pull/15250 | random | boxie | queued | — | — | pending | pending | pending |
| https://github.com/sveltejs/svelte/pull/15250 | random | ocr | queued | — | — | pending | pending | pending |
| https://github.com/microsoft/PowerToys/pull/40814 | random | boxie | queued | — | — | pending | pending | pending |
| https://github.com/microsoft/PowerToys/pull/40814 | random | ocr | queued | — | — | pending | pending | pending |
