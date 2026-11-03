// lib/consolidate.mjs: several reviewers' findings joined by problem and scored, one call per file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { consolidate, parseGroups, fileDiff } from "../lib/consolidate.mjs";

const DIFF = `diff --git a/a.c b/a.c
--- a/a.c
+++ b/a.c
@@ -1,2 +1,3 @@
 int x;
+int y = f();
 int z;
`;
const answer = (content, ok = true) => async () => ({ ok, status: ok ? 200 : 500, json: async () => ({ choices: [{ message: { content } }] }) });

test("consolidate: parseGroups keeps every id once and leaves out none", () => {
  const g = parseGroups('```json\n[{"ids":[1,3],"best":3,"analysis":"same leak","score":7},{"ids":[3,9],"best":9,"score":1}]\n```', 4);
  assert.deepEqual(g.map((x) => x.ids), [[1, 3], [2], [4]]);
  assert.equal(g[0].best, 3);
  assert.equal(g[1].score, null);
  assert.equal(parseGroups("no json", 2), null);
});

test("consolidate: repeats across reviewers become one finding, a disproved one drops", async () => {
  const lists = [
    { by: "ocr", findings: [{ file: "a.c", line: 2, issue: "y leaks", severity: "medium" }, { file: "a.c", line: 2, issue: "y is unused", severity: "low" }] },
    { by: "fanout", findings: [{ file: "a.c", line: 2, issue: "f() result leaked", severity: "high" }] },
  ];
  const r = await consolidate(lists, DIFF, { model: "m", base: "b", key: "k",
    fetchImpl: answer('[{"ids":[1,3],"best":3,"analysis":"one leak","score":7},{"ids":[2],"best":2,"analysis":"y is used","score":0}]') });
  assert.equal(r.kept.length, 1);
  assert.equal(r.kept[0].issue, "f() result leaked");
  assert.deepEqual(r.kept[0].by.sort(), ["fanout", "ocr"]);
  assert.equal(r.kept[0].consolidated, 2);
  assert.equal(r.dropped.length, 1);
  assert.equal(r.error, null);
});

test("consolidate: a failed call keeps the file's findings", async () => {
  const lists = [{ by: "ocr", findings: [{ file: "a.c", line: 2, issue: "y leaks" }, { file: "b.c", line: 1, issue: "z" }] }];
  const r = await consolidate(lists, DIFF, { model: "m", base: "b", key: "k", fetchImpl: answer("", false) });
  assert.equal(r.kept.length, 2);
  assert.equal(r.dropped.length, 0);
  assert.match(r.error, /a\.c: 500/);
});

test("consolidate: the file's diff is numbered on the new side", () => {
  assert.match(fileDiff(DIFF, "a.c"), /\+2: int y = f\(\);/);
  assert.equal(fileDiff(DIFF, "missing.c"), "");
});
