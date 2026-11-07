// boxie OpenCode plugin: after every edit, write or patch, parse the touched files and append any
// syntax error to the tool result, so a broken file is caught on the same step instead of at test
// time (Composer twice broke a file with a whole-file write; research/findings.md §3).
// Installed as ~/.config/opencode/plugins/boxie.js. Hook shape: research/opencode-customization.md §6.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const CHECK = "/opt/boxie/syntax-check.mjs";

function touched(tool, args = {}) {
  if (tool === "edit" || tool === "write") return args.filePath ? [args.filePath] : [];
  if (tool === "apply_patch") return [...String(args.patchText ?? "").matchAll(/^\*\*\* (?:Update|Add) File: (.+)$/gm)].map((m) => m[1].trim());
  return [];
}

// The Read tool's own output (path and type tags, numbered lines) pasted as file content. Composer did
// this twice in one bench run (2026-10-12, trivial-low-stock) and needed 4 more steps to recover.
const READ_DUMP = /^\s*<path>[^\n]*<\/path>\s*\n\s*<type>(?:file|directory)<\/type>/;

// SPEC_GATE=1: no edit before the spec check is recorded or a question asked (image/ask-mcp.mjs writes
// the file). Known gap 29: the check folded into the implementer instead of a session of its own.
const SPEC_FILE = () => process.env.SPEC_GATE_FILE || "/out/spec-check.md";
// CONTRACT_GATE=1: no edit before the contract is recorded (image/ask-mcp.mjs contract_ready).
const CONTRACT_FILE = () => process.env.CONTRACT_FILE || "/out/contract.md";

// READ_MIN_LINES: a read asking for fewer lines gets this many. Gemini asked for 100 lines or fewer in
// 10880 of 12584 reads (mostly 25-60), and every read is a model step at 4-9 s with the whole context
// (research/factory-2026-11-07.md). 0 keeps the model's own limit.
function widenRead(args, min = Number(process.env.READ_MIN_LINES || 0)) {
  if (min > 0 && args && typeof args.limit === "number" && args.limit < min) args.limit = min;
  return args;
}

// WRAP_MIN minutes before the cut (run-task.sh writes the cut's epoch to /out/deadline), one note on
// a tool result: finish to a committed, passing state and report. 14 Gemini implement runs hit the cut
// mid-work with no report (ledger, 2026-10-12..11-06).
const DEADLINE = () => `${process.env.OUT_DIR || "/out"}/deadline`;
// `seen` holds the cut already noted: a parked container's server lives on into the next round, which
// writes a new cut.
function wrapNote(seen, now = Date.now() / 1000, file = DEADLINE(), wrapMin = Number(process.env.WRAP_MIN || 0)) {
  if (!(wrapMin > 0) || !existsSync(file)) return null;
  const cut = Number(readFileSync(file, "utf8").trim());
  if (!cut || seen.cut === cut || now < cut - wrapMin * 60) return null;
  seen.cut = cut;
  const left = Math.max(0, Math.round((cut - now) / 60));
  return `\n\n[boxie] About ${left} minute(s) left before this run is cut. Stop exploring and starting new work. `
    + "Get what you have to a state that builds and passes the task's test, commit it, and write the final report "
    + "now, listing what is done and what is not.";
}

export const Boxie = async ({ directory }) => {
  const wrapped = { cut: null };
  let reviewTools = {};
  if (process.env.REVIEW === "1" && existsSync("/in/bundles.json")) {
    const { tool } = await import("@opencode-ai/plugin");
    const { checkpoint } = await import("/opt/boxie/review-state.mjs");
    // Frozen with the tool schema at server boot; every part uses the same prepared diff and rules.
    const bundles = JSON.parse(readFileSync("/in/bundles.json", "utf8"));
    reviewTools = { review_report: tool({
      description: "Save new findings and completed files for your assigned review part. Call after each file; saved findings survive a timeout. Set complete only after checking all assigned files and their callers/contracts. Never resend saved findings.",
      args: {
        part: tool.schema.number().int().min(1),
        reviewed_files: tool.schema.array(tool.schema.string()),
        complete: tool.schema.boolean(),
        findings: tool.schema.array(tool.schema.object({
          file: tool.schema.string(), line: tool.schema.number().int().min(1),
          severity: tool.schema.enum(["critical", "high", "medium", "low"]),
          category: tool.schema.string(), issue: tool.schema.string(), scenario: tool.schema.string(),
          existing_code: tool.schema.string(), suggestion: tool.schema.string(),
          evidence: tool.schema.array(tool.schema.object({ file: tool.schema.string(), line: tool.schema.number().int().min(1) })).max(4),
        })).max(30),
      },
      execute: async (args, ctx) => checkpoint(args, ctx.sessionID, { bundles, root: directory, out: process.env.OUT_DIR || "/out" }),
    }) };
  }
  return {
  tool: reviewTools,
  "tool.execute.before": async (input, output) => {
    if (input.tool === "read") widenRead(output.args);
    if (process.env.SPEC_GATE === "1" && ["edit", "write", "apply_patch"].includes(input.tool) && !existsSync(SPEC_FILE()))
      throw new Error("Rejected: check the task first (the first step in your instructions). Call spec_checked with "
        + "\"nothing undecided\" or the points the code and docs settle, or ask_orchestrator about a contradiction or open "
        + "decision. The file was not changed.");
    if (process.env.CONTRACT_GATE === "1" && ["edit", "write", "apply_patch"].includes(input.tool) && !existsSync(CONTRACT_FILE()))
      throw new Error("Rejected: write the contract first (the first step in your instructions) and call contract_ready with it. "
        + "The file was not changed.");
    const text = input.tool === "write" ? output.args?.content : input.tool === "edit" ? output.args?.newString : null;
    if (typeof text === "string" && READ_DUMP.test(text))
      throw new Error("Rejected: this content is the read tool's output (<path>, <type> tags and numbered lines), not file text. "
        + "Write only the file's own lines, without the tags and without the 'N: ' line numbers. The file was not changed.");
  },
  "tool.execute.after": async (input, output) => {
    const note = process.env.REVIEW === "1" ? null : wrapNote(wrapped);
    if (note) output.output = `${output.output ?? ""}${note}`;
    // Dependency discovery by hand (javap, unzip, jar listings under the build caches): point at `api`,
    // whose answers are short and cached. t51 (2026-10-16): 36 of 61 shell calls were this.
    const cmd = input.tool === "bash" ? String(input.args?.command ?? "") : "";
    if (/\bjavap\b|\bunzip\b[^|]*\.jar|\bjar\s+-?t|\.gradle\/caches|\.m2\/repository/.test(cmd) && !/\bapi\s/.test(cmd))
      output.output = `${output.output ?? ""}\n\n[boxie] For dependency classes use \`api find <regex>\`, \`api show <Class>\`, \`api grep <regex> --jar <name>\`, or \`api src <Class> [method]\` for decompiled source instead of javap -c bytecode: short and cached.`;
    for (const f of touched(input.tool, input.args)) {
      const file = f.startsWith("/") ? f : `${directory}/${f}`;
      try {
        execFileSync("node", [CHECK, file], { stdio: "pipe", timeout: 65000 });
      } catch (e) {
        const msg = String(e.stdout || "").trim();
        if (msg) output.output = `${output.output ?? ""}\n\n[boxie syntax check] ${f} no longer parses:\n${msg}\nFix this file before anything else.`;
      }
    }
  },
  };
};
// Helpers for the tests, as properties: OpenCode runs every function the module exports as a plugin
// (an exported helper made every run fail with UnknownError on its first step, 2026-11-07).
Boxie.widenRead = widenRead;
Boxie.wrapNote = wrapNote;
