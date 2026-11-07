// lib/catalog.mjs: the models the config names, checked against OmniRoute's catalog by doctor.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { configModels, missingModels } from "../lib/catalog.mjs";

test("configModels: roles, effort words, lists, defaults, prefixes, and a local override", () => {
  const m = configModels([
    'ROLE_implement="antigravity/gemini-3.8-flash-high"            # comment',
    'ROLE_review_spec_alt="deepseek/deepseek-flash high"',
    'ROLE_review_both_ocr="ocr:antigravity/gemini-3.8-flash-high"',
    'ROLE_quick="opencode/deepseek-v4.1-flash-free"',
    'CONTRACT_MODEL="${CONTRACT_MODEL:-cx/gpt-6.1-sol-high cx/gpt-6-luna}"',
    'SCOUT_MODEL=""',
    'ROLE_implement="omniroute/cx/gpt-6-luna"',
  ].join("\n"));
  assert.deepEqual(Object.fromEntries(m), {
    ROLE_implement: ["cx/gpt-6-luna"], ROLE_review_spec_alt: ["deepseek/deepseek-flash"],
    ROLE_review_both_ocr: ["antigravity/gemini-3.8-flash-high"], CONTRACT_MODEL: ["cx/gpt-6.1-sol-high", "cx/gpt-6-luna"],
  });
  assert.deepEqual(missingModels(m, ["cx/gpt-6-luna", "deepseek/deepseek-flash", "antigravity/gemini-3.8-flash-high"]),
    [{ key: "CONTRACT_MODEL", model: "cx/gpt-6.1-sol-high" }]);
});

test("configModels: boxie.conf parses, and names the default implementer", () => {
  const m = configModels(fs.readFileSync(path.join(import.meta.dirname, "..", "boxie.conf"), "utf8"));
  assert.ok(m.get("ROLE_implement")?.length === 1);
  assert.ok(m.get("CONTRACT_MODEL")?.length >= 2);
});
