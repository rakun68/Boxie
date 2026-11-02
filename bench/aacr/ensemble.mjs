// Offline ensemble: two arms' existing AACR results merged through lib/merge-reviews.mjs, no rerun.
//   node bench/aacr/ensemble.mjs <boxie-dir> <evaluation-dir> boxie/advise ocr/gemini boxie/ensemble-offline
import fs from "node:fs"; import path from "node:path";
const [box, ev, a, b, out] = process.argv.slice(2);
const { merge } = await import((await import("node:url")).pathToFileURL(path.join(box, "lib/merge-reviews.mjs")).href);
const R = (arm) => path.join(ev, "results/sample5", arm);
fs.mkdirSync(R(out), { recursive: true });
const asF = (c) => ({ file: c.path, line: c.start_line ?? null, end_line: c.end_line ?? c.start_line ?? null, issue: String(c.content ?? "").split("\n")[0], scenario: String(c.content ?? "").split("\n").slice(1).join("\n"), severity: c.severity ?? "medium", _c: c });
for (const f of fs.readdirSync(R(a)).filter((x) => x.endsWith(".json") && !x.startsWith("metrics") && !x.includes(".merged"))) {
  const A = JSON.parse(fs.readFileSync(path.join(R(a), f), "utf8")), B = JSON.parse(fs.readFileSync(path.join(R(b), f), "utf8"));
  const m = merge([{ by: a, findings: (A.review?.comments ?? []).map(asF) }, { by: b, findings: (B.review?.comments ?? []).map(asF) }]);
  fs.writeFileSync(path.join(R(out), f), JSON.stringify({ instance_id: A.instance_id, repo: A.repo, reviewer: "boxie", label: out, duration_seconds: Math.max(A.duration_seconds ?? 0, B.duration_seconds ?? 0), review: { comments: m.map((x) => x._c) } }, null, 1));
  console.log(f, (A.review?.comments ?? []).length, "+", (B.review?.comments ?? []).length, "->", m.length);
}
