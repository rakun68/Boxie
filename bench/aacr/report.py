"""Pooled scores of a smoke.py label: per arm, per group (handpicked / random) and over all, with time and
tokens. P = new reference hits / comments, R = matched reference notes / expected notes, summed over PRs.

    python bench/aacr/report.py full3            # every PR
    python bench/aacr/report.py full3 --clean    # only PRs where no arm lost a file or failed to start

--clean drops a PR from every arm when any arm's open-code-review run still had failed files after its
retry, or an arm did not start: those are infrastructure losses, not review results (AACR full2, 2026-11-04).
"""
import argparse, collections, json, os
from pathlib import Path

BOX = Path(__file__).resolve().parents[2]
EV = Path(os.environ.get("AACR_DIR", BOX / "runs/.tmp/aacr")) / "aacr-bench/evaluation"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("label")
    ap.add_argument("--clean", action="store_true")
    o = ap.parse_args()
    state = json.loads((EV / "results/smoke" / o.label / "state.json").read_text(encoding="utf-8"))
    bad = {k.split("|")[0] for k, v in state.items()
           if v.get("outcome") == "startup_failed" or not v.get("score", {}).get("expected_notes") or any(after for _, after in v.get("ocr_failed", []))}
    rows = collections.defaultdict(lambda: [0, 0, 0, 0, 0.0, 0, 0])
    for k, v in state.items():
        iid, arm = k.split("|")
        if o.clean and iid in bad or not v.get("score"):
            continue
        s = v["score"]
        for g in ("all", v.get("group") or "?"):
            t = rows[(arm, g)]
            t[0] += s.get("matched_generated_notes", 0); t[1] += s.get("generated_notes", 0)
            t[2] += s.get("matched_file_semantic_notes", 0); t[3] += s.get("expected_notes", 0)
            t[4] += v.get("seconds") or 0; t[5] += s.get("total_tokens") or 0; t[6] += 1
    print(f"{o.label}{' (clean)' if o.clean else ''}: {len(bad)} PR(s) with a failed start or failed files: {sorted(bad)}")
    print(f"{'arm':8} {'group':11} {'PRs':>3} {'P':>6} {'R':>6} {'hits/cmts':>10} {'hits/exp':>9} {'secs':>7} {'tokens':>8}")
    for (arm, g), t in sorted(rows.items(), key=lambda x: (x[0][1], x[0][0])):
        print(f"{arm:8} {g:11} {t[6]:>3} {t[0] / max(t[1], 1):6.3f} {t[2] / max(t[3], 1):6.3f} {f'{t[0]}/{t[1]}':>10} {f'{t[2]}/{t[3]}':>9}"
              f" {round(t[4]):>7} {t[5] / 1e6:7.1f}M")


if __name__ == "__main__":
    main()
