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
//      REVIEW_FILTER_MIN (default 3), FILTER_MODEL (default MODEL), OMNIROUTE_BASE_URL, OMNIROUTE_API_KEY.
// Out: /out/parts/<i>.{prompt.md,events.jsonl,final.md}, /out/events.jsonl (all parts), /out/final.md,
//      /out/findings.json, /out/fanout.json. Exit 0, 124 when a part hit its time limit, else 1.
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { anchor } from "./anchor.mjs";
import { filter } from "./filter.mjs";

const OUT = process.env.OUT_DIR || "/out", IN = process.env.IN_DIR || "/in";
const env = process.env;

const BLOCK = /```[^\n`]*?(?:\r?\n[ \t]*)?boxie-findings[^\n]*\n([\s\S]*?)\n\s*```/;
export function findingsOf(text) {
  const m = String(text ?? "").match(BLOCK);
  const tries = m ? [m[1]] : [...String(text ?? "").matchAll(/```(?:json)?[ \t]*\r?\n([\s\S]*?)\n\s*```/g)].map((x) => x[1]).reverse();
  for (const t of tries) {
    try { const v = JSON.parse(t); if (Array.isArray(v)) return v; if (Array.isArray(v?.findings)) return v.findings; } catch { /* next */ }
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

// Same file, lines within 3, and the same opening words: one finding, the more severe kept.
const RANK = { critical: 0, high: 1, medium: 2, low: 3 };
export function dedupe(fs1) {
  const key = (f) => String(f.issue ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, "").split(/\s+/).slice(0, 8).join(" ");
  const out = [];
  for (const f of fs1) {
    const twin = out.find((g) => g.file === f.file && Math.abs((g.line ?? 0) - (f.line ?? 0)) <= 3 && key(g) === key(f));
    if (!twin) { out.push(f); continue; }
    if ((RANK[f.severity] ?? 9) < (RANK[twin.severity] ?? 9)) out[out.indexOf(twin)] = f;
  }
  return out.sort((a, b) => (RANK[a.severity] ?? 9) - (RANK[b.severity] ?? 9));
}

export function partPrompt(base, b, i, n) {
  const fence = (t) => "`".repeat(Math.max(4, ...[...String(t).matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return [base.trimEnd(), "", `# Your part of the review (${i + 1} of ${n})`, "",
    "Review these files; report findings only in them:", ...b.files.map((f) => `- \`${f}\``), "",
    ...(b.others?.length ? ["Other files this change touches (other reviewers take them; read one only when a seam needs it):", ...b.others.slice(0, 60).map((f) => `- \`${f}\``), ""] : []),
    ...(b.rules ? ["## Review checklist for these files", "", b.rules.trim(), ""] : []),
    "## The diff of your part", "", fence(b.diff ?? "") + "diff", String(b.diff ?? "").trimEnd(), fence(b.diff ?? ""), "",
    "End with the `boxie-findings` block (`[]` when you found nothing)."].join("\n");
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
  // Cut at the time limit: abort the server's turn, then one short turn for the findings so far.
  if ((exit === 124 || exit === 137) && sid) {
    cut = "timeout";
    if (env.ATTACH) await fetch(`${env.ATTACH}/session/${sid}/abort`, { method: "POST" }).catch(() => {});
    await opencode(["--session", sid, "--title", title, "Time is up. Do not read or run anything more. Write your findings now, ending with the `boxie-findings` block."], null, Number(env.REVIEW_REPORT_MIN || 5), ev);
    recover(ev);
    ({ last } = lastText(fs.readFileSync(ev, "utf8")));
  } else if (exit === 0 && sid && findingsOf(last) === null) {
    await opencode(["--session", sid, "--title", title, "Your last message has no readable `boxie-findings` block. Do not review again. Reply with only that fenced block: a JSON array of your findings, `[]` when there are none."], null, 5, ev);
    recover(ev);
    const again = lastText(fs.readFileSync(ev, "utf8")).last;
    if (findingsOf(again) !== null) last = `${last}\n\n${again}`;
  }
  fs.writeFileSync(path.join(dir, `${i + 1}.final.md`), last);
  const found = findingsOf(last);
  const steps = (fs.readFileSync(ev, "utf8").match(/"type":"step_start"/g) ?? []).length;
  return { files: b.files, exit, cut, seconds: Math.round((Date.now() - t0) / 1000), steps, session: sid || null,
    findings: Array.isArray(found) ? found.filter((f) => f && typeof f === "object").map((f) => ({ ...f, part: i + 1 })) : null, last };
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
  let findings = dedupe(all), filtered = null;
  // The filter (filter.mjs) needs an OmniRoute id; a free opencode/* model has none.
  const fmodel = env.FILTER_MODEL || env.MODEL;
  if (env.REVIEW_FILTER !== "0" && findings.length && env.OMNIROUTE_API_KEY && fmodel && !fmodel.startsWith("opencode/")) {
    const r = await filter(findings, diffs, { model: fmodel, base: env.OMNIROUTE_BASE_URL, key: env.OMNIROUTE_API_KEY, min: Number(env.REVIEW_FILTER_MIN || 3) });
    findings = r.kept;
    filtered = { dropped: r.dropped.length, error: r.error };
    fs.writeFileSync(path.join(OUT, "filtered.json"), JSON.stringify(r.dropped, null, 1));
  }
  const dupes = all.length - findings.length - (filtered?.dropped ?? 0);
  const unread = results.filter((r) => r.findings === null).length;
  fs.writeFileSync(path.join(OUT, "findings.json"), JSON.stringify(findings));
  const final = [`# Review in ${n} part${n === 1 ? "" : "s"}`, "",
    ...results.map((r, i) => `## Part ${i + 1}: ${r.files.join(", ")}\n\n${r.findings === null ? "(no readable findings block)\n\n" : ""}${r.last.replace(BLOCK, "").trim()}\n`),
    `${findings.length} finding(s) after merging: ${dupes} duplicate(s) dropped, ${filtered ? `${filtered.dropped} dropped by the filter${filtered.error ? ` (${filtered.error})` : ""}` : "no filter"}, ${moved} placed by their quoted code.`, "",
    "```boxie-findings", JSON.stringify(findings, null, 1), "```", ""].join("\n");
  fs.writeFileSync(path.join(OUT, "final.md"), final);
  fs.writeFileSync(path.join(OUT, "fanout.json"), JSON.stringify({ parts: results.map(({ last, findings: f, ...r }) => ({ ...r, findings: f?.length ?? null })), merged: findings.length, anchored: moved, filtered, unreadable: unread }, null, 2));
  // REVIEW_PART_MIN cuts a part by design and its report turn writes what it found: that is a review.
  // Only a cut part with no readable findings makes the whole a timeout (vllm smoke, 2026-11-02).
  if (results.some((r) => r.cut && r.findings === null)) return 124;
  // A part that wrote no readable block and ran fine is still a review: its prose is in final.md.
  return results.every((r) => r.exit === 0) ? 0 : 1;
}

if (process.argv[1] && path.basename(process.argv[1]) === "fanout.mjs") main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
