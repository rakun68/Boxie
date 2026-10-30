// Known gap 29: the spec check folded into the implementer. With SPEC_GATE=1 the plugin refuses edits
// until spec_checked or ask_orchestrator (image/ask-mcp.mjs) has written the gate file.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { tmp } from "./tmp.mjs";

const IMAGE = path.join(import.meta.dirname, "..", "image");

test("SPEC_GATE=1: edit, write and patch are refused until the gate file exists; reads are not", async () => {
  const file = path.join(tmp("ab-gate-"), "spec-check.md");
  const before = { SPEC_GATE: process.env.SPEC_GATE, SPEC_GATE_FILE: process.env.SPEC_GATE_FILE };
  Object.assign(process.env, { SPEC_GATE: "1", SPEC_GATE_FILE: file });
  try {
    const { Boxie } = await import(pathToFileURL(path.join(IMAGE, "plugin.js")));
    const hooks = await Boxie({ directory: "/work/repo" });
    const run = (tool, args) => hooks["tool.execute.before"]({ tool }, { args });
    for (const tool of ["edit", "write", "apply_patch"]) await assert.rejects(run(tool, {}), /check the task first/);
    await run("read", { filePath: "a.js" });
    await run("bash", { command: "ls" });
    fs.writeFileSync(file, "checked: nothing undecided\n");
    await run("edit", { filePath: "a.js", newString: "x" });
    process.env.SPEC_GATE = "0";
    fs.rmSync(file);
    await run("write", { filePath: "a.js", content: "x" });
  } finally {
    for (const [k, v] of Object.entries(before)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

// Drives ask-mcp.mjs over stdio: one request per line, the answer with the same id.
function mcp(env) {
  const p = spawn(process.execPath, [path.join(IMAGE, "ask-mcp.mjs")], { env: { ...process.env, ...env } });
  let buf = "", n = 0;
  const waiting = new Map();
  p.stdout.setEncoding("utf8");
  p.stdout.on("data", (d) => {
    buf += d;
    for (let i; (i = buf.indexOf("\n")) >= 0; buf = buf.slice(i + 1)) {
      const msg = JSON.parse(buf.slice(0, i));
      waiting.get(msg.id)?.(msg.result);
    }
  });
  let stderr = "";
  p.stderr.on("data", (d) => { stderr += d; });
  // A server that dies fails the call instead of hanging the test.
  const died = new Promise((_, reject) => p.on("exit", (code) => reject(new Error(`ask-mcp exited ${code}: ${stderr}`))));
  died.catch(() => {});
  const call = (method, params) => Promise.race([died, new Promise((r) => {
    const id = ++n; waiting.set(id, r); p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  })]);
  return { call, close: () => p.kill() };
}

test("ask-mcp.mjs parses (its tool test runs only in the container)", () => {
  execFileSync(process.execPath, ["--check", path.join(IMAGE, "ask-mcp.mjs")]);
});

// ask-mcp.mjs creates /out/questions and /in/answers at load: only in the worker container, never the host.
const canRun = fs.existsSync("/out") && fs.existsSync("/in");

test("spec_checked is offered only with SPEC_GATE=1 and writes the gate file", { skip: !canRun && "no /out here" }, async () => {
  const file = path.join(tmp("ab-gate-"), "spec-check.md");
  const off = mcp({ SPEC_GATE: "", SPEC_GATE_FILE: file });
  const on = mcp({ SPEC_GATE: "1", SPEC_GATE_FILE: file });
  try {
    assert.ok(!(await off.call("tools/list")).tools.some((t) => t.name === "spec_checked"));
    assert.ok((await on.call("tools/list")).tools.some((t) => t.name === "spec_checked"));
    assert.match((await on.call("tools/call", { name: "spec_checked", arguments: { result: "" } })).content[0].text, /Give the result/);
    assert.equal(fs.existsSync(file), false);
    assert.match((await on.call("tools/call", { name: "spec_checked", arguments: { result: "nothing undecided" } })).content[0].text, /Recorded/);
    assert.equal(fs.readFileSync(file, "utf8"), "checked: nothing undecided\n");
  } finally { off.close(); on.close(); }
});

test("asking the orchestrator opens the gate too", { skip: !canRun && "no /out here" }, async () => {
  const file = path.join(tmp("ab-gate-"), "spec-check.md");
  const on = mcp({ SPEC_GATE: "1", SPEC_GATE_FILE: file, ASK_WAIT_S: "1" });
  try {
    const r = await on.call("tools/call", { name: "ask_orchestrator", arguments: { question: "A or B?" } });
    const id = r.content[0].text.match(/Question (\d+) sent/)[1];
    assert.equal(fs.readFileSync(file, "utf8"), `asked: question ${id}\n`);
  } finally { on.close(); }
});

test("the gate reaches the ask server of a worker only", () => {
  const config = (env) => {
    const home = tmp("ab-gate-");
    execFileSync(process.execPath, [path.join(IMAGE, "make-config.mjs")], {
      env: { ...process.env, HOME: home, USERPROFILE: home, MODEL: "m1", ...env }, encoding: "utf8" });
    return JSON.parse(fs.readFileSync(path.join(home, ".config", "opencode", "opencode.json"), "utf8"));
  };
  assert.deepEqual(config({ SPEC_GATE: "1" }).mcp.orchestrator.environment, { SPEC_GATE: "1" });
  assert.equal(config({}).mcp.orchestrator.environment, undefined);
  assert.equal(config({ SPEC_GATE: "1", REVIEW: "1", REVIEW_ASK: "1" }).mcp.orchestrator.environment, undefined);
});
