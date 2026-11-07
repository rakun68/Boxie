// MCP server (stdio, newline-delimited JSON-RPC) that lets a worker ask the orchestrator a question
// mid-run. A question is written to /out/questions/<n>.md; the host answers with
// `delegate.sh answer`, which places /in/answers/<n>.md. No dependencies.
//
// Each call waits at most ASK_WAIT_S seconds (kept under MCP clients' usual 60 s request timeout); the
// worker calls wait_for_answer to keep waiting. After ASK_TIMEOUT_MIN minutes without an answer the
// tool tells the worker to decide itself, so a run never hangs on a question.
import fs from "node:fs";
import path from "node:path";

// OUT_DIR / IN_DIR: the container's /out and /in; the host's tests point them at a scratch folder.
const OUT = process.env.OUT_DIR || "/out", IN = process.env.IN_DIR || "/in";
const QDIR = path.join(OUT, "questions");
const ADIR = path.join(IN, "answers");
// SPEC_GATE=1: the implementer checks the task first, and image/plugin.js refuses edits until this
// file exists. spec_checked writes it; so does a question, since asking is the other way through.
const SPEC_FILE = process.env.SPEC_GATE_FILE || path.join(OUT, "spec-check.md");
const SPEC_GATE = process.env.SPEC_GATE === "1";
const specNote = (line) => { if (SPEC_GATE) fs.appendFileSync(SPEC_FILE, line.trim() + "\n"); };
// CONTRACT_GATE=1: the implementer writes a contract (requirements, ripple, edge cases, unchanged) before
// its first edit; image/plugin.js refuses edits until contract_ready writes it. The first call goes to a
// critic from another model family (CONTRACT_MODEL) that reads it against the task, one pass, no repo.
// Evidence: research/implement-2026-11-07.md. ASK_TOOLS=0: only the contract tool (a run with ASK=0).
const CONTRACT_FILE = process.env.CONTRACT_FILE || path.join(OUT, "contract.md");
const CONTRACT_GATE = process.env.CONTRACT_GATE === "1";
const ASK_TOOLS = process.env.ASK_TOOLS !== "0";
// One line in the harness log, so the live feed (delegate.sh watch, herdr) shows a question the moment
// it is asked; OpenCode reports the tool call itself only when it returns.
const note = (msg) => {
  try { fs.appendFileSync(path.join(OUT, "harness.log"), `[run-task ${new Date().toISOString().slice(11, 19)}] ${msg.replace(/\s+/g, " ").slice(0, 300)}\n`); } catch { /* no log */ }
};
const WAIT_S = Number(process.env.ASK_WAIT_S || 45);
const TIMEOUT_MIN = Number(process.env.ASK_TIMEOUT_MIN || 10);
// Imported by the host's tests (criticModel, CRITIC_PROMPT): no directories, no stdin listener then.
const MAIN = process.argv[1]?.endsWith("ask-mcp.mjs");
if (MAIN) { fs.mkdirSync(QDIR, { recursive: true }); fs.mkdirSync(ADIR, { recursive: true }); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const asked = (id) => fs.statSync(path.join(QDIR, `${id}.md`)).mtimeMs;

async function waitFor(id) {
  const end = Date.now() + WAIT_S * 1000;
  const file = path.join(ADIR, `${id}.md`);
  while (Date.now() < end) {
    if (fs.existsSync(file)) {
      const answer = fs.readFileSync(file, "utf8").trim();
      fs.writeFileSync(path.join(QDIR, `${id}.answer.md`), answer + "\n");
      note(`answer ${id} received`);
      return `Answer to question ${id} from the orchestrator:\n\n${answer}`;
    }
    await sleep(1000);
  }
  if (Date.now() - asked(id) > TIMEOUT_MIN * 60000) {
    fs.writeFileSync(path.join(QDIR, `${id}.timeout`), "");
    return `No answer to question ${id} will come. Decide yourself, and state the decision and your reason under "unsure" in your final message.`;
  }
  return `No answer to question ${id} yet. Call wait_for_answer with id ${id} to keep waiting, or first do work that does not depend on the answer.`;
}

const askTools = [
  {
    name: "ask_orchestrator",
    description:
      "Ask the orchestrator (the engineer who wrote your task) a question and wait for the answer. Use it only when the answer changes what you build: an ambiguous requirement, two designs with different trade-offs, or a conflict between the task and the code. For anything else, decide yourself and record the assumption in your final message. Ask one precise question, give the options you see and which you would pick.",
    inputSchema: {
      type: "object",
      properties: { question: { type: "string", description: "The question, with the options you see and your preferred one" } },
      required: ["question"],
    },
  },
  {
    name: "wait_for_answer",
    description: "Keep waiting for the answer to a question you asked with ask_orchestrator.",
    inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
  },
  ...(SPEC_GATE ? [{
    name: "spec_checked",
    description:
      "Record your check of the task before your first edit: \"nothing undecided\", or each point the code or docs settle, with the deciding path:line. Edits are refused until you call this or ask_orchestrator. A contradiction or a decision the task leaves open goes to ask_orchestrator instead.",
    inputSchema: {
      type: "object",
      properties: { result: { type: "string", description: "\"nothing undecided\", or one line per point: the point, your reading, path:line" } },
      required: ["result"],
    },
  }] : []),
];
const tools = [
  ...(ASK_TOOLS ? askTools : []),
  ...(CONTRACT_GATE ? [{
    name: "contract_ready",
    description:
      "Record the contract for your change before your first edit: requirements (where each goes, the test that fails without it), ripple (path:line of every caller, reader, doc that must change or keep working), edge cases with expected results, and what stays unchanged. Edits are refused until you call this. The first call returns a critic's gaps from another model family; call again with the amended contract if you change it.",
    inputSchema: {
      type: "object",
      properties: { contract: { type: "string", description: "The contract, one line per item, under the four headings" } },
      required: ["contract"],
    },
  }] : []),
];

// The critic: one chat completion through OmniRoute. Any failure leaves the contract recorded and says so.
// Tuned 2026-11-07 on a bench contract with its numeric-sort, tie and --limit cases removed: the first,
// stricter wording got "no gaps" from Sol; this one named numeric sort and stable ties, and still said
// "no gaps" on the full contract (research/implement-2026-11-07.md).
export const CRITIC_PROMPT = `You check an implementation plan (a contract) against the task it is for, before any code is written. The implementer will build exactly what the contract says, so whatever the contract leaves out ships wrong.

Read the task as its author meant it. For each behaviour the task adds or changes, picture a user running it on real data: which inputs would make that user say the result is wrong? Typical ones: numbers or dates compared as text, empty or missing values, equal values (does the order stay stable?), the new option combined with each existing option (which applies first?), invalid input and its message, a repeated or second call. Also the places the task implies change too: help text, docs, other commands or code paths sharing the logic.

List only those gaps: each one a case the contract does not cover or gets wrong, with the result the task's author would expect. Never: style, naming, refactors, new features or options, extra tests for behaviour that is already pinned, or anything the contract already covers. At most 8 items, the most likely to bite first, one line each. If nothing is missing, answer exactly: no gaps.`;

// CONTRACT_MODEL: models to try in order (spaces or commas), then CONTRACT_MODEL_ALT; any of the implementer's
// family is skipped. A list, because a model can leave the gateway's catalog: cx/gpt-6.1-sol-high did on
// 2026-11-07 and every critique failed with HTTP 400 until the run ended.
const family = (id) => (/deepseek/i.test(id) ? "deepseek" : /gemini/i.test(id) ? "gemini" : /claude|opus|sonnet/i.test(id) ? "claude" : /gpt|cx\//i.test(id) ? "gpt" : id);
export function criticModels(env = process.env) {
  const all = [...String(env.CONTRACT_MODEL || "").split(/[\s,]+/), String(env.CONTRACT_MODEL_ALT || "")].filter(Boolean);
  const own = env.MODEL ? family(env.MODEL) : null;
  return [...new Set(all.filter((m) => family(m) !== own))];
}
export const criticModel = (env = process.env) => criticModels(env)[0] ?? "";

async function ask1(model, task, contract) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${process.env.OMNIROUTE_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.OMNIROUTE_API_KEY}` },
      // A reasoning model can spend a small default cap on thinking alone (DeepSeek Flash: 4096 tokens,
      // finish "length", empty answer, 2026-11-07).
      body: JSON.stringify({ model, max_tokens: 16000, messages: [{ role: "system", content: CRITIC_PROMPT },
        { role: "user", content: `# Task\n\n${task.slice(0, 20000)}\n\n# Contract\n\n${contract.slice(0, 20000)}` }] }),
      signal: AbortSignal.timeout(Number(process.env.CONTRACT_CRITIC_S || 150) * 1000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const choice = (await res.json())?.choices?.[0];
    const text = String(choice?.message?.content ?? "").trim();
    if (!text) throw new Error(choice?.finish_reason === "length" ? "empty answer: the output cap went to reasoning" : "empty answer");
    return { model, text, seconds: Math.round((Date.now() - t0) / 1000) };
  } catch (e) {
    return { model, error: String(e.message || e), seconds: Math.round((Date.now() - t0) / 1000) };
  }
}

async function critique(contract) {
  const models = criticModels();
  if (!models.length) return null;
  const task = (() => { try { return fs.readFileSync(path.join(IN, "task.md"), "utf8"); } catch { return ""; } })();
  const failed = [];
  for (const m of models) {
    const c = await ask1(m, task, contract);
    if (!c.error) return failed.length ? { ...c, failed } : c;
    failed.push(c);
    note(`contract critic ${m} failed (${c.seconds} s): ${c.error}`);
  }
  return { ...failed.at(-1), failed };
}

async function call(name, args) {
  if (name === "ask_orchestrator") {
    const ids = fs.readdirSync(QDIR).map((f) => parseInt(f, 10)).filter((n) => !Number.isNaN(n));
    const id = ids.length ? Math.max(...ids) + 1 : 1;
    fs.writeFileSync(path.join(QDIR, `${id}.md`), String(args.question || "").trim() + "\n");
    note(`question ${id}: ${String(args.question || "")}`);
    specNote(`asked: question ${id}`);
    return `Question ${id} sent.\n\n` + (await waitFor(id));
  }
  if (name === "wait_for_answer") {
    const id = Number(args.id);
    if (!fs.existsSync(path.join(QDIR, `${id}.md`))) return `There is no question ${id}.`;
    return waitFor(id);
  }
  if (name === "spec_checked" && SPEC_GATE) {
    const result = String(args.result || "").trim();
    if (!result) return "Give the result: \"nothing undecided\", or the points with their basis.";
    specNote(`checked: ${result}`);
    note(`spec check: ${result}`);
    return "Recorded. Edits are open now.";
  }
  if (name === "contract_ready" && CONTRACT_GATE) {
    const contract = String(args.contract || "").trim();
    if (contract.length < 40) return "Write the contract first: requirements, ripple, edge cases, unchanged, one line per item.";
    const first = !fs.existsSync(CONTRACT_FILE);
    fs.writeFileSync(CONTRACT_FILE, contract + "\n");
    if (!first) { note("contract amended"); return "Contract updated. Edits are open."; }
    note("contract recorded: asking the critic");
    const c = await critique(contract);
    if (c) fs.writeFileSync(path.join(OUT, "contract-critic.json"), JSON.stringify(c) + "\n");
    if (!c) return "Recorded. Edits are open now.";
    if (c.error) { note(`contract critic failed (${c.model}, ${c.seconds} s): ${c.error}`); return "Recorded. The critic could not answer, so check the contract against the task once more yourself. Edits are open now."; }
    note(`contract critic ${c.model} (${c.seconds} s): ${c.text}`);
    return /^no gaps\.?$/i.test(c.text) ? "Recorded. The critic found no gaps. Edits are open now."
      : `Recorded. Edits are open now. The critic (another model family, it read only the task and your contract) found these gaps:\n\n${c.text}\n\nAdd each one you agree with to your work. For one you reject, say why in your final report's decisions.`;
  }
  throw new Error(`unknown tool ${name}`);
}

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");

async function handle(req) {
  const { id, method, params } = req;
  if (id === undefined) return; // notification
  try {
    if (method === "initialize") {
      return send({ id, result: {
        protocolVersion: params?.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "boxie-orchestrator", version: "1.0.0" },
      } });
    }
    if (method === "ping") return send({ id, result: {} });
    if (method === "tools/list") return send({ id, result: { tools } });
    if (method === "tools/call") {
      const text = await call(params.name, params.arguments || {});
      return send({ id, result: { content: [{ type: "text", text }] } });
    }
    send({ id, error: { code: -32601, message: `method not found: ${method}` } });
  } catch (e) {
    send({ id, result: { content: [{ type: "text", text: String(e.message || e) }], isError: true } });
  }
}

let buf = "";
if (MAIN) process.stdin.setEncoding("utf8");
if (MAIN) process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let req; try { req = JSON.parse(line); } catch { continue; }
    handle(req);
  }
});
