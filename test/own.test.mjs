import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { own, updateRun, parseCommit } from "../lib/own.mjs";
import { tmp } from "./tmp.mjs";

const g = (repo, ...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd();

// A repo with a base commit by the user and two worker commits on agent/t1, as a run leaves it.
function setup() {
  const repo = tmp("own-");
  g(repo, "init", "-q", "-b", "main");
  for (const [k, v] of [["user.name", "Owner"], ["user.email", "owner@example.com"], ["commit.gpgsign", "false"]]) g(repo, "config", k, v);
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  g(repo, "add", "a.txt"); g(repo, "commit", "-qm", "base");
  const base = g(repo, "rev-parse", "HEAD");
  g(repo, "checkout", "-qb", "agent/t1");
  const w = ["-c", "user.name=boxie (deepseek-flash)", "-c", "user.email=boxie@localhost"];
  for (const n of ["b", "c"]) {
    fs.writeFileSync(path.join(repo, `${n}.txt`), `${n}\n`);
    g(repo, "add", `${n}.txt`); g(repo, ...w, "commit", "-qm", `add ${n}`);
  }
  g(repo, "checkout", "-q", "main");
  return { repo, base };
}

test("worker commits take the repo's identity, keep their dates and name the worker in a trailer", () => {
  const { repo, base } = setup();
  const before = g(repo, "log", "--format=%ad|%cd", `${base}..agent/t1`);
  const r = own(repo, base, "agent/t1");
  assert.equal(r.rewritten, 2);
  assert.equal(g(repo, "log", "--format=%an <%ae>|%cn <%ce>", `${base}..agent/t1`), "Owner <owner@example.com>|Owner <owner@example.com>\n".repeat(2).trimEnd());
  assert.equal(g(repo, "log", "--format=%ad|%cd", `${base}..agent/t1`), before);
  assert.match(g(repo, "log", "-1", "--format=%B", "agent/t1"), /^add c\n\nBoxie-Worker: boxie \(deepseek-flash\)$/);
  assert.equal(g(repo, "rev-parse", "agent/t1^^"), base);
});

test("a second pass changes nothing", () => {
  const { repo, base } = setup();
  const first = own(repo, base, "agent/t1").head;
  const again = own(repo, base, "agent/t1");
  assert.equal(again.rewritten, 0);
  assert.equal(g(repo, "rev-parse", "agent/t1"), first);
});

test("summary.json and commits.txt follow the rewritten head", () => {
  const { repo, base } = setup();
  const run = tmp("own-run-");
  const old = g(repo, "rev-parse", "agent/t1");
  fs.writeFileSync(path.join(run, "summary.json"), JSON.stringify({ head: old, commits: 2 }));
  fs.writeFileSync(path.join(run, "commits.txt"), "stale\n");
  const r = own(repo, base, "agent/t1");
  updateRun(repo, base, run, r);
  assert.equal(JSON.parse(fs.readFileSync(path.join(run, "summary.json"), "utf8")).head, r.head);
  assert.equal(fs.readFileSync(path.join(run, "commits.txt"), "utf8"), g(repo, "log", "--format=%h %s", `${base}..agent/t1`) + "\n");
});

const hasSshKeygen = (() => { try { execFileSync("ssh-keygen", ["-?"], { stdio: "ignore" }); return true; } catch (e) { return e.status !== undefined && e.code !== "ENOENT"; } })();

test("with commit.gpgSign and an SSH key, every rewritten commit is signed, and a second pass is a no-op", { skip: !hasSshKeygen && "no ssh-keygen" }, () => {
  const { repo, base } = setup();
  const key = path.join(tmp("own-key-"), "k");
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "owner@example.com", "-f", key]);
  const signers = `${key}.signers`;
  fs.writeFileSync(signers, `owner@example.com ${fs.readFileSync(`${key}.pub`, "utf8").split(" ").slice(0, 2).join(" ")}\n`);
  for (const [k, v] of [["gpg.format", "ssh"], ["user.signingkey", `${key}.pub`], ["gpg.ssh.allowedSignersFile", signers], ["commit.gpgsign", "true"]]) g(repo, "config", k, v);
  const r = own(repo, base, "agent/t1");
  assert.equal(r.signed, true);
  assert.equal(g(repo, "log", "--format=%G?", `${base}..agent/t1`), "G\nG");
  assert.equal(own(repo, base, "agent/t1").rewritten, 0);
});

test("parseCommit drops a signature block and reads both identities", () => {
  const raw = "tree t\nparent p\nauthor A B <a@x> 100 +0700\ncommitter C <c@x> 200 -0100\ngpgsig -----BEGIN SSH SIGNATURE-----\n abc\n -----END SSH SIGNATURE-----\n\nmsg\n";
  const c = parseCommit(raw);
  assert.deepEqual([c.tree, c.parents, c.author, c.committer, c.message],
    ["t", ["p"], { name: "A B", email: "a@x", date: "@100 +0700" }, { name: "C", email: "c@x", date: "@200 -0100" }, "msg\n"]);
});
