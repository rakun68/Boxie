import { test } from "node:test";
import assert from "node:assert/strict";
import { areas, nextRole, done } from "../lib/phase.mjs";

test("areas keep a directory together while it fits", () => {
  const files = [{ path: "src/a/x.js", size: 10 }, { path: "src/a/y.js", size: 10 }, { path: "src/b/z.js", size: 15 }, { path: "README.md", size: 5 }];
  assert.deepEqual(areas(files, 25), [["src/a/x.js", "src/a/y.js"], ["src/b/z.js", "README.md"]]);
});

test("a directory larger than max splits, a huge file stands alone", () => {
  const files = [{ path: "lib/a.js", size: 20 }, { path: "lib/b.js", size: 20 }, { path: "lib/c.js", size: 100 }];
  assert.deepEqual(areas(files, 30), [["lib/a.js"], ["lib/b.js"], ["lib/c.js"]]);
});

const fam = (r) => ({ "review-both": "deepseek", "review-both-alt": "anthropic", "review-both-gemini": "google", "review-std": "deepseek" })[r];

test("nextRole rotates and never repeats the last family", () => {
  const roles = ["review-both", "review-both-alt", "review-both-gemini"];
  assert.equal(nextRole([], roles, fam), "review-both");
  assert.equal(nextRole([{ family: "deepseek" }], roles, fam), "review-both-alt");
  assert.equal(nextRole([{ family: "deepseek" }, { family: "anthropic" }], roles, fam), "review-both-gemini");
  assert.equal(nextRole([{ family: "deepseek" }], ["review-both", "review-std", "review-both-alt"], fam), "review-both-alt");
});

test("done needs two clean rounds on the same head from different families", () => {
  const r = (family, clean, head = "h") => ({ family, clean, head });
  assert.equal(done([r("deepseek", true), r("google", true)], "h"), true);
  assert.equal(done([r("deepseek", true), r("deepseek", true)], "h"), false);
  assert.equal(done([r("deepseek", true), r("google", false)], "h"), false);
  assert.equal(done([r("deepseek", true, "old"), r("google", true)], "h"), false);
});
