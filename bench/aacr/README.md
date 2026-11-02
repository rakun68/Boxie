# AACR-Bench harness

Boxie's reviews against alibaba's [AACR-Bench](https://huggingface.co/datasets/Alibaba-Aone/aacr-bench)
and open-code-review. Results and verdict: [docs/aacr-bench.md](../../docs/aacr-bench.md).

The AACR checkout, its scorer venv, the sample repos and the results stay outside git, under
`AACR_DIR` (default `runs/.tmp/aacr`). `env.sh` there loads the OmniRoute key from a project file
without printing it.

```bash
source "$AACR_DIR/env.sh"
python bench/aacr/boxie_arm.py --label gemini-advise --roles review-both-gemini --advise
cd "$AACR_DIR/aacr-bench/evaluation"
.venv/Scripts/python.exe -m pipeline run --stage eval --reviewer ocr \
  --dataset data/sample5.jsonl --results-dir results/sample5/boxie/gemini-advise
```

`--reviewer ocr` is deliberate: the scorer then reads Boxie's results in OCR's comment format. Each
result file records every run's verdict, exit code, seconds and tokens: a review that did not finish
shows as such, never as zero comments.
