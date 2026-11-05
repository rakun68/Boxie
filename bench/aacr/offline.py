"""Rescore saved review findings under another merge, without running a review: the consolidation step
(lib/consolidate.mjs) tuned on findings already on disk, judged like smoke.py.

    source "$AACR_DIR/env.sh"
    python bench/aacr/offline.py --label off1 --ids lvgl__lvgl@e526b2a --variants ocr=ocr2:raw,cons=ocr2+box2:cons

A source is `ocr30` (bench30 OCR result), `ocrN` (the smokeN OCR run) or `boxN` / `box30` (the smokeN or
fresh-high Boxie run), `hocr:<label>` / `hbox:<label>` (the two halves of a smoke hybrid run), `oocr:<label>` (a smoke OCR arm), `d1:<label>` / `d2:<label>` or `duoN:<label>` / `trioN:<label>` (one run of a smoke duo or trio arm), `drop:<label>` (what its consolidation scored out), or `prose` (lib/prose.mjs on the diff, once per PR). Modes: raw (one source as it is), merge (lib/merge-reviews.mjs, deterministic),
cons (merge-reviews with the diff: one model call per file), cons-M-S (the same with min M, lone-fanout min S). Results go to
evaluation/results/offline/<label>/; state.json holds every score. Nothing is retried.
"""
import argparse, json, os, re, sys, tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from smoke import BOX, EV, MODEL, sh, save, score  # noqa: E402


def source_dir(src, inst, work):
    sha, project = inst["instance_id"].split("@")[1], inst["repo"].replace("/", "__").lower()
    if src == "ocr30":
        r = json.loads((EV / "results/bench30/ocr/fresh-high" / (inst["instance_id"] + ".json")).read_text(encoding="utf-8"))
        d = work / src
        d.mkdir(parents=True, exist_ok=True)
        conv = "import {toFinding} from './lib/ocr.mjs'; import fs from 'node:fs'; const c=JSON.parse(fs.readFileSync(0,'utf8'));" \
               "fs.writeFileSync(process.argv[1], JSON.stringify(c.map(toFinding)));"
        p = sh("node", "--input-type=module", "-e", conv, d / "findings.json", cwd=BOX, input=json.dumps(r["review"]["comments"]))
        if p.returncode:
            sys.exit(p.stderr)
        return d
    if src == "prose":
        d = work / "prose"
        if not (d / "findings.json").exists():
            p = sh("node", BOX / "lib/prose.mjs", work / "change.diff", d)
            print("  " + (p.stdout + p.stderr).strip()[-300:], flush=True)
        return d
    if src.startswith("drop:"):
        # The comments a smoke duo arm's consolidation scored out, as one list.
        d = work / "drop"
        d.mkdir(exist_ok=True)
        (d / "findings.json").write_bytes((BOX / "runs" / project / f"aacr-{src[5:]}-duo-{sha}-merged.dropped.json").read_bytes())
        return d
    m = re.match(r"(?:d|duo|trio)([123]):(.+)$", src)
    if m:
        arm = "trio" if src.startswith("trio") else "duo"
        return BOX / "runs" / project / f"aacr-{m[2]}-{arm}-{sha}-review-both-ocr{'' if m[1] == '1' else m[1]}"
    if src.startswith("oocr:"):
        return BOX / "runs" / project / f"aacr-{src[5:]}-ocr-{sha}-review-both-ocr"
    if src.startswith("h") and ":" in src:
        role, label = src[1:].split(":")
        return BOX / "runs" / project / f"aacr-{label}-hybrid-{sha}-review-both-{'ocr' if role == 'ocr' else 'gemini'}"
    if src.startswith("ocr"):
        return BOX / "runs" / project / f"aacr-smoke{src[3:]}-ocr-{sha}-review-both-ocr"
    label = "fresh-high" if src == "box30" else f"smoke{src[3:]}-boxie"
    for name in (f"aacr-{label}-{sha}-review-both-gemini", f"aacr-{label}-recovered-{sha}-review-both-gemini"):
        if (BOX / "runs" / project / name / "findings.json").exists():
            return BOX / "runs" / project / name
    return BOX / "runs" / project / f"aacr-{label}-{sha}-review-both-gemini"


def comments_of(findings):
    return [{"path": f.get("file", ""), "start_line": f.get("line") or None, "end_line": f.get("end_line") or f.get("line") or None,
             "content": (f.get("issue", "") + "\n" + f.get("scenario", "")).strip()} for f in findings if isinstance(f, dict)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", required=True)
    ap.add_argument("--ids", required=True)
    ap.add_argument("--variants", required=True, help="name=src[+src...]:mode, comma-separated")
    o = ap.parse_args()
    os.environ.setdefault("JUDGE_MODEL", MODEL)
    os.environ.setdefault("CONSOLIDATE_MODEL", MODEL)
    os.environ.setdefault("PROSE_MODEL", MODEL)
    os.environ.setdefault("OMNIROUTE_API_KEY", os.environ.get("JUDGE_API_KEY", ""))
    os.environ.setdefault("OMNIROUTE_HOST_URL", os.environ.get("JUDGE_BASE_URL", "http://localhost:20128/v1"))
    out = EV / "results/offline" / o.label
    out.mkdir(parents=True, exist_ok=True)
    sfile = out / "state.json"
    state = json.loads(sfile.read_text(encoding="utf-8")) if sfile.exists() else {}
    instances = {x["instance_id"]: x for x in map(json.loads, (EV / "data/bench30.jsonl").read_text(encoding="utf-8").splitlines())}
    for iid in o.ids.split(","):
        inst = instances[iid]
        work = Path(tempfile.mkdtemp(prefix="off-", dir=out))
        repo = EV / "repo" / inst["repo"].replace("/", "__")
        diff = work / "change.diff"
        diff.write_text(sh("git", "-C", repo, "diff", inst["base_commit"] + "..." + inst["head_commit"]).stdout, encoding="utf-8")
        for spec in o.variants.split(","):
            name, rest = spec.split("=")
            srcs, mode = rest.rsplit(":", 1)
            key = f"{iid}|{name}"
            if state.get(key, {}).get("score"):
                continue
            dirs = [source_dir(s, inst, work) for s in srcs.split("+")]
            msg = ""
            if mode == "raw" and srcs == "ocr30":
                comments = json.loads((EV / "results/bench30/ocr/fresh-high" / (iid + ".json")).read_text(encoding="utf-8"))["review"]["comments"]
            elif mode == "raw":
                comments = comments_of(json.loads((dirs[0] / "findings.json").read_text(encoding="utf-8")))
            else:
                merged = work / f"{name}.json"
                # cons-M-S: consolidation with CONSOLIDATE_MIN=M and CONSOLIDATE_SOLO_MIN=S.
                bars = dict(zip(("CONSOLIDATE_MIN", "CONSOLIDATE_SOLO_MIN"), mode.split("-")[1:])) if mode.startswith("cons-") else {}
                p = sh("node", BOX / "lib/merge-reviews.mjs", merged, *(["--diff", diff] if mode.startswith("cons") else []), *dirs,
                       env={**os.environ, **bars})
                msg = (p.stdout + p.stderr).strip()[-400:]
                comments = comments_of(json.loads(merged.read_text(encoding="utf-8")) if merged.exists() else [])
            rdir = out / name
            rdir.mkdir(exist_ok=True)
            save(rdir / (iid + ".json"), {"instance_id": iid, "repo": inst["repo"], "reviewer": "boxie", "label": name, "review": {"comments": comments}})
            s = score(inst, rdir, out / "score-raw" / name)
            state[key] = {"variant": name, "comments": len(comments), "merge": msg, "score": s}
            save(sfile, state)
            print(f"{iid} {name}: {len(comments)} comments, P {s.get('file_semantic_match_rate', '?')} R {s.get('file_semantic_recall_rate', '?')}"
                  f" ({s.get('matched_file_semantic_notes', '?')}/{s.get('expected_notes', '?')}) {msg[:160]}", flush=True)


if __name__ == "__main__":
    main()
