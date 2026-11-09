// The OCR review engine: alibaba/open-code-review (Apache-2.0) run on the host, its comments written as
// a Boxie review run (findings.json, final.md, summary.json, events.jsonl) that the ledger, `table` and
// the loop read like any other. research/ocr-design.md has how OCR works. AACR-Bench, same Gemini model
// (2026-11-02): OCR F1 0.290 at ~220 s a PR; Boxie's one-session reviewer F1 0.109 at ~1,180 s.
//
// OCR has no shell and no write tool (file_read, code_search, file_find, file_read_diff, code_comment,
// task_done). With OCR_IMAGE set it runs in that image (the worker image installs it): the repository's
// git dir is mounted read-only, cloned --shared inside and checked out at the head, and only the run dir
// is writable. Without it, OCR runs on the host against a detached worktree. Either way its HOME is the
// run dir: a ~/.opencodereview/config.json would otherwise win over the env settings.
//
//   node lib/ocr.mjs review <repo> <base> <head> <run-dir> [--model M] [--effort low|medium|high]
//        [--concurrency N] [--max-tools N] [--timeout MIN] [--background-file F] [--paths "a b"] [--include "glob,glob"]
//   node lib/ocr.mjs bin       the binary in use, or exit 1
//
// Env: OMNIROUTE_API_KEY. Host: OMNIROUTE_HOST_URL, OCR_BIN (else `ocr` or `opencodereview` on PATH).
// Container: OCR_IMAGE, OCR_ENGINE (podman), OCR_HOST_IP (host.docker.internal's address),
// OMNIROUTE_BASE_URL (as the container sees OmniRoute).
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

// The process's hard stop. OCR's own budget is per group and round, and `concurrency` groups run at once,
// so a change with more groups than that runs in waves. Groups are never more than files, so
// ceil(files / concurrency) waves is an upper bound. One wave was assumed before, which capped a
// whole-phase review (Lykos p18: 157 files) at 35 minutes.
export function killAfterMs({ timeoutMin = 15, effort = "medium", files = 1, concurrency = 8 } = {}) {
  const rounds = { low: 1, medium: 2, high: 3 }[effort] ?? 2;
  const waves = Math.max(1, Math.ceil(files / Math.max(1, concurrency)));
  return (timeoutMin * rounds * waves + 5) * 60e3;
}

function git(repo, ...a) { return execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }

// Pathspecs: one per line when the list has a newline (a path may hold a space), else space-separated.
export const splitPaths = (s) => String(s ?? "").split(String(s ?? "").includes("\n") ? "\n" : " ").filter(Boolean);

// The container run: `<engine> run` of OCR in the image, the repository read-only. Returns [cmd, args].
// The key goes by name (-e OCR_LLM_TOKEN), never on the command line.
export function containerCommand({ engine = "podman", image, name, hostIp, gitDir, dir, headSha, ocrArgs }) {
  const script = [
    "set -e", "git config --global --add safe.directory '*'",
    "git clone -q --shared --no-checkout /src.git /work/r", 'git -C /work/r checkout -q --detach "$HEAD_SHA"',
    'exec ocr "$@"'].join("\n");
  return [engine, ["run", "--rm", "--init", "--name", name, "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--add-host", `host.docker.internal:${hostIp || "host-gateway"}`, "-v", `${gitDir}:/src.git:ro`, "-v", `${dir}:/out`,
    "-e", "HOME=/out/ocr-home", "-e", `HEAD_SHA=${headSha}`, "-e", "OCR_LLM_URL", "-e", "OCR_LLM_TOKEN", "-e", "OCR_LLM_MODEL",
    "-e", "OCR_LLM_PROTOCOL", "--entrypoint", "bash", image, "-c", script, "ocr-run", ...ocrArgs]];
}

// A user rule file in OCR's HOME (the run dir): `include` globs bypass OCR's default path excludes, which
// drop every test file and Markdown. Lykos p18 phase (2026-11-09): 71 of 157 files left out (51 tests, 16
// docs), and they held 26 of the 54 medium+ findings the OpenCode reviewers raised on the same diff.
export function ruleFile(include = []) {
  return include.length ? JSON.stringify({ include }, null, 1) : null;
}

export async function review({ repo, base, head, dir, model, effort = "medium", concurrency = 8, maxTools = 0, timeoutMin = 15, backgroundFile = "", paths = [], include = [], env = process.env }) {
  const image = env.OCR_IMAGE || "";
  const bin = image ? null : ocrBin(env);
  if (!image && !bin) throw new Error("open-code-review not found: npm install -g @alibaba-group/open-code-review, or set OCR_BIN or OCR_IMAGE");
  fs.mkdirSync(dir, { recursive: true });
  const home = path.join(dir, "ocr-home"), wt = path.join(dir, "worktree");
  fs.mkdirSync(home, { recursive: true });
  const rule = ruleFile(include);
  if (rule) { fs.mkdirSync(path.join(home, ".opencodereview"), { recursive: true }); fs.writeFileSync(path.join(home, ".opencodereview", "rule.json"), rule); }
  const t0 = Date.now();
  const headSha = git(repo, "rev-parse", head), baseSha = git(repo, "rev-parse", base);
  // In the container, paths are the mounts: the clone at /work/r, the run dir at /out.
  const inDir = (f) => (image ? `/out/${path.basename(f)}` : f);
  if (image && backgroundFile && path.resolve(path.dirname(backgroundFile)) !== path.resolve(dir)) fs.copyFileSync(backgroundFile, path.join(dir, path.basename(backgroundFile)));
  if (!image) git(repo, "worktree", "add", "-q", "--detach", wt, headSha);
  const args = ["review", "--repo", image ? "/work/r" : wt, "--from", baseSha, "--to", headSha, "--format", "json", "--audience", "agent",
    "--output", inDir(path.join(dir, "ocr.json")), "--concurrency", String(concurrency), "--timeout", String(timeoutMin), "--effort", effort];
  if (maxTools > 0) args.push("--max-tools", String(maxTools));
  if (backgroundFile) args.push("--background-file", inDir(backgroundFile));
  // Paths outside the requested area are excluded (phase-review areas).
  const changed = git(repo, "diff", "--name-only", baseSha, headSha).split("\n").filter(Boolean);
  let reviewed = changed.length;
  if (paths.length) {
    const keep = (f) => paths.some((p) => f === p || f.startsWith(p.replace(/\/?$/, "/")));
    const drop = changed.filter((f) => !keep(f));
    if (drop.length) args.push("--exclude", drop.join(","));
    reviewed -= drop.length;
  }
  const ocrEnv = { ...env, HOME: home, USERPROFILE: home,
    OCR_LLM_URL: image ? env.OMNIROUTE_BASE_URL || "http://host.docker.internal:20128/v1" : env.OMNIROUTE_HOST_URL || "http://localhost:20128/v1",
    OCR_LLM_TOKEN: env.OMNIROUTE_API_KEY || "", OCR_LLM_MODEL: model, OCR_LLM_PROTOCOL: "openai" };
  const cname = `boxie-ocr-${path.basename(dir).replace(/[^a-zA-Z0-9_.-]/g, "-")}-${process.pid}`;
  const [cmd, cmdArgs] = image
    ? containerCommand({ engine: env.OCR_ENGINE || "podman", image, name: cname, hostIp: env.OCR_HOST_IP,
      gitDir: path.resolve(repo, git(repo, "rev-parse", "--git-common-dir")), dir: path.resolve(dir), headSha, ocrArgs: args })
    : [bin, args];
  const killAfter = killAfterMs({ timeoutMin, effort, files: reviewed, concurrency });
  let timedOut = false;
  const run = (extra, log) => new Promise((resolve) => {
    const errLog = fs.openSync(path.join(dir, log), "w");
    const p = spawn(cmd, [...cmdArgs, ...extra], { env: ocrEnv, stdio: ["ignore", "ignore", errLog], windowsHide: true });
    // Killing the engine client leaves the container running: remove it by name.
    const t = setTimeout(() => { timedOut = true; p.kill(); if (image) spawn(env.OCR_ENGINE || "podman", ["rm", "-f", cname], { stdio: "ignore", windowsHide: true }); }, killAfter);
    const done = (c) => { clearTimeout(t); fs.closeSync(errLog); resolve(c); };
    p.on("close", (c) => done(c ?? 1));
    p.on("error", () => done(127));
  });
  let code = await run([], "ocr.log");
  // Files whose review failed (a gateway 502, a group timeout) are retried once from the saved session:
  // OCR reuses the completed ones. AACR full2 (2026-11-04) lost 5 of 23 and 4 of 7 files to failures
  // that still exited 0, and a lost file is lost recall.
  const failedOf = (o) => (o?.manifest?.coverage?.failed ?? []).length;
  let first = null;
  try { first = JSON.parse(fs.readFileSync(path.join(dir, "ocr.json"), "utf8")); } catch { /* none */ }
  const retry = { failed: failedOf(first), retried: false };
  if (!timedOut && retry.failed && first?.session_id && env.OCR_RETRY !== "0") {
    fs.copyFileSync(path.join(dir, "ocr.json"), path.join(dir, "ocr.first.json"));
    const c2 = await run(["--resume", first.session_id], "ocr.retry.log");
    retry.retried = true;
    let again = null;
    try { again = JSON.parse(fs.readFileSync(path.join(dir, "ocr.json"), "utf8")); } catch { /* none */ }
    // A retry that left no result keeps the first one.
    if (again?.session_id) code = c2; else fs.copyFileSync(path.join(dir, "ocr.first.json"), path.join(dir, "ocr.json"));
  }
  if (!image) try { git(repo, "worktree", "remove", "--force", wt); } catch { fs.rmSync(wt, { recursive: true, force: true }); try { git(repo, "worktree", "prune"); } catch { /* best effort */ } }
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
  // Files still failed after the retry make the run partial, as a timed-out reviewer's (exit 124): its
  // findings stand, but it is not a complete review.
  const agentExit = timedOut || (findings && failedOf(out)) ? 124 : findings ? 0 : code || 1;
  const summary = { branch: head, base: baseSha, head: headSha, model, engine: "ocr", commits: 0, setup_exit: 0, agent_exit: agentExit,
    test_exit: -1, first_test_exit: -1, seconds, phase_seconds: { setup: 0, agent: seconds, test: 0 }, review: true, review_violation: false,
    deps: "skipped", ocr: { status: out?.status ?? null, files_reviewed: sm.files_reviewed ?? null, groups: (out?.groups ?? []).map((g) => g.files?.length ?? 0),
      tool_calls: calls, warnings: (out?.warnings ?? []).length, failed_files: failedOf(out), first_failed_files: retry.failed, retried: retry.retried } };
  fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify(summary, null, 2));
  return summary;
}

const main = process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")).toLowerCase();
if (main) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "bin") { const b = ocrBin(); if (!b) process.exit(1); console.log(b); process.exit(0); }
  if (cmd !== "review" || rest.length < 4) {
    console.error("usage: node lib/ocr.mjs review <repo> <base> <head> <run-dir> [--model M] [--effort E] [--concurrency N] [--max-tools N] [--timeout MIN] [--background-file F] [--paths \"a b\"] [--include \"glob,glob\"]\n       node lib/ocr.mjs bin");
    process.exit(2);
  }
  const [repo, base, head, dir, ...flags] = rest;
  const opt = (k, d) => { const i = flags.indexOf(k); return i >= 0 ? flags[i + 1] : d; };
  try {
    const s = await review({ repo, base, head, dir, model: opt("--model", process.env.OCR_MODEL), effort: opt("--effort", "medium"),
      concurrency: Number(opt("--concurrency", 8)), maxTools: Number(opt("--max-tools", 0)), timeoutMin: Number(opt("--timeout", 15)),
      backgroundFile: opt("--background-file", ""), paths: splitPaths(opt("--paths", "")),
      include: opt("--include", "").split(",").map((x) => x.trim()).filter(Boolean) });
    console.log(`ocr: ${s.ocr.status ?? "no result"}, exit ${s.agent_exit}, ${s.seconds} s, ${s.ocr.files_reviewed ?? 0} files, ${s.ocr.tool_calls} tool calls` +
      (s.ocr.first_failed_files ? `, ${s.ocr.first_failed_files} failed file(s) retried, ${s.ocr.failed_files} still failed` : ""));
  } catch (e) { console.error(`ocr: ${e.message}`); process.exit(1); }
}
