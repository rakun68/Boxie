// The end of a phase: the whole phase diff reviewed, then a checklist before anyone says "done".
// Lykos, RakunLoots and RakunMiniItems (2026-10): after the orchestrator called a phase finished, a
// full-diff review by another family found medium+ bugs 3-4 rounds in a row, and the items "left for
// the user" were ones an agent could do. Per-ticket loops never see the seams between tickets.
//
//   node lib/phase.mjs review <repo> --base REF [--head REF] [--name N] [--spec FILE]... [--max-rounds N] [--roles a,b,c]
//     rounds of reviews, each round one family over every area of the diff, until two rounds in a row
//     from different families find nothing medium or worse on the same head. Exit 0 done, 3 findings.
//   node lib/phase.mjs close <repo> --base REF [--head REF] [--name N] [--issues 12,13]
//     the checklist; prints `ready` (exit 0) or the first failing item (exit 1)
//   node lib/phase.mjs status <repo>
//     unfinished runs, loops waiting on the orchestrator, open phase reviews, with the next command
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { project, conf } from "./ticket.mjs";
import { readJson } from "./checks.mjs";
import { family } from "./family.mjs";
import { normalizeFindings } from "./finding.mjs";

const BOX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SERIOUS = new Set(["critical", "high", "medium"]);
const sev = (f) => String(f?.severity ?? "").toLowerCase();

// Changed files ([{ path, size }], size = diff characters) into areas: whole directories together while
// they fit under max, so a reviewer sees each seam inside one area. A file larger than max is its own area.
export function areas(files, max) {
  const dirs = new Map();
  for (const f of files) {
    const d = f.path.split("/").slice(0, -1).slice(0, 2).join("/") || ".";
    dirs.set(d, [...(dirs.get(d) ?? []), f]);
  }
  const out = [];
  let cur = [], size = 0;
  const flush = () => { if (cur.length) out.push(cur.map((f) => f.path)); cur = []; size = 0; };
  for (const group of [...dirs.values()]) {
    const g = group.reduce((s, f) => s + f.size, 0);
    if (g > max) {
      for (const f of group) { if (size + f.size > max) flush(); cur.push(f); size += f.size; }
      continue;
    }
    if (size + g > max) flush();
    cur.push(...group); size += g;
  }
  flush();
  return out;
}

// The next round's reviewer: the rotation's next role whose family differs from the last round's.
export function nextRole(rounds, roles, familyOf) {
  const last = rounds.at(-1);
  for (let i = 0; i < roles.length; i++) {
    const r = roles[(rounds.length + i) % roles.length];
    if (!last || familyOf(r) !== last.family) return r;
  }
  return roles[rounds.length % roles.length];
}

// Done: the last two rounds on this head were clean and came from different families.
export function done(rounds, head) {
  const on = rounds.filter((r) => r.head === head);
  const [a, b] = on.slice(-2);
  return !!(a && b && a.clean && b.clean && a.family !== b.family);
}

const git = (repo, ...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", maxBuffer: 256 << 20 }).trim();
const tryGit = (repo, ...a) => { try { return git(repo, ...a); } catch { return null; } };
const roleModel = (P, role) => (conf(`ROLE_${role.split("@")[0].replace(/-/g, "_")}`, P) || "").split(/\s+/)[0];

function delegate(args, logFile) {
  return new Promise((resolve) => {
    const out = fs.openSync(logFile, "w");
    const p = spawn("bash", [path.join(BOX, "delegate.sh"), ...args], { stdio: ["ignore", out, out], env: { ...process.env, AGENT_BOX_PARK: "0" } });
    p.on("close", (code) => { fs.closeSync(out); resolve(code); });
  });
}

// The phase/<name> branch exists only while the reviews read it.
export async function review(P, o) {
  const name = o.name || `phase-${o.base.replace(/[^\w.-]/g, "-")}`;
  try { return await reviewRounds(P, { ...o, name }); } finally { tryGit(P.repo, "branch", "-D", `phase/${name}`); }
}

async function reviewRounds(P, o) {
  const name = o.name;
  const dir = path.join(P.runs, "_phase", name);
  fs.mkdirSync(dir, { recursive: true });
  const stateFile = path.join(dir, "state.json");
  const st = readJson(stateFile) ?? { name, base: o.base, rounds: [] };
  const head = git(P.repo, "rev-parse", o.head || "HEAD");
  const base = git(P.repo, "merge-base", o.base, head);
  const roles = (o.roles || conf("PHASE_REVIEW_ROLES", P) || "review-both review-both-alt review-both-gemini").split(/[\s,]+/).filter(Boolean);
  const max = Number(conf("REVIEW_DIFF_MAX", P)) || 30000;
  const maxRounds = Number(o.maxRounds || conf("PHASE_REVIEW_MAX_ROUNDS", P) || 4);
  const familyOf = (r) => family(roleModel(P, r));
  const save = () => fs.writeFileSync(stateFile, JSON.stringify({ ...st, head }, null, 2));
  // A branch name for review: the head commit itself may not be one.
  const branch = `phase/${name}`;
  git(P.repo, "branch", "-f", branch, head);

  const files = git(P.repo, "diff", "--name-only", base, head).split("\n").filter(Boolean)
    .map((p) => ({ path: p, size: (tryGit(P.repo, "diff", base, head, "--", p) ?? "").length }));
  if (!files.length) { console.log(`phase-review: no change between ${o.base} and ${head.slice(0, 10)}`); return 0; }
  const parts = areas(files, max);
  console.log(`phase-review ${name}: ${files.length} files in ${parts.length} area(s), ${base.slice(0, 10)}..${head.slice(0, 10)}`);

  for (let n = 0; n < maxRounds; n++) {
    if (done(st.rounds, head)) break;
    const k = st.rounds.length + 1, role = nextRole(st.rounds.filter((r) => r.head === head), roles, familyOf);
    const fam = familyOf(role);
    console.log(`round ${k}: ${role} (${fam}) over ${parts.length} area(s)`);
    const runs = parts.map((_, i) => `${name}-r${k}-a${i + 1}`);
    await Promise.all(parts.map((paths, i) => delegate(["review", P.repo, branch, "--against", base, "--roles", role, "--name", runs[i],
      "--paths", paths.join(" "), ...(o.specs ?? []).flatMap((s) => ["--spec", s])], path.join(dir, `r${k}-a${i + 1}.log`))));
    const serious = [], unreviewed = [];
    runs.forEach((r, i) => {
      const run = `${r}-${role.split("@")[0]}`;
      const fs_ = normalizeFindings(readJson(path.join(P.runs, run, "findings.json")));
      if (!Array.isArray(fs_)) { unreviewed.push({ area: i + 1, run, files: parts[i] }); return; }
      for (const f of fs_) if (SERIOUS.has(sev(f))) serious.push({ ...f, run, area: i + 1 });
    });
    const clean = !serious.length && !unreviewed.length;
    st.rounds.push({ k, role, family: fam, head, areas: parts.length, clean, serious: serious.length, unreviewed: unreviewed.map((u) => u.area), runs });
    save();
    for (const u of unreviewed) console.log(`  area ${u.area}: no readable findings (${u.run}); not reviewed: ${u.files.slice(0, 5).join(", ")}${u.files.length > 5 ? ", ..." : ""}`);
    if (!clean) {
      fs.writeFileSync(path.join(dir, `findings-r${k}.json`), JSON.stringify(serious, null, 2));
      console.log(`round ${k}: ${serious.length} medium+ finding(s)${unreviewed.length ? `, ${unreviewed.length} area(s) unreviewed` : ""}`);
      for (const f of serious) console.log(`  [${sev(f)}] ${f.file ?? "?"}${f.line ? `:${f.line}` : ""} ${f.issue ?? ""}  (${f.run})`);
      const again = `delegate.sh phase-review <repo> --base ${o.base} --name ${name}`;
      console.log(serious.length ? `\nnext: fix every item (each with a test that fails first), commit, then rerun: ${again}`
        : `\nnext: read the area logs in ${dir}, fix the cause, rerun: ${again}`);
      console.log(`findings: ${path.join(dir, `findings-r${k}.json`)}`);
      return 3;
    }
    console.log(`round ${k}: clean`);
  }
  if (done(st.rounds, head)) {
    const [a, b] = st.rounds.filter((r) => r.head === head).slice(-2);
    console.log(`phase-review ${name}: clean twice on ${head.slice(0, 10)} (${a.family}, ${b.family}): done`);
    return 0;
  }
  console.log(`phase-review ${name}: ${maxRounds} rounds without two clean in a row; rerun to continue`);
  return 3;
}

export function close(P, o) {
  const name = o.name || `phase-${o.base.replace(/[^\w.-]/g, "-")}`;
  const head = git(P.repo, "rev-parse", o.head || "HEAD");
  const checks = [];
  const add = (ok, what, detail = "") => checks.push({ ok, what, detail });

  const st = readJson(path.join(P.runs, "_phase", name, "state.json"));
  add(!!st && done(st.rounds, head), "phase-review clean twice on this head",
    !st ? `none: run delegate.sh phase-review <repo> --base ${o.base}` : `last round ${st.rounds.at(-1)?.k ?? "-"} on ${(st.rounds.at(-1)?.head ?? "").slice(0, 10)}`);

  const dirty = tryGit(P.repo, "status", "--porcelain", "--untracked-files=no");
  add(dirty === "", "working tree clean", dirty ? dirty.split("\n").slice(0, 5).join("; ") : "");

  const unmerged = (tryGit(P.repo, "branch", "--list", "agent/*", "--no-merged", head, "--contains", o.base, "--format=%(refname:short)") ?? "").split("\n").filter(Boolean);
  add(!unmerged.length, "no unmerged agent branches from this phase", unmerged.slice(0, 8).join(", ") + (unmerged.length > 8 ? ` (+${unmerged.length - 8})` : ""));

  const gate = conf("HOST_GATE_CMD", P);
  if (!gate) add(null, "host gate", "no HOST_GATE_CMD in projects/<repo>.env");
  else if (git(P.repo, "rev-parse", "HEAD") !== head) add(false, "host gate", `check out ${head.slice(0, 10)} first`);
  else {
    const r = spawnSync(gate, { cwd: P.repo, shell: true, encoding: "utf8", maxBuffer: 64 << 20 });
    add(r.status === 0, `host gate: ${gate}`, r.status === 0 ? "" : `exit ${r.status}: ${(r.stdout + r.stderr).trim().split("\n").slice(-5).join(" | ")}`);
  }

  // This phase's loops only: started on the phase base or later.
  const baseSha = git(P.repo, "rev-parse", o.base);
  const inPhase = (sha) => !!sha && spawnSync("git", ["-C", P.repo, "merge-base", "--is-ancestor", baseSha, sha]).status === 0;
  const waiting = openLoops(P).filter((l) => inPhase(l.base));
  add(!waiting.length, "no loop waiting on the orchestrator", waiting.map((l) => `${l.loop} (${l.next})`).join(", "));

  for (const n of (o.issues ?? "").split(",").filter(Boolean)) {
    const r = spawnSync("gh", ["issue", "view", n, "--json", "state", "-q", ".state"], { cwd: P.repo, encoding: "utf8" });
    add(r.status === 0 ? r.stdout.trim() === "CLOSED" : null, `issue #${n} closed`, r.status === 0 ? r.stdout.trim() : "gh failed");
  }

  for (const c of checks) console.log(`${c.ok === true ? "ok  " : c.ok === false ? "FAIL" : "--  "} ${c.what}${c.detail ? `: ${c.detail}` : ""}`);
  const first = checks.find((c) => c.ok === false);
  console.log(first ? `\nnot ready: ${first.what}` : "\nready");
  return first ? 1 : 0;
}

const DONE_NEXT = new Set(["approve", "merged", "discard"]);
function openLoops(P, days = 7) {
  const d = path.join(P.runs, "_loops");
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).map((loop) => ({ loop, f: path.join(d, loop, "state.json") }))
    .filter((x) => fs.existsSync(x.f) && Date.now() - fs.statSync(x.f).mtimeMs < days * 864e5)
    .map((x) => ({ loop: x.loop, ...(readJson(x.f) ?? {}) }))
    .filter((s) => s.next && !DONE_NEXT.has(s.next));
}

export function status(P, days = 2) {
  const nsx = process.env.AGENT_BOX_NS ?? conf("AGENT_BOX_NS", P), ns = `agent-box${nsx ? `-${nsx}` : ""}`, engine = process.env.AGENT_BOX_ENGINE || "podman";
  const ps = spawnSync(engine, ["ps", "--format", "{{.Names}}"], { encoding: "utf8" });
  const live = new Set(ps.status === 0 ? ps.stdout.split("\n").filter(Boolean) : []);
  const lines = [];
  if (fs.existsSync(P.runs)) {
    for (const r of fs.readdirSync(P.runs)) {
      const d = path.join(P.runs, r);
      if (/^[_.]/.test(r) || !fs.existsSync(path.join(d, "meta.sh")) || fs.existsSync(path.join(d, "summary.json"))) continue;
      if (Date.now() - fs.statSync(d).mtimeMs > days * 864e5) continue;
      const running = live.has(`${ns}-${P.name}-${r.replace(/[^a-zA-Z0-9_.-]/g, "-")}`);
      lines.push(running ? `run  ${r}: running  (delegate.sh watch ${P.name} ${r})`
        : `run  ${r}: stopped without a summary  (delegate.sh show ${P.name} ${r}; rerun, or continue a finished round)`);
    }
  }
  for (const l of openLoops(P)) lines.push(`loop ${l.loop}: next ${l.next} (${l.reason ?? ""})  (delegate.sh loop resume ${P.name} ${l.loop} ...)`);
  const pd = path.join(P.runs, "_phase");
  if (fs.existsSync(pd)) for (const n of fs.readdirSync(pd)) {
    const s = readJson(path.join(pd, n, "state.json"));
    if (s && !done(s.rounds ?? [], s.head)) lines.push(`phase ${n}: ${s.rounds?.length ?? 0} round(s), not clean twice  (delegate.sh phase-review ${P.name} --base ${s.base} --name ${n})`);
  }
  console.log(lines.length ? lines.join("\n") : "nothing unfinished");
  return 0;
}

const main = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (main) {
  const [cmd, repo, ...rest] = process.argv.slice(2);
  const usage = "usage: phase.mjs review|close|status <repo> [--base REF] [--head REF] [--name N] [--spec FILE]... [--max-rounds N] [--roles a,b] [--issues 1,2]";
  if (!["review", "close", "status"].includes(cmd) || !repo) { console.error(usage); process.exit(2); }
  const o = { specs: [] };
  for (let i = 0; i < rest.length; i += 2) {
    const [k, v] = [rest[i], rest[i + 1]];
    if (v === undefined) { console.error(`phase: ${k} needs a value`); process.exit(2); }
    if (k === "--spec") o.specs.push(path.resolve(v));
    else if (["--base", "--head", "--name", "--roles", "--issues"].includes(k)) o[k.slice(2)] = v;
    else if (k === "--max-rounds") o.maxRounds = v;
    else { console.error(`phase: unknown option ${k}\n${usage}`); process.exit(2); }
  }
  if (cmd !== "status" && !o.base) { console.error(`phase ${cmd} needs --base REF (the commit the phase started from)`); process.exit(2); }
  const P = project(repo);
  process.exitCode = cmd === "review" ? await review(P, o) : cmd === "close" ? close(P, o) : status(P);
}
