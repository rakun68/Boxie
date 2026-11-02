// The OCR review engine: alibaba/open-code-review (Apache-2.0) run on the host, its comments written as
// a Boxie review run (findings.json, final.md, summary.json, events.jsonl) that the ledger, `table` and
// the loop read like any other. research/ocr-design.md has how OCR works. AACR-Bench, same Gemini model
// (2026-11-02): OCR F1 0.290 at ~220 s a PR; Boxie's one-session reviewer F1 0.109 at ~1,180 s.
//
// OCR has no shell and no write tool (file_read, code_search, file_find, file_read_diff, code_comment,
// task_done), so it runs on the host, not in a container. It reads a detached worktree at the head, and
// its HOME is the run dir: a ~/.opencodereview/config.json would otherwise win over the env settings.
//
//   node lib/ocr.mjs review <repo> <base> <head> <run-dir> [--model M] [--effort low|medium|high]
//        [--concurrency N] [--max-tools N] [--timeout MIN] [--background-file F] [--paths "a b"]
//   node lib/ocr.mjs bin       the binary in use, or exit 1
//
// Env: OMNIROUTE_HOST_URL, OMNIROUTE_API_KEY; OCR_BIN (else `ocr` or `opencodereview` on PATH).
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

export function ocrBin(env = process.env) {
  const tries = [env.OCR_BIN, "ocr", "opencodereview"].filter(Boolean);
  for (const b of tries) {
    try { execFileSync(b, ["version"], { stdio: "ignore", timeout: 20000 }); return b; } catch { /* next */ }
  }
  return null;
}

// OCR's categories onto Boxie's; the original stays in `ocr_category`.
const CATEGORY = { bug: "logic", security: "security", performance: "performance", maintainability: "maintainability",
  test: "missing_test", style: "standard", documentation: "standard", other: "standard" };
const SEVERITY = new Set(["critical", "high", "medium", "low"]);

// One OCR comment as a Boxie finding. The first sentence is the conclusion; the rest is the scenario.
export function toFinding(c) {
  const text = String(c.content ?? "").trim();
  const m = text.match(/^(.{20,300}?[.!?])(\s|$)/s);
  const issue = (m ? m[1] : text.split("\n")[0]).replace(/\s+/g, " ").slice(0, 300);
  const scenario = text.slice(m ? m[1].length : text.split("\n")[0].length).trim();
  const f = {
    severity: SEVERITY.has(c.severity) ? c.severity : "low", confidence: "PLAUSIBLE",
    category: CATEGORY[c.category] ?? "standard", file: c.path ?? "", line: c.start_line ?? 0,
    issue, scenario, basis: "", source: "ocr", ocr_category: c.category ?? null,
  };
  if (c.end_line && c.end_line !== c.start_line) f.end_line = c.end_line;
  if (c.existing_code) f.existing_code = c.existing_code;
  if (c.suggestion_code) f.suggestion = c.suggestion_code;
  return f;
}

export function finalText(findings, out) {
  const lines = [`# Review by open-code-review (${out?.llm?.model ?? "?"})`, "", out?.message ?? "", ""];
  findings.forEach((f, i) => lines.push(`${i + 1}. **${f.severity}** \`${f.file}:${f.line}\` ${f.issue}${f.scenario ? `\n   ${f.scenario.replace(/\n/g, "\n   ")}` : ""}`));
  if (!findings.length) lines.push("No findings.");
  lines.push("", "```boxie-findings", JSON.stringify(findings, null, 1), "```", "");
  return lines.join("\n");
}

function git(repo, ...a) { return execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }

export async function review({ repo, base, head, dir, model, effort = "medium", concurrency = 8, maxTools = 0, timeoutMin = 15, backgroundFile = "", paths = [], env = process.env }) {
  const bin = ocrBin(env);
  if (!bin) throw new Error("open-code-review not found: npm install -g @alibaba-group/open-code-review, or set OCR_BIN");
  fs.mkdirSync(dir, { recursive: true });
  const home = path.join(dir, "ocr-home"), wt = path.join(dir, "worktree");
  fs.mkdirSync(home, { recursive: true });
  const t0 = Date.now();
  const headSha = git(repo, "rev-parse", head), baseSha = git(repo, "rev-parse", base);
  git(repo, "worktree", "add", "-q", "--detach", wt, headSha);
  const args = ["review", "--repo", wt, "--from", baseSha, "--to", headSha, "--format", "json", "--audience", "agent",
    "--output", path.join(dir, "ocr.json"), "--concurrency", String(concurrency), "--timeout", String(timeoutMin), "--effort", effort];
  if (maxTools > 0) args.push("--max-tools", String(maxTools));
  if (backgroundFile) args.push("--background-file", backgroundFile);
  // Paths outside the requested area are excluded (phase-review areas).
  if (paths.length) {
    const changed = git(repo, "diff", "--name-only", baseSha, headSha).split("\n").filter(Boolean);
    const keep = (f) => paths.some((p) => f === p || f.startsWith(p.replace(/\/?$/, "/")));
    const drop = changed.filter((f) => !keep(f));
    if (drop.length) args.push("--exclude", drop.join(","));
  }
  const ocrEnv = { ...env, HOME: home, USERPROFILE: home, OCR_LLM_URL: env.OMNIROUTE_HOST_URL || "http://localhost:20128/v1",
    OCR_LLM_TOKEN: env.OMNIROUTE_API_KEY || "", OCR_LLM_MODEL: model, OCR_LLM_PROTOCOL: "openai" };
  // OCR's own budget is per group and round; the process gets that times the rounds, plus 5 minutes.
  const rounds = { low: 1, medium: 2, high: 3 }[effort] ?? 2;
  const killAfter = (timeoutMin * rounds + 5) * 60e3;
  const errLog = fs.openSync(path.join(dir, "ocr.log"), "w");
  let timedOut = false;
  const code = await new Promise((resolve) => {
    const p = spawn(bin, args, { env: ocrEnv, stdio: ["ignore", "ignore", errLog], windowsHide: true });
    const t = setTimeout(() => { timedOut = true; p.kill(); }, killAfter);
    p.on("close", (c) => { clearTimeout(t); resolve(c ?? 1); });
    p.on("error", () => { clearTimeout(t); resolve(127); });
  });
  fs.closeSync(errLog);
  try { git(repo, "worktree", "remove", "--force", wt); } catch { fs.rmSync(wt, { recursive: true, force: true }); try { git(repo, "worktree", "prune"); } catch { /* best effort */ } }
  fs.rmSync(path.join(home, ".opencodereview", "sessions"), { recursive: true, force: true });

  let out = null;
  try { out = JSON.parse(fs.readFileSync(path.join(dir, "ocr.json"), "utf8")); } catch { /* none */ }
  const findings = Array.isArray(out?.comments) ? out.comments.map(toFinding) : null;
  if (findings) fs.writeFileSync(path.join(dir, "findings.json"), JSON.stringify(findings));
  fs.writeFileSync(path.join(dir, "final.md"), findings ? finalText(findings, out) : `open-code-review gave no result (exit ${code}). See ocr.log.\n`);
  // events.jsonl as the ledger reads it: one step per tool call, the token totals on the last step.
  const sm = out?.summary ?? {}, calls = out?.tool_calls?.total ?? 0;
  const ev = [];
  for (let i = 0; i < Math.max(1, calls); i++) ev.push({ type: "step_start" });
  ev.push({ type: "step_finish", part: { tokens: { input: (sm.input_tokens ?? 0) - (sm.cache_read_tokens ?? 0), output: sm.output_tokens ?? 0,
    reasoning: 0, cache: { read: sm.cache_read_tokens ?? 0, write: sm.cache_write_tokens ?? 0 } } } });
  fs.writeFileSync(path.join(dir, "events.jsonl"), findings ? ev.map((e) => JSON.stringify(e)).join("\n") + "\n" : "");
  const seconds = Math.round((Date.now() - t0) / 1000);
  // OCR exits non-zero only when every item failed; partial results exit 0 (research/ocr-design.md §7).
  const agentExit = timedOut ? 124 : findings ? 0 : code || 1;
  const summary = { branch: head, base: baseSha, head: headSha, model, engine: "ocr", commits: 0, setup_exit: 0, agent_exit: agentExit,
    test_exit: -1, first_test_exit: -1, seconds, phase_seconds: { setup: 0, agent: seconds, test: 0 }, review: true, review_violation: false,
    deps: "skipped", ocr: { status: out?.status ?? null, files_reviewed: sm.files_reviewed ?? null, groups: (out?.groups ?? []).map((g) => g.files?.length ?? 0),
      tool_calls: calls, warnings: (out?.warnings ?? []).length } };
  fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify(summary, null, 2));
  return summary;
}

const main = process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")).toLowerCase();
if (main) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "bin") { const b = ocrBin(); if (!b) process.exit(1); console.log(b); process.exit(0); }
  if (cmd !== "review" || rest.length < 4) {
    console.error("usage: node lib/ocr.mjs review <repo> <base> <head> <run-dir> [--model M] [--effort E] [--concurrency N] [--max-tools N] [--timeout MIN] [--background-file F] [--paths \"a b\"]\n       node lib/ocr.mjs bin");
    process.exit(2);
  }
  const [repo, base, head, dir, ...flags] = rest;
  const opt = (k, d) => { const i = flags.indexOf(k); return i >= 0 ? flags[i + 1] : d; };
  try {
    const s = await review({ repo, base, head, dir, model: opt("--model", process.env.OCR_MODEL), effort: opt("--effort", "medium"),
      concurrency: Number(opt("--concurrency", 8)), maxTools: Number(opt("--max-tools", 0)), timeoutMin: Number(opt("--timeout", 15)),
      backgroundFile: opt("--background-file", ""), paths: opt("--paths", "").split(" ").filter(Boolean) });
    console.log(`ocr: ${s.ocr.status ?? "no result"}, exit ${s.agent_exit}, ${s.seconds} s, ${s.ocr.files_reviewed ?? 0} files, ${s.ocr.tool_calls} tool calls`);
  } catch (e) { console.error(`ocr: ${e.message}`); process.exit(1); }
}
