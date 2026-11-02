// A review in parts: one OpenCode session per bundle of changed files (lib/bundle.mjs), run side by side
// against the container's server, each with its own diff, rules and step budget; then the findings are
// merged, placed on their lines (anchor.mjs) and deduplicated. One whole-diff session took 91-148 steps
// and 821-1,843 s on AACR-Bench (2026-11-02); open-code-review's grouped reviewers took 75-462 s.
//
//   node /opt/boxie/fanout.mjs      (run-task.sh, advise reviews; inputs below)
//
// In: /in/bundles.json [{files, diff, rules, others}], /out/prompt.md (preamble, context, task).
// Env: OC_MODEL, AGENT, ATTACH (server URL or ""), VARIANT, BRANCH, AGENT_MIN and REVIEW_PART_MIN (the
//      smaller is each part's minutes),
//      FANOUT (parts at once, default 6), REVIEW_REPORT_MIN (default 5); REVIEW_FILTER (0: off),
//      REVIEW_FILTER_MIN (default 6), FILTER_MODEL (default MODEL), OMNIROUTE_BASE_URL, OMNIROUTE_API_KEY.
// Out: /out/parts/<i>.{prompt.md,events.jsonl,final.md}, /out/events.jsonl (all parts), /out/final.md,
//      /out/findings.json, /out/fanout.json. Exit 0, 124 when a part hit its time limit, else 1.
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { anchor } from "./anchor.mjs";
import { filter } from "./filter.mjs";
import { merge } from "./review-merge.mjs";
import { readCheckpoint } from "./review-state.mjs";

const OUT = process.env.OUT_DIR || "/out", IN = process.env.IN_DIR || "/in";
const env = process.env;

const BLOCK = /```[^\n`]*?(?:\r?\n[ \t]*)?boxie-findings[^\n]*\n([\s\S]*?)\n\s*```/;
export function findingsOf(text) {
  const m = String(text ?? "").match(BLOCK);
  const tries = m ? [m[1]] : [...String(text ?? "").matchAll(/```(?:json)?[ \t]*\r?\n([\s\S]*?)\n\s*```/g)].map((x) => x[1]).reverse();
  // A raw tab or newline inside a string (existing_code copied verbatim) is invalid JSON: escaped, then
  // parsed again (cline part 1, 2026-11-02: one finding lost to "Bad control character").
  const escaped = (t) => t.replace(/"(?:[^"\\]|\\.)*"/g, (s) => s.replace(/[\u0000-\u001f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`));
  for (const t of tries) {
    for (const u of [t, escaped(t)]) {
      try { const v = JSON.parse(u); if (Array.isArray(v)) return v; if (Array.isArray(v?.findings)) return v.findings; } catch { /* next */ }
    }
  }
  return null;
}
export function lastText(events) {
  let last = "", sid = "";
  for (const l of String(events).split("\n")) {
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (e.sessionID) sid = e.sessionID;
    if (e.type === "text" && e.part?.text) last = e.part.text;
  }
  return { last, sid };
}

export const dedupe = (findings) => merge([{ findings }]);

export function partPrompt(base, b, i, n) {
  const fence = (t) => "`".repeat(Math.max(4, ...[...String(t).matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return [base.trimEnd(), "", `# Your part of the review (${i + 1} of ${n})`, "",
    "Review these files; report findings only in them:", ...b.files.map((f) => `- \`${f}\``), "",
    ...(b.others?.length ? ["Other files this change touches (other reviewers take them; read one only when a seam needs it):", ...b.others.slice(0, 60).map((f) => `- \`${f}\``), ""] : []),
    ...(b.rules ? ["## Review checklist for these files", "", b.rules.trim(), ""] : []),
    "## The diff of your part", "", fence(b.diff ?? "") + "diff", String(b.diff ?? "").trimEnd(), fence(b.diff ?? ""), "",
    `Use review_report with part=${i + 1} after each file. Submit only new findings, with evidence references to the definitions/callers you read (including other parts). Set complete=true only after all assigned files and their changed contracts are checked. Saved findings need not be repeated in prose. If the tool is unavailable, end with the boxie-findings block.`].join("\n");
}

function opencode(args, stdinText, minutes, outFile) {
  return new Promise((resolve) => {
    const fd = fs.openSync(outFile, "a"), err = fs.openSync(path.join(OUT, "opencode.log"), "a");
    const p = spawn("timeout", ["--kill-after=30", `${minutes}m`, "opencode", "run", "--auto", "--format", "json", "--agent", env.AGENT || "reviewer",
      "-m", env.OC_MODEL, ...(env.ATTACH ? ["--attach", env.ATTACH] : []), ...(env.VARIANT ? ["--variant", env.VARIANT] : []), ...args],
      { stdio: [stdinText == null ? "ignore" : "pipe", fd, err] });
    if (stdinText != null) { p.stdin.end(stdinText); }
    p.on("close", (c) => { fs.closeSync(fd); fs.closeSync(err); resolve(c ?? 1); });
    p.on("error", () => resolve(127));
  });
}

// `opencode run --attach` can exit before the last step reaches stdout (recover-final.mjs): every part
// runs attached, and the vllm smoke lost all 3 parts' final messages (2026-11-02). Rebuild it from the store.
const DB = path.join(env.HOME || "/home/node", ".local/share/opencode/opencode.db");
function recover(ev) {
  const { sid } = lastText(fs.readFileSync(ev, "utf8"));
  if (!sid || !fs.existsSync(DB)) return;
  spawnSync("node", ["--no-warnings", path.join(path.dirname(fileURLToPath(import.meta.url)), "recover-final.mjs"), ev, DB, sid], { stdio: "ignore" });
}

const PART_MIN = Math.min(Number(env.AGENT_MIN || 30), Number(env.REVIEW_PART_MIN || 7));

async function part(b, i, n, base) {
  const dir = path.join(OUT, "parts"); fs.mkdirSync(dir, { recursive: true });
  const ev = path.join(dir, `${i + 1}.events.jsonl`), t0 = Date.now();
  const prompt = partPrompt(base, b, i, n);
  fs.writeFileSync(path.join(dir, `${i + 1}.prompt.md`), prompt);
  const title = `${env.BRANCH || "review"}-part${i + 1}`;
  let exit = await opencode(["--title", title], prompt, PART_MIN, ev);
  recover(ev);
  let { last, sid } = lastText(fs.readFileSync(ev, "utf8"));
  // A part that died before its session started (a server hiccup, a locked database) runs once more.
  if (exit !== 0 && exit !== 124 && exit !== 137 && !sid) {
    await new Promise((r) => setTimeout(r, 3000));
    exit = await opencode(["--title", title], prompt, PART_MIN, ev);
    recover(ev);
    ({ last, sid } = lastText(fs.readFileSync(ev, "utf8")));
  }
  let cut = null;
  // Durable tool reports survive the cutoff; only legacy sessions need a report-only turn.
  let saved = readCheckpoint(OUT, i + 1);
  if ((exit === 124 || exit === 137) && sid) {
    cut = "timeout";
    if (env.ATTACH) await fetch(`${env.ATTACH}/session/${sid}/abort`, { method: "POST", signal: AbortSignal.timeout(5000) }).catch(() => {});
    if (!saved) await opencode(["--session", sid, "--title", title, "Time is up. Do not read or run anything more. Write your findings now, ending with the `boxie-findings` block."], null, Number(env.REVIEW_REPORT_MIN || 5), ev);
    recover(ev);
    ({ last } = lastText(fs.readFileSync(ev, "utf8")));
  } else if (exit === 0 && sid && !saved && findingsOf(last) === null) {
    await opencode(["--session", sid, "--title", title, "Your last message has no readable `boxie-findings` block. Do not review again. Reply with only that fenced block: a JSON array of your findings, `[]` when there are none."], null, 5, ev);
    recover(ev);
    const again = lastText(fs.readFileSync(ev, "utf8")).last;
    if (findingsOf(again) !== null) last = `${last}\n\n${again}`;
  }
  fs.writeFileSync(path.join(dir, `${i + 1}.final.md`), last);
  saved = readCheckpoint(OUT, i + 1);
  const found = saved?.findings ?? findingsOf(last);
  const complete = exit === 0 && !cut && (saved ? saved.complete : found !== null);
  const steps = (fs.readFileSync(ev, "utf8").match(/"type":"step_start"/g) ?? []).length;
  return { files: b.files, exit, cut, complete, reviewed_files: saved?.reviewed_files ?? (complete ? b.files : []), seconds: Math.round((Date.now() - t0) / 1000), steps, session: sid || null,
    findings: Array.isArray(found) ? found.filter((f) => f && typeof f === "object").map((f) => ({ ...f, part: i + 1 })) : null, last };
}

export function reviewStatus(results) {
  if (results.every((r) => r.complete)) return "complete";
  return results.some((r) => r.findings !== null) ? "partial" : "failed";
}

export async function main() {
  const bundles = JSON.parse(fs.readFileSync(path.join(IN, "bundles.json"), "utf8"));
  const base = fs.readFileSync(path.join(OUT, "prompt.md"), "utf8");
  const n = bundles.length, width = Math.max(1, Number(env.FANOUT || 6));
  const results = new Array(n);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, n) }, async () => {
    while (next < n) { const i = next++; results[i] = await part(bundles[i], i, n, base); }
  }));
  // Every part's events in one file: the ledger counts steps and tokens from it.
  fs.writeFileSync(path.join(OUT, "events.jsonl"), results.map((_, i) => { try { return fs.readFileSync(path.join(OUT, "parts", `${i + 1}.events.jsonl`), "utf8"); } catch { return ""; } }).join(""));
  const all = results.flatMap((r) => r.findings ?? []);
  const diffs = bundles.map((b) => b.diff ?? "").join("\n");
  const moved = anchor(all, diffs);
  let findings = dedupe(all).map((f) => ({ ...f, verification: "unverified" })), filtered = null;
  // The filter (filter.mjs) needs an OmniRoute id; a free opencode/* model has none.
  const fmodel = env.FILTER_MODEL || env.MODEL;
  if (env.REVIEW_FILTER !== "0" && findings.length && env.OMNIROUTE_API_KEY && fmodel && !fmodel.startsWith("opencode/")) {
    const r = await filter(findings, diffs, { model: fmodel, base: env.OMNIROUTE_BASE_URL, key: env.OMNIROUTE_API_KEY, min: Number(env.REVIEW_FILTER_MIN || 6) });
    findings = r.kept;
    filtered = { dropped: r.dropped.length, error: r.error };
    fs.writeFileSync(path.join(OUT, "filtered.json"), JSON.stringify(r.dropped, null, 1));
  }
  const dupes = all.length - findings.length - (filtered?.dropped ?? 0);
  const unread = results.filter((r) => r.findings === null).length;
  const status = reviewStatus(results);
  fs.writeFileSync(path.join(OUT, "findings.json"), JSON.stringify(findings));
  const final = [`# Review in ${n} part${n === 1 ? "" : "s"}: ${status}`, "",
    ...results.filter((r) => !r.complete).map((r) => `Incomplete: ${r.files.join(", ")} (${r.cut || `exit ${r.exit}, no completion report`})`), "",
    ...results.map((r, i) => `## Part ${i + 1}: ${r.files.join(", ")}\n\n${r.findings === null ? "(no readable findings block)\n\n" : ""}${r.last.replace(BLOCK, "").trim()}\n`),
    `${findings.length} finding(s) after merging: ${dupes} duplicate(s) dropped, ${filtered ? `${filtered.dropped} dropped by the filter${filtered.error ? ` (${filtered.error})` : ""}` : "no filter"}, ${moved} placed by their quoted code.`, "",
    "```boxie-findings", JSON.stringify(findings, null, 1), "```", ""].join("\n");
  fs.writeFileSync(path.join(OUT, "final.md"), final);
  fs.writeFileSync(path.join(OUT, "fanout.json"), JSON.stringify({ status, parts: results.map(({ last, findings: f, ...r }) => ({ ...r, findings: f?.length ?? null })), merged: findings.length, anchored: moved, filtered, unreadable: unread }, null, 2));
  return status === "complete" ? 0 : results.some((r) => r.cut || r.exit === 124 || r.exit === 137) ? 124 : 1;
}

if (process.argv[1] && path.basename(process.argv[1]) === "fanout.mjs") main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
