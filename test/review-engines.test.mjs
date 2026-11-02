// Review engines: open-code-review's comments as Boxie findings (lib/ocr.mjs) and the bundles a
// fanned-out review splits a diff into (lib/bundle.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { toFinding, finalText } from "../lib/ocr.mjs";
import { bundles, skipped } from "../lib/bundle.mjs";
import { finalBlock } from "../lib/ledger.mjs";
import { anchor, parseDiff, locate } from "../image/anchor.mjs";
import { findingsOf, dedupe, partPrompt, lastText } from "../image/fanout.mjs";
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

const DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,4 +10,6 @@ function f() {
   const x = 1;
-  return x;
+  if (x > 0) {
+    return x + 1;
+  }
   // tail
diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,2 +1,3 @@
 import a from "a";
+export const LIMIT = 5;
 export default a;
`;

test("anchor: a quote's lines come from the diff's new side", () => {
  const files = parseDiff(DIFF);
  assert.deepEqual(locate(files.get("src/a.ts"), "if (x > 0) {\n  return x + 1;"), { line: 11, end_line: 12 });
  assert.deepEqual(locate(files.get("src/a.ts"), "+    return x + 1;"), { line: 12, end_line: 12 });
  // Deleted code: the next new-side line.
  assert.deepEqual(locate(files.get("src/a.ts"), "return x;"), { line: 11, end_line: 11 });
  assert.equal(locate(files.get("src/a.ts"), "nowhere()"), null);
});

test("anchor: findings move to the quoted lines, or to the one other file that holds the quote", () => {
  const fs1 = [
    { file: "src/a.ts", line: 99, existing_code: "return x + 1;" },
    { file: "src/a.ts", line: 3, existing_code: "export const LIMIT = 5;" },
    { file: "src/a.ts", line: 7 },
    { file: "src/a.ts", line: 8, existing_code: "not in the diff" },
  ];
  assert.equal(anchor(fs1, DIFF), 2);
  assert.deepEqual([fs1[0].file, fs1[0].line], ["src/a.ts", 12]);
  assert.deepEqual([fs1[1].file, fs1[1].line], ["src/b.ts", 2]);
  assert.equal(fs1[2].line, 7);
  assert.equal(fs1[3].line, 8);
});

test("fanout: a part's findings block, its prompt, and the merge", () => {
  assert.deepEqual(findingsOf("text\n```boxie-findings\n[{\"issue\":\"x\"}]\n```"), [{ issue: "x" }]);
  assert.deepEqual(findingsOf("```json\n{\"findings\": []}\n```"), []);
  assert.equal(findingsOf("no block"), null);
  const p = partPrompt("BASE", { files: ["a.ts"], others: ["b.ts"], rules: "#### Typos", diff: "+x ```" }, 0, 2);
  assert.match(p, /^BASE\n\n# Your part of the review \(1 of 2\)/);
  assert.match(p, /- `a\.ts`/);
  assert.match(p, /- `b\.ts`/);
  assert.match(p, /#### Typos/);
  assert.match(p, /````diff\n\+x ```\n````/);
  const merged = dedupe([
    { file: "a.ts", line: 10, severity: "low", issue: "Misspelled name setefaultAides in the reducer" },
    { file: "a.ts", line: 12, severity: "high", issue: "Misspelled name setefaultAides in the reducer." },
    { file: "b.ts", line: 10, severity: "medium", issue: "Misspelled name setefaultAides in the reducer" },
  ]);
  assert.deepEqual(merged.map((f) => [f.file, f.severity]), [["a.ts", "high"], ["b.ts", "medium"]]);
  const ev = ['{"type":"step_start","sessionID":"s1"}', '{"type":"text","sessionID":"s1","part":{"text":"one"}}', '{"type":"text","sessionID":"s1","part":{"text":"two"}}'].join("\n");
  assert.deepEqual(lastText(ev), { last: "two", sid: "s1" });
});

test("filter: scores drop what the diff disproves; a failed call keeps everything", async () => {
  const { filter, parseScores } = await import("../image/filter.mjs");
  assert.deepEqual(parseScores('```json\n[{"id":1,"analysis":"a","score":2},{"id":2,"score":8}]\n```'), { 1: { score: 2, why: "a" }, 2: { score: 8, why: "" } });
  assert.equal(parseScores("nonsense"), null);
  const fs1 = [{ file: "a", issue: "wrong" }, { file: "b", issue: "right" }, { file: "c", issue: "unscored" }];
  const ok = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '[{"id":1,"analysis":"not in diff","score":1},{"id":2,"analysis":"ok","score":7}]' } }] }) });
  const r = await filter(fs1, "diff", { model: "m", base: "http://x", key: "k", min: 3, fetchImpl: ok });
  assert.deepEqual(r.kept.map((f) => [f.file, f.filter_score]), [["b", 7], ["c", undefined]]);
  assert.deepEqual(r.dropped.map((f) => [f.file, f.filter_why]), [["a", "not in diff"]]);
  const bad = async () => { throw new Error("down"); };
  const r2 = await filter(fs1, "diff", { model: "m", base: "http://x", key: "k", fetchImpl: bad });
  assert.equal(r2.kept.length, 3);
  assert.match(r2.error, /down/);
});

test("merge-reviews: one finding per problem across reviewers, the more severe kept", async () => {
  const { merge } = await import("../lib/merge-reviews.mjs");
  const m = merge([
    { by: "ocr", findings: [{ file: "a.py", line: 10, severity: "medium", issue: "warning_once gets an unhashable dict and lru_cache raises TypeError" }] },
    { by: "gemini", findings: [
      { file: "a.py", line: 11, severity: "high", issue: "lru_cache on warning_once raises TypeError for the unhashable dict argument" },
      { file: "a.py", line: 40, severity: "low", issue: "typo in variable name" },
      { file: "b.py", line: 10, severity: "low", issue: "warning_once gets an unhashable dict and lru_cache raises TypeError" },
    ] },
  ]);
  assert.equal(m.length, 3);
  assert.deepEqual([m[0].severity, m[0].by], ["high", ["ocr", "gemini"]]);
});

test("filter: the prompt carries only the diffs of the files the findings name", async () => {
  const { diffOf, filterPrompt } = await import("../image/filter.mjs");
  const d = "diff --git a/x.py b/x.py\n+one\ndiff --git a/y.py b/y.py\n+two\n";
  assert.equal(diffOf(d, ["y.py"]), "diff --git a/y.py b/y.py\n+two\n");
  const p = filterPrompt([{ file: "x.py", line: 1, issue: "i" }], d);
  assert.match(p, /\+one/);
  assert.doesNotMatch(p, /\+two/);
});
