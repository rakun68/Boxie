// image/plugin.js: narrow reads are widened (READ_MIN_LINES), and one wrap-up note is appended WRAP_MIN
// before the cut that run-task.sh writes to /out/deadline.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { tmp } from "./tmp.mjs";

const mod = await import(pathToFileURL(path.join(import.meta.dirname, "..", "image", "plugin.js")));
const { Boxie } = mod, { widenRead, wrapNote } = Boxie;

test("the module exports Boxie alone: OpenCode runs every exported function as a plugin", () => {
  assert.deepEqual(Object.keys(mod), ["Boxie"]);
});

test("widenRead: a narrow read gets the minimum, wider or unlimited reads and 0 are left alone", () => {
  assert.deepEqual(widenRead({ filePath: "a", offset: 500, limit: 40 }, 250), { filePath: "a", offset: 500, limit: 250 });
  assert.deepEqual(widenRead({ filePath: "a", limit: 400 }, 250), { filePath: "a", limit: 400 });
  assert.deepEqual(widenRead({ filePath: "a" }, 250), { filePath: "a" }, "no limit: the tool's default");
  assert.deepEqual(widenRead({ filePath: "a", limit: 40 }, 0), { filePath: "a", limit: 40 });
});

test("wrapNote: nothing before WRAP_MIN, one note after, again for a new cut", () => {
  const file = path.join(tmp("ab-wrap-"), "deadline");
  const seen = { cut: null };
  assert.equal(wrapNote(seen, 1000, file, 8), null, "no deadline file");
  fs.writeFileSync(file, "10000\n");
  assert.equal(wrapNote(seen, 10000 - 9 * 60, file, 8), null, "9 minutes left");
  assert.match(wrapNote(seen, 10000 - 7 * 60, file, 8), /About 7 minute\(s\) left[\s\S]*commit it/);
  assert.equal(wrapNote(seen, 10000 - 6 * 60, file, 8), null, "once per cut");
  fs.writeFileSync(file, "20000\n");
  assert.match(wrapNote(seen, 20000 - 60, file, 8), /About 1 minute/, "a new round's cut is noted again");
  assert.equal(wrapNote({ cut: null }, 20000, file, 0), null, "WRAP_MIN=0: off");
});

test("the hooks: read args are widened in place, and the note rides on a tool result", async () => {
  const out = tmp("ab-wrapout-");
  const before = { READ_MIN_LINES: process.env.READ_MIN_LINES, WRAP_MIN: process.env.WRAP_MIN, OUT_DIR: process.env.OUT_DIR, REVIEW: process.env.REVIEW };
  Object.assign(process.env, { READ_MIN_LINES: "250", WRAP_MIN: "8", OUT_DIR: out, REVIEW: "0" });
  try {
    const hooks = await Boxie({ directory: out });
    const args = { filePath: "x.ts", limit: 30 };
    await hooks["tool.execute.before"]({ tool: "read" }, { args });
    assert.equal(args.limit, 250);
    fs.writeFileSync(path.join(out, "deadline"), `${Math.round(Date.now() / 1000) + 120}\n`);
    const res = { output: "ok" };
    await hooks["tool.execute.after"]({ tool: "grep", args: {} }, res);
    assert.match(res.output, /^ok\n\n\[boxie\] About 2 minute/);
    const res2 = { output: "ok" };
    await hooks["tool.execute.after"]({ tool: "grep", args: {} }, res2);
    assert.equal(res2.output, "ok");
  } finally {
    for (const [k, v] of Object.entries(before)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});
