// Worker commits become yours. After a run's branch is fetched, every commit the worker made (author
// boxie@localhost) is rewritten on the host with the repo's git identity, and signed when the repo
// has commit.gpgSign set. The signing key never enters a container. The worker's name and model stay
// in a `Boxie-Worker:` trailer, and author and committer dates are kept. A continued round starts
// on the rewritten head, so only its new commits are rewritten.
//   node lib/own.mjs <repo> <base> <branch> [run-dir]   -> rewrites base..branch, updates summary.json
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const WORKER_EMAIL = "boxie@localhost";

const git = (repo, args, opts = {}) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["pipe", "pipe", "pipe"], ...opts }).trimEnd();
const tryGit = (repo, args) => { try { return git(repo, args); } catch { return ""; } };

// A raw commit object: headers (gpgsig and its continuation lines dropped) and the message.
export function parseCommit(raw) {
  const cut = raw.indexOf("\n\n");
  const head = cut < 0 ? raw : raw.slice(0, cut), message = cut < 0 ? "" : raw.slice(cut + 2);
  const c = { tree: "", parents: [], author: null, committer: null, message };
  for (const line of head.split("\n")) {
    if (line.startsWith(" ")) continue;
    const sp = line.indexOf(" "), key = line.slice(0, sp), val = line.slice(sp + 1);
    if (key === "tree") c.tree = val;
    else if (key === "parent") c.parents.push(val);
    else if (key === "author" || key === "committer") {
      const m = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(val);
      c[key] = m && { name: m[1], email: m[2], date: `@${m[3]} ${m[4]}` };
    }
  }
  return c;
}

export function own(repo, base, branch) {
  const name = tryGit(repo, ["config", "user.name"]), email = tryGit(repo, ["config", "user.email"]);
  if (!name || !email) return { rewritten: 0, note: "no user.name/user.email in git config: worker commits keep the boxie identity" };
  const sign = tryGit(repo, ["config", "--bool", "commit.gpgsign"]) === "true";
  const tip = git(repo, ["rev-parse", `refs/heads/${branch}`]);
  const list = tryGit(repo, ["rev-list", "--reverse", "--topo-order", `${base}..${tip}`]).split("\n").filter(Boolean);
  const map = new Map();
  let rewritten = 0;
  for (const sha of list) {
    const c = parseCommit(git(repo, ["cat-file", "commit", sha]));
    const parents = c.parents.map((p) => map.get(p) ?? p);
    const worker = c.author?.email === WORKER_EMAIL || c.committer?.email === WORKER_EMAIL;
    if (!worker && parents.every((p, i) => p === c.parents[i])) continue;
    const author = c.author?.email === WORKER_EMAIL ? { ...c.author, name, email } : c.author;
    const committer = c.committer?.email === WORKER_EMAIL ? { ...c.committer, name, email } : c.committer;
    const message = c.author?.email === WORKER_EMAIL
      ? git(repo, ["interpret-trailers", "--if-exists", "doNothing", "--trailer", `Boxie-Worker: ${c.author.name}`], { input: c.message }) + "\n"
      : c.message;
    const env = { ...process.env,
      GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_AUTHOR_DATE: author.date,
      GIT_COMMITTER_NAME: committer.name, GIT_COMMITTER_EMAIL: committer.email, GIT_COMMITTER_DATE: committer.date };
    const args = ["commit-tree", ...(sign ? ["-S"] : []), c.tree, ...parents.flatMap((p) => ["-p", p])];
    map.set(sha, git(repo, args, { input: message, env }));
    rewritten++;
  }
  const head = map.get(tip) ?? tip;
  if (head !== tip) git(repo, ["update-ref", `refs/heads/${branch}`, head, tip]);
  return { rewritten, head, old: tip, name, email, signed: sign };
}

// The run's summary.json and commits.txt name the worker's head: point them at the rewritten one.
export function updateRun(repo, base, runDir, r) {
  if (!r.rewritten || !runDir) return;
  const f = path.join(runDir, "summary.json");
  try {
    const s = JSON.parse(fs.readFileSync(f, "utf8"));
    if (s.head === r.old) { s.head = r.head; fs.writeFileSync(f, JSON.stringify(s, null, 2) + "\n"); }
  } catch { /* no summary: nothing to point */ }
  if (fs.existsSync(path.join(runDir, "commits.txt")))
    fs.writeFileSync(path.join(runDir, "commits.txt"), git(repo, ["log", "--format=%h %s", `${base}..${r.head}`]) + "\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [repo, base, branch, runDir] = process.argv.slice(2);
  if (!repo || !base || !branch) { console.error("usage: own.mjs <repo> <base> <branch> [run-dir]"); process.exit(2); }
  try {
    const r = own(repo, base, branch);
    if (r.note) console.error(`boxie: ${r.note}`);
    else if (r.rewritten) {
      updateRun(repo, base, runDir, r);
      console.error(`boxie: ${r.rewritten} worker commit(s) on ${branch} now by ${r.name} <${r.email}>${r.signed ? ", signed" : ""}`);
    }
  } catch (e) {
    console.error(`boxie: could not take over the worker commits on ${branch}, they keep the boxie identity: ${String(e.stderr || e.message).trim().split("\n")[0]}`);
  }
}
