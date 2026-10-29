// The gaps found in the Lykos P18 grill (docs/known-gaps.md 10-19): usage on missing arguments, ask past
// 300 s and on a reasoning-only answer, a council member's real answer, and a dead loop driver.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { tmp } from "./tmp.mjs";
import { memberAnswer } from "../lib/council.mjs";
import { driverAlive, settings } from "../lib/loop.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = promisify(execFile);

test("a command with too few arguments prints its usage and exits 2", () => {
  for (const [args, line] of [[["council"], /^ {2}council {2}<repo> --prompt FILE/], [["run", "x"], /^ {2}run {6}<repo> <task\.md>/],
    [["loop", "resume", "x"], /^ {2}loop resume <repo> <loop>/], [["answer", "a", "b"], /^ {2}answer {3}<repo> <run-name> <id>/],
    [["ticket", "x"], /^usage: delegate\.sh ticket/]]) {
    const r = spawnSync("bash", [path.join(ROOT, "delegate.sh"), ...args], { encoding: "utf8" });
    assert.equal(r.status, 2, args.join(" "));
    assert.match(r.stderr, line);
    assert.doesNotMatch(r.stderr, /unbound variable/);
  }
});

test("the round cap's code default is the configured 5", () => {
  assert.match(fs.readFileSync(path.join(ROOT, "boxie.conf"), "utf8"), /^LOOP_MAX_ROUNDS=5\b/m);
  assert.equal(settings({ name: "none", env: {} }).maxRounds, 5);
});

// A fake gateway: each request gets the next reply; the bodies are kept.
const gateway = async (replies) => {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => { b += c; });
    req.on("end", () => {
      bodies.push(JSON.parse(b));
      const [status, json, delay = 0] = replies.shift();
      setTimeout(() => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(json)); }, delay);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { bodies, url: `http://127.0.0.1:${server.address().port}/v1`, close: () => server.close() };
};
const ask = (url, out, env = {}) => {
  const q = path.join(path.dirname(out), "q.md");
  fs.writeFileSync(q, "q");
  return run(process.execPath, [path.join(ROOT, "lib", "ask.mjs"), "m/x", q, out], {
    env: { ...process.env, OMNIROUTE_API_KEY: "k", OMNIROUTE_HOST_URL: url, EFFORT: "high", ...env }, timeout: 30000 }).catch((e) => e);
};

test("ask retries once with low effort when the model spent its output on reasoning", async () => {
  const g = await gateway([
    [200, { choices: [{ finish_reason: "length", message: { content: "", reasoning_content: "thinking..." } }], usage: { completion_tokens: 8192 } }],
    [200, { choices: [{ finish_reason: "stop", message: { content: "the digest" } }] }],
  ]);
  const out = path.join(tmp("ab-ask-"), "a.md");
  const r = await ask(g.url, out);
  g.close();
  assert.equal(r.stdout.trim(), "the digest");
  assert.equal(g.bodies.length, 2);
  assert.equal(g.bodies[0].reasoning_effort, "high");
  assert.equal(g.bodies[1].reasoning_effort, "low");
  assert.equal(g.bodies[1].max_tokens, 32768);
  assert.match(fs.readFileSync(out, "utf8"), /## Answer\n\nthe digest/);
});

test("ask names the finish reason and usage when no content comes back", async () => {
  const empty = [200, { choices: [{ finish_reason: "length", message: { content: "" } }], usage: { completion_tokens: 9 } }];
  const g = await gateway([empty, empty]);
  const r = await ask(g.url, path.join(tmp("ab-ask-"), "a.md"));
  g.close();
  assert.equal(r.code, 1);
  assert.match(r.stderr, /ask failed \(200\): finish_reason length, 0 characters of content, usage \{"completion_tokens":9\}/);
});

test("ask waits for a slow answer (no fetch headers timeout) and reports a dead gateway plainly", async () => {
  const g = await gateway([[200, { choices: [{ finish_reason: "stop", message: { content: "late" } }] }, 1500]]);
  const r = await ask(g.url, path.join(tmp("ab-ask-"), "a.md"));
  g.close();
  assert.equal(r.stdout.trim(), "late");
  const dead = await ask("http://127.0.0.1:9/v1", path.join(tmp("ab-ask-"), "a.md"));
  assert.equal(dead.code, 1);
  assert.match(dead.stderr, /ask failed \(0\): .*ECONNREFUSED/);
});

const events = (...texts) => texts.map((t) => JSON.stringify({ type: "text", part: { text: t } })).join("\n");

test("a council member's answer is its report, not the closing offer after it", () => {
  assert.deepEqual(memberAnswer(events("x".repeat(1200)), 1000), { text: "x".repeat(1200), short: false });
  const offer = "Would you like me to draft revisions?";
  const r = memberAnswer(events("r".repeat(5000), "tiny", offer), 1000);
  assert.equal(r.text, `${"r".repeat(5000)}\n\n${offer}`);
  assert.equal(r.short, false);
  assert.deepEqual(memberAnswer(events("short one", offer), 1000), { text: offer, short: true });
  assert.deepEqual(memberAnswer("", 1000), { text: "", short: true });
});

test("council.mjs answer exits 3 on a short answer, 1 on none", () => {
  const d = tmp("ab-council-"), out = path.join(d, "a.md");
  fs.writeFileSync(path.join(d, "events.jsonl"), events("only this"));
  assert.equal(spawnSync(process.execPath, [path.join(ROOT, "lib", "council.mjs"), "answer", d, out, "100"]).status, 3);
  assert.equal(fs.readFileSync(out, "utf8"), "only this\n");
  fs.writeFileSync(path.join(d, "events.jsonl"), "");
  assert.equal(spawnSync(process.execPath, [path.join(ROOT, "lib", "council.mjs"), "answer", d, out, "100"]).status, 1);
});

test("a loop whose driver died reads as dead; a live one as running", () => {
  assert.equal(driverAlive({}), false);
  assert.equal(driverAlive({ driver: { pid: process.pid } }), true);
  const gone = spawnSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" });
  assert.equal(driverAlive({ driver: { pid: Number(gone.stdout.trim()) } }), false);
});

test("the daily auto-gc leaves the engine alone", () => {
  const src = fs.readFileSync(path.join(ROOT, "delegate.sh"), "utf8");
  assert.match(src.match(/^auto_gc\(\) \{[\s\S]*?^\}/m)[0], /cmd_gc --yes --host-only/);
  assert.match(src.match(/^cmd_gc\(\) \{[\s\S]*?^\}/m)[0], /\[ "\$host" = 0 \] \|\| return 0\n[\s\S]*image prune/);
});

test("the agent's prompt goes to opencode on stdin, not as an argument", () => {
  const src = fs.readFileSync(path.join(ROOT, "image", "run-task.sh"), "utf8");
  assert.match(src, /--title "\$BRANCH" \\\n\s+<"\$OUT\/prompt\.md" >"\$OUT\/events\.jsonl"/);
  assert.doesNotMatch(src, /"\$\{session_args\[@\]\}" --title "\$BRANCH" "\$prompt"/);
});
