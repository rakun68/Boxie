// Several reviews of one change as one list: recall comes from merging independent passes (SWR-Bench:
// five merged Gemini reviews raised F1 19.4 -> 23.8; research/review-tools-survey.md), precision from
// dropping repeats, which the AACR scorer counts as misses. With the change's diff and an OmniRoute key,
// one model call per file groups the comments by problem and scores each (lib/consolidate.mjs);
// otherwise the live pipeline's deduplicator joins near-identical diagnoses only. The more severe stays,
// with provenance in `by` and affected fix sites in `locations`.
//
//   node lib/merge-reviews.mjs <out.json> [--diff FILE] <run-dir> [<run-dir> ...]   -> prints a one-line count
// Env (with --diff): OMNIROUTE_HOST_URL, OMNIROUTE_API_KEY, CONSOLIDATE_MODEL, CONSOLIDATE_MIN (default 2: drop 0-1).
// Scored-out comments go to <out>.dropped.json.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { merge } from "../image/review-merge.mjs";
import { consolidate } from "./consolidate.mjs";
export { merge, same } from "../image/review-merge.mjs";

const main = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (main) {
  const args = process.argv.slice(2), out = args.shift();
  const d = args.indexOf("--diff"), diffFile = d >= 0 ? args.splice(d, 2)[1] : null;
  const dirs = args;
  if (!out || !dirs.length) { console.error("usage: node lib/merge-reviews.mjs <out.json> [--diff FILE] <run-dir>..."); process.exit(2); }
  const lists = dirs.map((d) => { try { return { by: path.basename(d), findings: JSON.parse(fs.readFileSync(path.join(d, "findings.json"), "utf8")) }; } catch { return { by: path.basename(d), findings: [] }; } });
  const n = lists.reduce((k, l) => k + (l.findings?.length ?? 0), 0);
  const env = process.env, model = env.CONSOLIDATE_MODEL;
  if (diffFile && env.OMNIROUTE_API_KEY && model) {
    const r = await consolidate(lists, fs.readFileSync(diffFile, "utf8"), { model, base: env.OMNIROUTE_HOST_URL || "http://localhost:20128/v1",
      key: env.OMNIROUTE_API_KEY, min: Number(env.CONSOLIDATE_MIN ?? 2) });
    fs.writeFileSync(out, JSON.stringify(r.kept, null, 1));
    fs.writeFileSync(out.replace(/\.json$/, "") + ".dropped.json", JSON.stringify(r.dropped, null, 1));
    console.log(`consolidated ${n} findings from ${lists.length} review(s) into ${r.kept.length}, ${r.dropped.length} scored out${r.error ? ` (${r.error})` : ""}`);
  } else {
    const m = merge(lists);
    fs.writeFileSync(out, JSON.stringify(m, null, 1));
    console.log(`merged ${n} findings from ${lists.length} review(s) into ${m.length} (${m.filter((f) => f.by.length > 1).length} raised by more than one)`);
  }
}
