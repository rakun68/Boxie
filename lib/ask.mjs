// One-pass advisor call: no container, no tools. For debating a plan or design with a second model.
//
//   node lib/ask.mjs <model> <prompt-file|-> <out-file> [context-file ...]
//
// Env: OMNIROUTE_API_KEY, OMNIROUTE_HOST_URL (default http://localhost:20128/v1), EFFORT (optional).
// Context files are appended verbatim under their paths, capped at 60k characters in total.
import fs from "node:fs";
import http from "node:http";
import https from "node:https";

const [model, promptPath, outPath, ...contextFiles] = process.argv.slice(2);
if (!model || !promptPath || !outPath) {
  console.error("usage: ask.mjs <model> <prompt-file|-> <out-file> [context-file ...]");
  process.exit(2);
}
const key = process.env.OMNIROUTE_API_KEY;
if (!key) { console.error("OMNIROUTE_API_KEY is not set"); process.exit(2); }
const base = process.env.OMNIROUTE_HOST_URL || "http://localhost:20128/v1";

const prompt = fs.readFileSync(promptPath === "-" ? 0 : promptPath, "utf8");
let budget = 60000;
const context = [];
for (const f of contextFiles) {
  const text = fs.readFileSync(f, "utf8");
  const take = text.slice(0, Math.max(0, budget));
  budget -= take.length;
  context.push(`<file path="${f}">\n${take}${take.length < text.length ? "\n[truncated]" : ""}\n</file>`);
  if (budget <= 0) break;
}

const system = [
  "You are a senior engineer advising the orchestrating agent on a software project.",
  "It asks you to debate, critique or brainstorm, not to write the code.",
  "Be direct. Disagree when the reasoning is weak and say why. Give one recommendation, the strongest",
  "argument against it, and what evidence would change your mind. Say plainly what you do not know.",
  "No filler, no restating the question.",
].join(" ");

const body = {
  model,
  messages: [
    { role: "system", content: system },
    { role: "user", content: context.length ? `${prompt}\n\n${context.join("\n\n")}` : prompt },
  ],
};
if (process.env.EFFORT) body.reasoning_effort = process.env.EFFORT;

const started = Date.now();
const TIMEOUT = 15 * 60 * 1000;
// node:http, not fetch: Node's fetch (undici) gives up after 300 s without response headers, whatever
// the abort signal says. Lykos P18 council (2026-10-28): a model that thought for over 5 minutes failed
// with UND_ERR_HEADERS_TIMEOUT. Here one timer covers the whole call.
const post = (route, payload) => new Promise((resolve, reject) => {
  const u = new URL(`${base}/${route}`), data = JSON.stringify(payload);
  const req = (u.protocol === "https:" ? https : http).request(u, { method: "POST", agent: false, headers: {
    Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } }, (r) => {
    let text = "";
    r.setEncoding("utf8");
    r.on("data", (c) => { text += c; });
    r.on("error", (e) => { clearTimeout(timer); reject(e); });
    r.on("end", () => {
      clearTimeout(timer);
      let json = {};
      try { json = JSON.parse(text); } catch { json = { error: { message: text.slice(0, 300) } }; }
      resolve({ status: r.statusCode, ok: r.statusCode >= 200 && r.statusCode < 300, json });
    });
  });
  const timer = setTimeout(() => req.destroy(new Error(`no answer in ${TIMEOUT / 60000} minutes`)), TIMEOUT);
  req.on("error", (e) => { clearTimeout(timer); reject(e); });
  req.end(data);
});
const chat = async (payload) => { const r = await post("chat/completions", payload); return { ...r, answer: r.json.choices?.[0]?.message?.content }; };
let res, json, answer;
try {
  ({ json, answer, ...res } = await chat(body));
  // A reasoning model can spend its whole output on reasoning: finish_reason "length" and no content (the
  // DeepSeek merger on five Lykos P18 councils, 2026-10-28). One retry with low effort and a larger cap.
  if (res.ok && !answer && json.choices?.[0]?.finish_reason === "length") {
    const cap = Number(process.env.ASK_RETRY_MAX_TOKENS) || 32768;
    console.error(`(${model} ran out of output while reasoning; retrying once with low effort and max_tokens ${cap})`);
    ({ json, answer, ...res } = await chat({ ...body, reasoning_effort: "low", max_tokens: cap }));
  }
  // Some models answer only on the Responses API (agentrouter/gpt-6.1-sol: 400 "use /v1/responses", 2026-10-27;
  // advise moved to cx/gpt-6.1-sol, which answers chat completions, 2026-10-28).
  if (res.status === 400 && /\/v1\/responses|responses api/i.test(json.error?.message ?? "")) {
    ({ json, ...res } = await post("responses", { model, instructions: system, input: body.messages[1].content,
      ...(process.env.EFFORT ? { reasoning: { effort: process.env.EFFORT } } : {}) }));
    answer = json.output_text ?? json.output?.flatMap((o) => o.content ?? []).filter((c) => c.type === "output_text").map((c) => c.text).join("") ?? null;
  }
} catch (e) {
  res = { status: 0, ok: false }; json = { error: { message: e.message } };
}
if (!res.ok || !answer) {
  const c = json.choices?.[0];
  console.error(`ask failed (${res.status}): ${json.error?.message ?? (c ? `finish_reason ${c.finish_reason}, ${String(c.message?.content ?? "").length} characters of content, usage ${JSON.stringify(json.usage ?? {})}` : JSON.stringify(json).slice(0, 300))}`);
  // exitCode, not exit(): exiting while fetch's socket closes aborts node on Windows
  // (UV_HANDLE_CLOSING assertion, RakunLoots P9 2026-10-22), hiding the message above.
  process.exitCode = 1;
} else {
  const seconds = Math.round((Date.now() - started) / 1000);
  const record = `# ask ${model}\n\n${seconds}s, usage ${JSON.stringify(json.usage ?? {})}\n\n## Prompt\n\n${prompt.trim()}\n\n## Answer\n\n${answer.trim()}\n`;
  fs.writeFileSync(outPath, record);
  console.log(answer.trim());
  console.error(`\n(${model}, ${seconds}s, usage ${JSON.stringify(json.usage ?? {})}; saved ${outPath})`);
}
