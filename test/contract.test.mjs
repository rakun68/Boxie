// Contract first (image/preamble-contract.md): the plugin refuses edits until contract_ready has written
// the contract, and the first call asks a critic from another model family (image/ask-mcp.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { tmp } from "./tmp.mjs";

const IMAGE = path.join(import.meta.dirname, "..", "image");
const { criticModel, CRITIC_PROMPT } = await import(pathToFileURL(path.join(IMAGE, "ask-mcp.mjs")));

test("CONTRACT_GATE=1: edits are refused until the contract file exists", async () => {
  const file = path.join(tmp("ab-contract-"), "contract.md");
  const before = { CONTRACT_GATE: process.env.CONTRACT_GATE, CONTRACT_FILE: process.env.CONTRACT_FILE, SPEC_GATE: process.env.SPEC_GATE };
  Object.assign(process.env, { CONTRACT_GATE: "1", CONTRACT_FILE: file, SPEC_GATE: "0" });
  try {
    const { Boxie } = await import(pathToFileURL(path.join(IMAGE, "plugin.js")));
    const hooks = await Boxie({ directory: "/work/repo" });
    const run = (tool, args) => hooks["tool.execute.before"]({ tool }, { args });
    for (const tool of ["edit", "write", "apply_patch"]) await assert.rejects(run(tool, {}), /write the contract first/);
    await run("read", { filePath: "a.js" });
    fs.writeFileSync(file, "requirements: x\n");
    await run("edit", { filePath: "a.js", newString: "x" });
  } finally {
    for (const [k, v] of Object.entries(before)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test("criticModel: another family than the implementer", () => {
  const env = { CONTRACT_MODEL: "cx/gpt-6.1-sol-high", CONTRACT_MODEL_ALT: "antigravity/gemini-3.8-flash-high" };
  assert.equal(criticModel({ ...env, MODEL: "antigravity/gemini-3.8-flash-high" }), "cx/gpt-6.1-sol-high");
  assert.equal(criticModel({ ...env, MODEL: "deepseek/deepseek-flash-max" }), "cx/gpt-6.1-sol-high");
  assert.equal(criticModel({ ...env, MODEL: "cx/gpt-6.1-codex" }), "antigravity/gemini-3.8-flash-high");
  assert.equal(criticModel({ CONTRACT_MODEL: "deepseek/deepseek-flash-high", CONTRACT_MODEL_ALT: "g", MODEL: "deepseek/deepseek-flash-max" }), "g");
  assert.equal(criticModel({ MODEL: "x" }), "", "no critic model: none");
  assert.match(CRITIC_PROMPT, /no gaps/);
});

test("make-config: the contract gate gets the MCP server even with ASK=0, without the ask tools", () => {
  const cfg = (env) => {
    const home = tmp("ab-cfg-");
    execFileSync(process.execPath, [path.join(IMAGE, "make-config.mjs")], { env: { ...process.env, HOME: home, USERPROFILE: home,
      MODELS_JSON: "", MODEL: "antigravity/gemini-3.8-flash-high", ...env } });
    return JSON.parse(fs.readFileSync(path.join(home, ".config", "opencode", "opencode.json"), "utf8"));
  };
  const on = cfg({ ASK: "0", CONTRACT_GATE: "1", CONTRACT_MODEL: "deepseek/deepseek-flash-high", OMNIROUTE_API_KEY: "sk-secret" });
  const e = on.mcp.orchestrator.environment;
  assert.equal(e.CONTRACT_GATE, "1");
  assert.equal(e.ASK_TOOLS, "0");
  assert.equal(e.CONTRACT_MODEL, "deepseek/deepseek-flash-high");
  assert.equal(e.OMNIROUTE_API_KEY, "{env:OMNIROUTE_API_KEY}", "the key is referenced, never written");
  assert.ok(!JSON.stringify(on).includes("sk-secret"));
  assert.equal(cfg({ ASK: "0" }).mcp, undefined, "no gate, no ask: no server");
  assert.equal(cfg({ ASK: "0", CONTRACT_GATE: "1", REVIEW: "1" }).mcp, undefined, "never for a review");
});

// Drives ask-mcp.mjs over stdio against a fake OmniRoute.
function mcp(env) {
  const p = spawn(process.execPath, [path.join(IMAGE, "ask-mcp.mjs")], { env: { ...process.env, ...env } });
  let buf = "", n = 0;
  const waiting = new Map();
  p.stdout.setEncoding("utf8");
  p.stdout.on("data", (d) => {
    buf += d;
    for (let i; (i = buf.indexOf("\n")) >= 0; buf = buf.slice(i + 1)) { const m = JSON.parse(buf.slice(0, i)); waiting.get(m.id)?.(m.result); }
  });
  const call = (method, params) => new Promise((r) => {
    const id = ++n; waiting.set(id, r); p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  return { call, close: () => p.kill() };
}

test("contract_ready: the first call asks the critic with the task and the contract; the gaps go back", async () => {
  const seen = [];
  const answers = ["- `--sort` on a numeric column must sort numerically", "no gaps"];
  const server = http.createServer((req, res) => {
    let body = ""; req.on("data", (d) => { body += d; });
    req.on("end", () => { seen.push({ auth: req.headers.authorization, body: JSON.parse(body) });
      res.end(JSON.stringify({ choices: [{ message: { content: answers[seen.length - 1] } }] })); });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const out = tmp("ab-cout-"), inn = tmp("ab-cin-");
  fs.writeFileSync(path.join(inn, "task.md"), "Add --sort.\n");
  const s = mcp({ OUT_DIR: out, IN_DIR: inn, CONTRACT_GATE: "1", ASK_TOOLS: "0", MODEL: "antigravity/gemini-3.8-flash-high",
    CONTRACT_MODEL: "deepseek/deepseek-flash-high", OMNIROUTE_BASE_URL: `http://127.0.0.1:${server.address().port}`, OMNIROUTE_API_KEY: "k" });
  try {
    const names = (await s.call("tools/list")).tools.map((t) => t.name);
    assert.deepEqual(names, ["contract_ready"], "ASK_TOOLS=0: the contract tool only");
    assert.match((await s.call("tools/call", { name: "contract_ready", arguments: { contract: "short" } })).content[0].text, /Write the contract first/);
    assert.equal(fs.existsSync(path.join(out, "contract.md")), false);
    const contract = "Requirements: --sort in src/cli.ts, test report-sort\nRipple: README.md:12\nEdge: unknown column -> usage error";
    const r = (await s.call("tools/call", { name: "contract_ready", arguments: { contract } })).content[0].text;
    assert.match(r, /Edits are open now[\s\S]*numeric column/);
    assert.equal(fs.readFileSync(path.join(out, "contract.md"), "utf8"), contract + "\n");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].auth, "Bearer k");
    assert.equal(seen[0].body.model, "deepseek/deepseek-flash-high");
    assert.equal(seen[0].body.max_tokens, 16000);
    assert.match(seen[0].body.messages[1].content, /Add --sort[\s\S]*# Contract[\s\S]*unknown column/);
    const critic = JSON.parse(fs.readFileSync(path.join(out, "contract-critic.json"), "utf8"));
    assert.equal(critic.model, "deepseek/deepseek-flash-high");
    assert.match((await s.call("tools/call", { name: "contract_ready", arguments: { contract: contract + "\nEdge: numeric sort" } })).content[0].text, /updated/);
    assert.equal(seen.length, 1, "an amended contract is not sent again");
  } finally { s.close(); server.close(); }
});

test("contract_ready: a critic that fails leaves the contract recorded and the edits open", async () => {
  const out = tmp("ab-cout-"), inn = tmp("ab-cin-");
  const s = mcp({ OUT_DIR: out, IN_DIR: inn, CONTRACT_GATE: "1", MODEL: "m", CONTRACT_MODEL: "deepseek/x",
    OMNIROUTE_BASE_URL: "http://127.0.0.1:9", OMNIROUTE_API_KEY: "k", CONTRACT_CRITIC_S: "5" });
  try {
    const r = (await s.call("tools/call", { name: "contract_ready", arguments: { contract: "Requirements: one thing in a.js, its test a.test.js" } })).content[0].text;
    assert.match(r, /could not answer[\s\S]*Edits are open/);
    assert.ok(fs.existsSync(path.join(out, "contract.md")));
    assert.ok(JSON.parse(fs.readFileSync(path.join(out, "contract-critic.json"), "utf8")).error);
  } finally { s.close(); }
});
