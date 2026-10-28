// Free models: opencode/<id> runs on OpenCode's own provider, not OmniRoute; FREE_FALLBACK is registered
// on OmniRoute beside it for run-task.sh to switch to at the free limit (image/make-config.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { tmp } from "./tmp.mjs";

function config(env) {
  const home = tmp("ab-free-");
  execFileSync(process.execPath, [path.join(import.meta.dirname, "..", "image", "make-config.mjs")], {
    env: { ...process.env, HOME: home, USERPROFILE: home, MODELS_JSON: path.join(home, "none.json"), ...env }, encoding: "utf8" });
  return JSON.parse(fs.readFileSync(path.join(home, ".config", "opencode", "opencode.json"), "utf8"));
}

test("an opencode/* model goes to OpenCode's own provider; the fallback and scout to OmniRoute", () => {
  const c = config({ MODEL: "opencode/deepseek-v4.1-flash-free", FREE_FALLBACK: "deepseek/deepseek-flash-high", SCOUT_MODEL: "g", EFFORT: "high" });
  assert.equal(c.model, "opencode/deepseek-v4.1-flash-free");
  assert.equal(c.agent.worker.model, "opencode/deepseek-v4.1-flash-free");
  assert.equal(c.agent.scout.model, "omniroute/g");
  assert.deepEqual(Object.keys(c.provider.omniroute.models).sort(), ["deepseek/deepseek-flash-high", "g"]);
  const own = c.provider.opencode.models["deepseek-v4.1-flash-free"];
  assert.equal(own.limit.context, 182000, "COMPACT_AT 150000 + 32000 output, under the 200k catalog limit");
  assert.deepEqual(own.options, { reasoningEffort: "high" });
});

test("an OmniRoute model is unchanged: no opencode provider, no fallback registered", () => {
  const c = config({ MODEL: "deepseek/deepseek-flash-high", FREE_FALLBACK: "x/y" });
  assert.equal(c.model, "omniroute/deepseek/deepseek-flash-high");
  assert.equal(c.provider.opencode, undefined);
  assert.deepEqual(Object.keys(c.provider.omniroute.models), ["deepseek/deepseek-flash-high"]);
});

test("free models keep their vendor's family", async () => {
  const { family } = await import("../lib/family.mjs");
  assert.equal(family("opencode/deepseek-v4.1-flash-free"), "deepseek");
  assert.equal(family("opencode/glm-5.3-flash-free"), "zhipu");
});
