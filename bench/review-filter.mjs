// Replay saved candidates, without a model call, to measure validation prompt size.
// node bench/review-filter.mjs <review-run-dir> <bundles-full.json>
import fs from "node:fs";
import path from "node:path";
import { filterPrompt, diffOf } from "../image/filter.mjs";
import { findingsOf } from "../image/fanout.mjs";

const [dir, bundlesFile] = process.argv.slice(2);
if (!dir || !bundlesFile) throw new Error("usage: node bench/review-filter.mjs <review-run-dir> <bundles-full.json>");
const bundles = JSON.parse(fs.readFileSync(bundlesFile, "utf8")).bundles;
const findings = fs.readdirSync(path.join(dir, "parts")).filter((f) => f.endsWith(".final.md"))
  .flatMap((f) => findingsOf(fs.readFileSync(path.join(dir, "parts", f), "utf8")) ?? []);
const diff = bundles.map((b) => b.diff).join("\n");
const oldItems = findings.map((f, i) => ({ id: i + 1, file: f.file, line: f.line, severity: f.severity,
  issue: f.issue, scenario: String(f.scenario ?? "").slice(0, 600), existing_code: String(f.existing_code ?? "").slice(0, 400) }));
const old = `## Diff\n\n\`\`\`\`diff\n${diffOf(diff, findings.map((f) => f.file)).slice(0, 120000)}\n\`\`\`\`\n\n## Comments\n\n${JSON.stringify(oldItems, null, 1)}`;
const packets = []; for (let i = 0; i < findings.length; i += 8) packets.push(filterPrompt(findings.slice(i, i + 8), diff));
console.log(JSON.stringify({ candidates: findings.length, before_chars: old.length,
  after_chars: packets.reduce((n, p) => n + p.length, 0), max_request_chars: Math.max(0, ...packets.map((p) => p.length)),
  requests: packets.length, note: "Prompt characters only; historical candidates have no captured caller evidence. Not a latency or quality benchmark." }, null, 2));
