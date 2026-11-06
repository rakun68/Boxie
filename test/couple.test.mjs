// lib/couple.mjs: tasks that share a file or import each other's files form one group (one worker, or in
// sequence); the rest run in parallel.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { couple, describe, importsOf } from "../lib/couple.mjs";
import { tmp } from "./tmp.mjs";

function repo(files) {
  const root = tmp("ab-couple-");
  for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), text); }
  return root;
}
const task = (name, files, sealed = []) => ({ name, text: `---\nfiles: [${files.join(", ")}]\nsealed: [${sealed.join(", ")}]\n---\nDo it.\n` });

test("importsOf: relative JS/TS and Python imports that exist", () => {
  const r = repo({ "src/a.ts": 'import { b } from "./b.js";\nconst c = require("../lib/c");\nimport x from "node:fs";\n', "src/b.ts": "", "lib/c.js": "",
    "pkg/m.py": "from .n import f\n", "pkg/n.py": "" });
  assert.deepEqual(importsOf(r, "src/a.ts").sort(), ["lib/c.js", "src/b.ts"]);
  assert.deepEqual(importsOf(r, "pkg/m.py"), ["pkg/n.py"]);
});

test("couple: shared files and imports join a group; the rest are parallel", () => {
  const r = repo({ "src/cli.ts": 'import { parse } from "./args.ts";\n', "src/args.ts": "", "src/text.ts": "", "src/x/A.java": "package app.x;\n", "src/x/B.java": "package app.x;\n" });
  const res = couple(r, [task("sort", ["src/cli.ts"]), task("args", ["src/args.ts"]), task("text", ["src/text.ts"]),
    task("a", ["src/x/A.java"]), task("b", ["src/x/B.java"]), { name: "none", text: "No frontmatter.\n" }]);
  assert.deepEqual(res.groups.filter((g) => g.length > 1), [["sort", "args"], ["a", "b"]]);
  assert.match(res.pairs[0].why[0], /sort imports src\/args\.ts/);
  assert.match(res.pairs[1].why[0], /same package app\.x/);
  assert.deepEqual(res.unknown, ["none"]);
  const text = describe(res);
  assert.match(text, /one worker \(or in sequence\): sort, args/);
  assert.match(text, /independent, parallel: text, none/);
  assert.match(text, /coupling unknown: none/);
});

test("couple: the same file in two tasks", () => {
  const r = repo({ "src/inv.ts": "" });
  const res = couple(r, [task("t1", ["src/inv.ts"]), task("t2", ["src/other.ts"], ["src/inv.ts"])]);
  assert.deepEqual(res.groups, [["t1", "t2"]]);
  assert.match(res.pairs[0].why[0], /both change src\/inv\.ts/);
});
