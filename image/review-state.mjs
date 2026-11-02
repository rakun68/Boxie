// Durable checkpoints from the one reviewer of each bundle. Source evidence is captured here,
// inside the container, so the filter need not explore the repository a second time.
import fs from "node:fs";
import path from "node:path";
import { anchor } from "./anchor.mjs";

export function evidenceOf(refs, root) {
  const realRoot = fs.realpathSync(root), out = [];
  let budget = 12000;
  for (const r of (refs ?? []).slice(0, 4)) {
    if (!r || typeof r.file !== "string" || path.isAbsolute(r.file) || r.file.split(/[\\/]/).includes("..")) continue;
    if (!Number.isInteger(r.line) || r.line < 1) continue;
    try {
      const file = fs.realpathSync(path.resolve(root, r.file));
      const rel = path.relative(realRoot, file);
      if (rel.startsWith("..") || path.isAbsolute(rel) || fs.statSync(file).size > 1000000) continue;
      const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
      if (r.line > lines.length) continue;
      const start = Math.max(0, r.line - 11), end = Math.min(lines.length, r.line + 30);
      const text = lines.slice(start, end).map((l, i) => `${start + i + 1}: ${l}`).join("\n").slice(0, budget);
      if (!text) break;
      out.push({ file: r.file, line: r.line, start_line: start + 1, text });
      budget -= text.length;
    } catch { /* Unreadable evidence is not proof. */ }
  }
  return out;
}

export function readCheckpoint(out, part) {
  try { return JSON.parse(fs.readFileSync(path.join(out, "review-state", `${part}.json`), "utf8")); } catch { return null; }
}

export function checkpoint(args, session, { bundles, root, out }) {
  const b = bundles[args.part - 1];
  if (!Number.isInteger(args.part) || !b) throw new Error("Unknown review part");
  const prev = readCheckpoint(out, args.part);
  if (prev && prev.session !== session) throw new Error("This part belongs to another session");
  const owned = new Set(b.files);
  if (!Array.isArray(args.reviewed_files) || args.reviewed_files.some((f) => !owned.has(f))) throw new Error("Report only files assigned to your part");
  if (!Array.isArray(args.findings)) throw new Error("findings must be an array");
  const added = args.findings.map((f) => {
    if (!f || !owned.has(f.file) || typeof f.issue !== "string" || !f.issue.trim()
      || typeof f.existing_code !== "string" || !f.existing_code.trim()
      || !["critical", "high", "medium", "low"].includes(f.severity)) throw new Error("Each finding needs an owned file, issue, severity and quoted existing_code");
    const item = { ...f, confidence: "PLAUSIBLE", part: args.part, evidence: evidenceOf(f.evidence, root) };
    anchor([item], b.diff);
    return item;
  });
  const reviewed = [...new Set([...(prev?.reviewed_files ?? []), ...args.reviewed_files])];
  if (args.complete && reviewed.length !== owned.size) throw new Error("Complete requires every assigned file to be reviewed");
  const findings = [...(prev?.findings ?? []), ...added];
  const state = { session, reviewed_files: reviewed, complete: args.complete === true, findings };
  const dir = path.join(out, "review-state"); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${args.part}.json`);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(state)); fs.renameSync(`${file}.tmp`, file);
  return `Saved ${added.length} finding(s); ${reviewed.length}/${owned.size} files reviewed; ${state.complete ? "complete" : "checkpoint"}. Do not repeat saved findings.`;
}
