// Several reviews of one change as one list: recall comes from merging independent passes (SWR-Bench:
// five merged Gemini reviews raised F1 19.4 -> 23.8; research/review-tools-survey.md), precision from
// dropping the repeats, which the AACR scorer counts as misses. Two findings are one when they sit in the
// same file within 3 lines and say the same thing (a quarter of their words shared, or the same quoted
// code); the more severe stays, with every reviewer that raised it in `by`.
//
//   node lib/merge-reviews.mjs <out.json> <run-dir> [<run-dir> ...]   -> prints a one-line count
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RANK = { critical: 0, high: 1, medium: 2, low: 3 };
const STOP = new Set("the a an of to in is are be and or for on with this that it its by as at from not no when if".split(" "));
const words = (s) => new Set(String(s ?? "").toLowerCase().replace(/[^a-z0-9_ ]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)));
const jaccard = (a, b) => { const x = words(a), y = words(b); if (!x.size || !y.size) return 0; let n = 0; for (const w of x) if (y.has(w)) n++; return n / (x.size + y.size - n); };
const code = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

export function same(a, b) {
  if (a.file !== b.file) return false;
  const [a1, a2] = [a.line ?? 0, a.end_line ?? a.line ?? 0], [b1, b2] = [b.line ?? 0, b.end_line ?? b.line ?? 0];
  if (a1 - 3 > b2 || b1 - 3 > a2) return false;
  if (a.existing_code && code(a.existing_code) === code(b.existing_code)) return true;
  return jaccard(`${a.issue} ${a.scenario ?? ""}`, `${b.issue} ${b.scenario ?? ""}`) >= 0.25;
}

// lists: [{by, findings}] -> one list, most severe first.
export function merge(lists) {
  const out = [];
  for (const { by, findings } of lists) {
    for (const f of findings ?? []) {
      if (!f || typeof f !== "object") continue;
      const twin = out.find((g) => same(g, f));
      if (!twin) { out.push({ ...f, by: [by] }); continue; }
      if (!twin.by.includes(by)) twin.by.push(by);
      if ((RANK[f.severity] ?? 9) < (RANK[twin.severity] ?? 9)) Object.assign(twin, { ...f, by: twin.by });
    }
  }
  return out.sort((a, b) => (RANK[a.severity] ?? 9) - (RANK[b.severity] ?? 9) || b.by.length - a.by.length);
}

const main = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (main) {
  const [out, ...dirs] = process.argv.slice(2);
  if (!out || !dirs.length) { console.error("usage: node lib/merge-reviews.mjs <out.json> <run-dir>..."); process.exit(2); }
  const lists = dirs.map((d) => { try { return { by: path.basename(d), findings: JSON.parse(fs.readFileSync(path.join(d, "findings.json"), "utf8")) }; } catch { return { by: path.basename(d), findings: [] }; } });
  const m = merge(lists);
  fs.writeFileSync(out, JSON.stringify(m, null, 1));
  console.log(`merged ${lists.reduce((n, l) => n + (l.findings?.length ?? 0), 0)} findings from ${lists.length} review(s) into ${m.length} (${m.filter((f) => f.by.length > 1).length} raised by more than one)`);
}
