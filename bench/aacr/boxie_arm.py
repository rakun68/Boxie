"""Boxie's arm of the AACR-Bench comparison (docs/aacr-bench.md): one Boxie review per sample PR, written
in the OCR result format the AACR scorer reads (`pipeline --stage eval --reviewer ocr`).

    python bench/aacr/boxie_arm.py --label gemini-advise --roles review-both-gemini --advise
    python bench/aacr/boxie_arm.py --label ocr --roles review-both-ocr
    python bench/aacr/boxie_arm.py --label ensemble --roles review-both-ocr,review-both-gemini --advise

AACR_DIR (default runs/.tmp/aacr) holds the AACR checkout (aacr-bench/evaluation) and env.sh, which loads
the OmniRoute key without printing it. Results go to evaluation/results/<sample>/boxie/<label>/. A sample
whose result file exists is skipped: delete it to rerun. Every run's verdict, exit code, seconds and
tokens are recorded, so a failed review is never read as an empty one (the first run logged a setup
failure and a timeout as exit 0).
"""
import argparse, json, os, subprocess, sys, time
from pathlib import Path

BOX = Path(__file__).resolve().parents[2]
BASH = os.environ.get("BOXIE_BASH", "C:/Program Files/Git/bin/bash.exe" if os.name == "nt" else "bash")


def sh(*a, **k):
    return subprocess.run(a, capture_output=True, text=True, encoding="utf-8", errors="replace", **k)


def read_json(p, default=None):
    try:
        return json.loads(Path(p).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default


def run_tokens(run):
    """Token totals of one run from the ledger (delegate.sh stats json run <name>)."""
    st = sh(BASH, str(BOX / "delegate.sh"), "stats", "json", "run", run)
    try:
        r = json.loads(st.stdout)
        return (r.get("event") or {}).get("tokens")
    except (json.JSONDecodeError, AttributeError):
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", required=True)
    ap.add_argument("--roles", default="review-both-gemini")
    ap.add_argument("--advise", action="store_true")
    ap.add_argument("--sample", default="sample5")
    ap.add_argument("--only", default="", help="comma-separated instance ids")
    o = ap.parse_args()

    ev = Path(os.environ.get("AACR_DIR", BOX / "runs/.tmp/aacr")) / "aacr-bench/evaluation"
    out_dir = ev / "results" / o.sample / "boxie" / o.label
    out_dir.mkdir(parents=True, exist_ok=True)
    roles = [r for r in o.roles.split(",") if r]
    only = set(filter(None, o.only.split(",")))
    for line in (ev / "data" / f"{o.sample}.jsonl").read_text(encoding="utf-8").splitlines():
        inst = json.loads(line)
        iid = inst["instance_id"]
        if only and iid not in only:
            continue
        out = out_dir / (iid.replace("/", "__") + ".json")
        if out.exists():
            continue
        repo = ev / "repo" / inst["repo"].replace("/", "__")
        project = repo.name.lower()
        name = f"aacr-{o.label}-" + iid.split("@")[1]
        sh("git", "-C", str(repo), "branch", "-f", "aacr-base", inst["base_commit"])
        sh("git", "-C", str(repo), "branch", "-f", "aacr-head", inst["head_commit"])
        t0 = time.monotonic()
        p = sh(BASH, str(BOX / "delegate.sh"), "review", repo.as_posix(), "aacr-head", "--against", "aacr-base",
               "--roles", ",".join(roles), "--name", name, *(["--advise"] if o.advise else []),
               env={**os.environ, "BOXIE_PROJECT_ENV": str(BOX / "projects/bench.env"), "BOXIE_HERDR": "0"})
        secs = time.monotonic() - t0
        runs = [BOX / "runs" / project / f"{name}-{r.split('@')[0]}" for r in roles]
        per_run = []
        for run in runs:
            verdict = (run / "verdict.txt").read_text(encoding="utf-8").strip() if (run / "verdict.txt").exists() else "no verdict"
            s = read_json(run / "summary.json", {})
            per_run.append({"run": run.name, "verdict": verdict, "seconds": s.get("seconds"), "agent_exit": s.get("agent_exit"),
                            "findings": len(read_json(run / "findings.json", []) or []), "tokens": run_tokens(run.name)})
        if len(runs) > 1:
            merged = out_dir / (iid.replace("/", "__") + ".merged.json")
            sh("node", str(BOX / "lib/merge-reviews.mjs"), str(merged), *[str(r) for r in runs])
            findings = read_json(merged, []) or []
        else:
            findings = read_json(runs[0] / "findings.json", []) or []
        comments = [{"path": f.get("file", ""), "start_line": f.get("line") or None, "end_line": f.get("end_line") or f.get("line") or None,
                     "content": (f.get("issue", "") + "\n" + f.get("scenario", "")).strip(),
                     "severity": f.get("severity"), "category": f.get("ocr_category") or f.get("category")}
                    for f in findings if isinstance(f, dict)]
        out.write_text(json.dumps({"instance_id": iid, "repo": inst["repo"], "reviewer": "boxie", "label": o.label, "roles": roles,
                                   "advise": o.advise, "duration_seconds": round(secs, 2), "exit_code": p.returncode, "runs": per_run,
                                   "review": {"comments": comments}, "stderr": p.stderr[-4000:]}, ensure_ascii=False, indent=2), encoding="utf-8")
        print(iid, "exit", p.returncode, "comments", len(comments), "secs", round(secs),
              "|", "; ".join(f"{r['run']}: {r['verdict'][:40]}" for r in per_run), flush=True)


if __name__ == "__main__":
    sys.exit(main())
