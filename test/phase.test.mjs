import { test } from "node:test";
import assert from "node:assert/strict";
import { areas, nextRole, done, pathsArg, planRound, planResumes, failedFiles, deltaFrom, whyUnreviewed } from "../lib/phase.mjs";

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

test("pathsArg joins with spaces unless a path has whitespace", () => {
  assert.equal(pathsArg(["a/x.ts", "docs/reference/specialists.md"]), "a/x.ts docs/reference/specialists.md");
  assert.equal(pathsArg(["a b/x.ts", "c.ts"]), "a b/x.ts\nc.ts");
});

const famOf = (r) => ({ "review-both-ocr": "google", "review-both-ocr-deepseek": "deepseek" })[r.split("@")[0]];
const parts = (role) => (role.startsWith("review-both-ocr") ? [["a", "b", "c"]] : [["a"], ["b"], ["c"]]);

test("planRound starts the next family's round, OCR over the whole diff", () => {
  const roles = ["review-both-ocr", "review-both-ocr-deepseek"];
  assert.deepEqual(planRound([], "h", roles, famOf, parts), { resume: null, role: "review-both-ocr", parts: [{ area: 1, files: ["a", "b", "c"] }] });
  const r1 = { k: 1, role: "review-both-ocr", family: "google", head: "h", clean: true, unreviewed: [] };
  assert.equal(planRound([r1], "h", roles, famOf, parts).role, "review-both-ocr-deepseek");
});

test("planRound finishes a round's unreviewed areas before a new round, and only those", () => {
  const r1 = { k: 1, role: "review-both@high", family: "deepseek", head: "h", clean: false, unreviewed: [2, 3] };
  const p = planRound([r1], "h", ["review-both"], () => "deepseek", parts);
  assert.equal(p.resume, r1);
  assert.equal(p.role, "review-both@high");
  assert.deepEqual(p.parts, [{ area: 2, files: ["b"] }, { area: 3, files: ["c"] }]);
  // Stored files win over recomputed areas; another head starts over.
  assert.deepEqual(planRound([{ ...r1, unreviewedFiles: [["x"], ["y"]] }], "h", ["review-both"], () => "deepseek", parts).parts,
    [{ area: 2, files: ["x"] }, { area: 3, files: ["y"] }]);
  assert.equal(planRound([r1], "other", ["review-both"], () => "deepseek", parts).resume, null);
});

test("whyUnreviewed names the harness error, not the spec warning", () => {
  assert.equal(whyUnreviewed("boxie: warning: no spec\nboxie: unknown option docs/reference/specialists.md\n"), "boxie: unknown option docs/reference/specialists.md");
  assert.equal(whyUnreviewed("boxie: warning: no spec\nrun x\np18-close-r1-a2-review-both: no verdict\n"), "p18-close-r1-a2-review-both: no verdict");
  assert.equal(whyUnreviewed(""), "no output");
});

test("planResumes finishes both rounds of a side-by-side pair", () => {
  const a = { k: 1, role: "review-both-ocr", head: "h", unreviewed: [1], unreviewedFiles: [["x.ts"]] };
  const b = { k: 2, role: "review-both-ocr-deepseek", head: "h", unreviewed: [1], unreviewedFiles: [["y.ts"]] };
  assert.deepEqual(planResumes([a, b], "h", parts).map((p) => [p.role, p.parts[0].files]), [["review-both-ocr", ["x.ts"]], ["review-both-ocr-deepseek", ["y.ts"]]]);
  assert.deepEqual(planResumes([a, { ...b, unreviewed: [] }], "h", parts).map((p) => p.role), ["review-both-ocr"]);
});

test("failedFiles reads open-code-review's failed paths", () => {
  assert.deepEqual(failedFiles({ manifest: { coverage: { failed: [{ path: "a.ts", reason: "provider" }, { path: "b.test.ts" }] } } }), ["a.ts", "b.test.ts"]);
  assert.deepEqual(failedFiles(null), []);
});

test("deltaFrom: after a fully read pair on an ancestor head, else the whole diff", () => {
  const yes = () => true, no = () => false;
  const r = (head, unreviewed = []) => ({ head, unreviewed });
  assert.equal(deltaFrom([r("h1"), r("h1")], "h2", yes), "h1");
  assert.equal(deltaFrom([r("h1"), r("h1")], "h2", no), null, "a rewritten history reads it all");
  assert.equal(deltaFrom([r("h1"), r("h1", [3])], "h2", yes), null, "an area left unread on h1");
  assert.equal(deltaFrom([r("h1")], "h2", yes), null, "one family only on h1");
  assert.equal(deltaFrom([r("h1"), r("h1"), r("h2")], "h2", yes), "h1");
  assert.equal(deltaFrom([], "h1", yes), null);
});
