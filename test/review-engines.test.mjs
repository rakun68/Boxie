// Review engines: open-code-review's comments as Boxie findings (lib/ocr.mjs) and the bundles a
// fanned-out review splits a diff into (lib/bundle.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { toFinding, finalText } from "../lib/ocr.mjs";
import { bundles, skipped } from "../lib/bundle.mjs";
import { finalBlock } from "../lib/ledger.mjs";
import fs from "node:fs";
import path from "node:path";
import { tmp } from "./tmp.mjs";

test("ocr: a comment becomes a finding, its first sentence the issue", () => {
  const f = toFinding({ path: "a/b.ts", content: "Hooks are called conditionally. When x is null the order changes.", existing_code: "if (x) use()",
    start_line: 19, end_line: 30, category: "bug", severity: "critical" });
  assert.equal(f.file, "a/b.ts");
  assert.equal(f.line, 19);
  assert.equal(f.end_line, 30);
  assert.equal(f.issue, "Hooks are called conditionally.");
  assert.equal(f.scenario, "When x is null the order changes.");
  assert.equal(f.category, "logic");
  assert.equal(f.ocr_category, "bug");
  assert.equal(f.confidence, "PLAUSIBLE");
  assert.equal(f.source, "ocr");
  const g = toFinding({ path: "x.py", content: "short", category: "maintainability", severity: "weird" });
  assert.equal(g.severity, "low");
  assert.equal(g.category, "maintainability");
  assert.equal(g.issue, "short");
});

test("ocr: the final message carries a findings block the ledger reads back", () => {
  const dir = tmp("ab-ocr-");
  const fs1 = [toFinding({ path: "a.c", content: "Off by one in the loop bound.", start_line: 3, category: "bug", severity: "high" })];
  fs.writeFileSync(path.join(dir, "final.md"), finalText(fs1, { llm: { model: "m" }, message: "done" }));
  assert.deepEqual(finalBlock(dir, "boxie-findings"), fs1);
  fs.writeFileSync(path.join(dir, "final.md"), finalText([], {}));
  assert.deepEqual(finalBlock(dir, "boxie-findings"), []);
});

test("bundle: lockfiles, binaries and vendored code are not reviewed", () => {
  for (const f of ["package-lock.json", "a/yarn.lock", "img/x.png", "vendor/x.go", "node_modules/a/b.js", "a/__snapshots__/x.snap", "x.min.js"]) assert.ok(skipped(f), f);
  for (const f of ["src/a.ts", "README.md", "a/b_test.go", "package.json"]) assert.ok(!skipped(f), f);
});

test("bundle: locale siblings and a file with its test go together; small groups are packed", () => {
  const ch = [
    { file: "src/i18n/locales/en-us.json", lines: 3 }, { file: "src/i18n/locales/ja-jp.json", lines: 3 }, { file: "src/i18n/locales/zh-cn.json", lines: 3 },
    { file: "src/store/settings.ts", lines: 300 }, { file: "src/store/settings.test.ts", lines: 120 },
    { file: "src/pages/agents/index.ts", lines: 250 }, { file: "package-lock.json", lines: 900 },
  ];
  const { skipped: sk, bundles: b } = bundles(ch, { maxBundles: 8, bundleLines: 400 });
  assert.deepEqual(sk, ["package-lock.json"]);
  const of = (f) => b.findIndex((x) => x.files.includes(f));
  assert.equal(of("src/store/settings.ts"), of("src/store/settings.test.ts"));
  assert.equal(of("src/i18n/locales/en-us.json"), of("src/i18n/locales/zh-cn.json"));
  assert.equal(b.flatMap((x) => x.files).length, 6);
});

test("bundle: never more bundles than the cap, every file kept", () => {
  const ch = Array.from({ length: 30 }, (_, i) => ({ file: `pkg${i}/mod${i}.go`, lines: 150 }));
  const { bundles: b } = bundles(ch, { maxBundles: 4, bundleLines: 400 });
  assert.ok(b.length <= 4);
  assert.equal(b.flatMap((x) => x.files).length, 30);
});
