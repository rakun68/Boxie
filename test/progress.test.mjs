// image/progress.mjs on a fake /out: what `stats live` shows while a review runs in parts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmp } from "./tmp.mjs";

const PROGRESS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../image/progress.mjs");
const step = (tool) => [{ type: "step_start" }, { type: "tool_use", part: { tool, state: { input: { pattern: "x" } } } },
  { type: "step_finish", part: { tokens: { input: 10, output: 2 } } }].map((e) => JSON.stringify(e)).join("\n") + "\n";

function progress(setup) {
  const out = tmp("ab-progress-");
  fs.writeFileSync(path.join(out, "phase"), "done\n");
  setup(out);
  execFileSync(process.execPath, [PROGRESS], { env: { ...process.env, OUT_DIR: out, IN_DIR: out }, timeout: 10000 });
  return JSON.parse(fs.readFileSync(path.join(out, "progress.json"), "utf8"));
}

// The AACR bench's live status read 0 steps while eight parts were working (2026-11-03).
test("a review in parts: steps and tokens of every part, each part on its own", () => {
  const p = progress((out) => {
    fs.mkdirSync(path.join(out, "parts"));
    fs.writeFileSync(path.join(out, "parts", "1.events.jsonl"), step("read") + step("grep"));
    fs.writeFileSync(path.join(out, "parts", "2.events.jsonl"), step("read"));
  });
  assert.equal(p.steps, 3);
  assert.equal(p.tokens.input, 30);
  assert.deepEqual(p.parts, [{ steps: 2, tools: 2 }, { steps: 1, tools: 1 }]);
});

test("the parts joined into events.jsonl at the end are not counted twice", () => {
  const p = progress((out) => {
    fs.mkdirSync(path.join(out, "parts"));
    fs.writeFileSync(path.join(out, "parts", "1.events.jsonl"), step("read"));
    fs.writeFileSync(path.join(out, "events.jsonl"), step("read"));
  });
  assert.equal(p.steps, 1);
});

test("one session: events.jsonl as before", () => {
  const p = progress((out) => fs.writeFileSync(path.join(out, "events.jsonl"), step("read") + step("bash")));
  assert.equal(p.steps, 2);
  assert.deepEqual(p.parts, []);
});
