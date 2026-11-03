"""A small paired AACR-Bench check: a few PRs, one review at a time, each judged before the next starts.

    source "$AACR_DIR/env.sh"
    python bench/aacr/smoke.py --label smoke1 --ids lvgl__lvgl@e526b2a,ollama__ollama@2ed14f2

Arms: `boxie` (review-both-gemini, advise: the fanout reviewer), `ocr` (review-both-ocr: open-code-review in the
worker image), and `merged` (both runs merged by lib/merge-reviews.mjs, no extra review). Source, image and
settings are recorded in <out>/versions.json before the first review and checked before each one; a change
stops the run. <out>/state.json is the one durable record (atomic writes, one writer): a rerun resumes it.
Each judge call runs in its own process, so no client or lock outlives its event loop. Nothing is retried:
a failed review is recorded with its outcome (boxie_arm.outcome), never rerun into a success.

Env: JUDGE_* and OCR_LLM_* from env.sh; JUDGE_MODEL and OCR_LLM_MODEL default to the model below.
"""
import argparse, json, os, subprocess, sys, time
from pathlib import Path

BOX = Path(__file__).resolve().parents[2]
EV = Path(os.environ.get("AACR_DIR", BOX / "runs/.tmp/aacr")) / "aacr-bench/evaluation"
PY = str(EV / ".venv/Scripts/python.exe") if os.name == "nt" else str(EV / ".venv/bin/python")
MODEL = "antigravity/gemini-3.8-flash-high"
FROZEN = ["lib", "image", "delegate.sh", "boxie.conf", "bench/aacr"]


def sh(*a, **k):
    return subprocess.run([str(x) for x in a], capture_output=True, text=True, encoding="utf-8", errors="replace", **k)


def save(p, v):
    tmp = p.with_suffix(f".{os.getpid()}.tmp")
    tmp.write_text(json.dumps(v, indent=2), encoding="utf-8")
    tmp.replace(p)


def versions(env_file):
    dirty = sh("git", "-C", BOX, "status", "--porcelain", "--", *FROZEN).stdout.strip()
    if dirty:
        sys.exit(f"smoke: uncommitted changes in frozen paths, commit or stash first:\n{dirty}")
    return {"boxie": sh("git", "-C", BOX, "rev-parse", "HEAD").stdout.strip(),
            "image": sh("podman", "image", "inspect", "boxie:latest", "--format", "{{.Id}}").stdout.strip(),
            "ocr": sh("podman", "run", "--rm", "--entrypoint", "ocr", "boxie:latest", "version").stdout.strip().splitlines()[:1],
            "model": MODEL, "settings": env_file.read_text(encoding="utf-8").splitlines()}


SCORE = r"""
import json, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import schema, pipeline
inst = json.loads(sys.argv[2])
data = pipeline.run_eval_stage([schema.ReviewInstance.from_dict(inst, "smoke")], "ocr", Path(sys.argv[3]), Path(sys.argv[4]), 1, None)
print(json.dumps(data["summary"]))
"""


def score(inst, result_dir, raw_dir):
    p = sh(PY, "-c", SCORE, EV, json.dumps(inst), result_dir, raw_dir, cwd=EV, timeout=3600)
    if p.returncode:
        return {"error": p.stderr[-1500:]}
    return json.loads(p.stdout.strip().splitlines()[-1])


def merged_result(inst, out_dir, label):
    """The boxie and ocr runs of one PR merged, in the result format the scorer reads."""
    sha = inst["instance_id"].split("@")[1]
    project = inst["repo"].replace("/", "__").lower()
    runs = [BOX / "runs" / project / f"aacr-{label}-{arm}-{sha}-{role}" for arm, role in (("boxie", "review-both-gemini"), ("ocr", "review-both-ocr"))]
    merged = out_dir / (inst["instance_id"] + ".merged-findings.json")
    p = sh("node", BOX / "lib/merge-reviews.mjs", merged, *runs)
    findings = json.loads(merged.read_text(encoding="utf-8")) if merged.exists() else []
    comments = [{"path": f.get("file", ""), "start_line": f.get("line") or None, "end_line": f.get("end_line") or f.get("line") or None,
                 "content": (f.get("issue", "") + "\n" + f.get("scenario", "")).strip()} for f in findings if isinstance(f, dict)]
    return {"instance_id": inst["instance_id"], "repo": inst["repo"], "reviewer": "boxie", "label": f"{label}-merged",
            "merge_exit": p.returncode, "review": {"comments": comments}}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", required=True)
    ap.add_argument("--ids", required=True, help="comma-separated instance ids from data/bench30.jsonl")
    ap.add_argument("--arms", default="boxie,ocr,merged")
    o = ap.parse_args()
    os.environ.setdefault("JUDGE_MODEL", MODEL)
    os.environ.setdefault("OCR_LLM_MODEL", MODEL)
    if not os.environ.get("JUDGE_API_KEY"):
        sys.exit("smoke: JUDGE_API_KEY is empty: source env.sh first")
    out = EV / "results/smoke" / o.label
    out.mkdir(parents=True, exist_ok=True)
    env_file = out / "bench.env"
    if not env_file.exists():
        # The measured OCR baseline's settings (bench30 run.py): high effort, 30-minute groups.
        env_file.write_text((BOX / "projects/bench.env").read_text(encoding="utf-8") + "\nOCR_EFFORT=high\nOCR_TIMEOUT_MIN=30\n", encoding="utf-8")
    vfile, sfile = out / "versions.json", out / "state.json"
    now = versions(env_file)
    if vfile.exists():
        then = json.loads(vfile.read_text(encoding="utf-8"))
        if {k: then[k] for k in now} != now:
            sys.exit("smoke: source, image or settings changed since this label started: use a new --label")
    else:
        save(vfile, {**now, "started": time.strftime("%Y-%m-%dT%H:%M:%S%z")})
    state = json.loads(sfile.read_text(encoding="utf-8")) if sfile.exists() else {}
    instances = {x["instance_id"]: x for x in map(json.loads, (EV / "data/bench30.jsonl").read_text(encoding="utf-8").splitlines())}
    groups = {x["instance_id"]: x.get("group") for x in json.loads((BOX / "runs/.tmp/aacr/bench30/selection.json").read_text())["prs"]}
    env = {**os.environ, "BOXIE_PROJECT_ENV": str(env_file), "AUTO_GC": "0"}
    for iid in o.ids.split(","):
        inst = instances[iid]
        for arm in o.arms.split(","):
            key = f"{iid}|{arm}"
            if state.get(key, {}).get("score"):
                continue
            if versions(env_file) != now:
                sys.exit("smoke: source, image or settings changed during the run")
            rdir = out / arm
            rdir.mkdir(exist_ok=True)
            result = rdir / (iid + ".json")
            print(f"{time.strftime('%H:%M:%S')} {arm} {iid}", flush=True)
            if not result.exists():
                if arm == "merged":
                    save(result, merged_result(inst, out, o.label))
                else:
                    roles = "review-both-gemini" if arm == "boxie" else "review-both-ocr"
                    p = sh(sys.executable, BOX / "bench/aacr/boxie_arm.py", "--label", f"{o.label}-{arm}", "--sample", "bench30",
                           "--only", iid, "--roles", roles, *(["--advise"] if arm == "boxie" else []), env=env, timeout=7200)
                    made = EV / "results/bench30/boxie" / f"{o.label}-{arm}" / (iid + ".json")
                    if not made.exists():
                        state[key] = {"error": "no result", "stderr": p.stderr[-1500:]}
                        save(sfile, state)
                        continue
                    result.write_text(made.read_text(encoding="utf-8"), encoding="utf-8")
            r = json.loads(result.read_text(encoding="utf-8"))
            s = score(inst, rdir, out / "score-raw" / arm)
            state[key] = {"group": groups.get(iid), "outcome": r.get("outcome"), "seconds": r.get("duration_seconds"),
                          "comments": len(r["review"]["comments"]), "tokens": r["review"].get("summary"), "score": s}
            save(sfile, state)
            print(f"  {state[key]['outcome']} {state[key]['seconds']} s, {state[key]['comments']} comments,"
                  f" P {s.get('file_semantic_match_rate', '?')} R {s.get('file_semantic_recall_rate', '?')}", flush=True)
    print(json.dumps(state, indent=1))


if __name__ == "__main__":
    main()
