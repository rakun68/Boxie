// Several reviews of one change as one list: recall comes from merging independent passes (SWR-Bench:
// five merged Gemini reviews raised F1 19.4 -> 23.8; research/review-tools-survey.md), precision from
// dropping repeats, which the AACR scorer counts as misses. Uses the live pipeline's deduplicator:
// nearby similar diagnoses, or identical diagnoses with a shared external definition. The more severe
// stays, with provenance in `by` and affected fix sites in `locations`.
//
//   node lib/merge-reviews.mjs <out.json> <run-dir> [<run-dir> ...]   -> prints a one-line count
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { merge } from "../image/review-merge.mjs";
export { merge, same } from "../image/review-merge.mjs";

const main = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (main) {
  const [out, ...dirs] = process.argv.slice(2);
  if (!out || !dirs.length) { console.error("usage: node lib/merge-reviews.mjs <out.json> <run-dir>..."); process.exit(2); }
  const lists = dirs.map((d) => { try { return { by: path.basename(d), findings: JSON.parse(fs.readFileSync(path.join(d, "findings.json"), "utf8")) }; } catch { return { by: path.basename(d), findings: [] }; } });
  const m = merge(lists);
  fs.writeFileSync(out, JSON.stringify(m, null, 1));
  console.log(`merged ${lists.reduce((n, l) => n + (l.findings?.length ?? 0), 0)} findings from ${lists.length} review(s) into ${m.length} (${m.filter((f) => f.by.length > 1).length} raised by more than one)`);
}
