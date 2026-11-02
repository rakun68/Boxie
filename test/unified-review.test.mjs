import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { tmp } from "./tmp.mjs";
import { checkpoint, readCheckpoint, evidenceOf } from "../image/review-state.mjs";
import { anchor } from "../image/anchor.mjs";
import { same } from "../image/review-merge.mjs";
import { merge } from "../image/review-merge.mjs";
import { filter, filterPrompt, parseScores } from "../image/filter.mjs";
import { reviewStatus } from "../image/fanout.mjs";

const diff = "diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-return value;\n+return value.name;\n";
const finding = { file: "a.js", line: 99, severity: "high", issue: "Null value crashes", scenario: "value is null", existing_code: "return value.name;", evidence: [{ file: "caller.js", line: 1 }] };

test("review checkpoints survive a missing final turn, capture source evidence, and require full coverage", () => {
  const root = tmp("review-repo-"), out = tmp("review-out-");
  fs.writeFileSync(path.join(root, "caller.js"), "call(null);\n");
  const opts = { root, out, bundles: [{ files: ["a.js", "b.js"], diff }] };
  checkpoint({ part: 1, reviewed_files: ["a.js"], findings: [finding], complete: false }, "session", opts);
  const partial = readCheckpoint(out, 1);
  assert.equal(partial.complete, false);
  assert.equal(partial.findings[0].line, 1);
  assert.equal(partial.findings[0].location_status, "anchored");
  assert.match(partial.findings[0].evidence[0].text, /1: call\(null\)/);
  assert.throws(() => checkpoint({ part: 1, reviewed_files: [], findings: [], complete: true }, "session", opts), /every assigned/);
  assert.throws(() => checkpoint({ part: 1, reviewed_files: ["b.js"], findings: [], complete: true }, "other", opts), /another session/);
  assert.throws(() => checkpoint({ part: 1, reviewed_files: ["outside"], findings: [] }, "session", opts), /assigned/);
  assert.throws(() => checkpoint({ part: 1, reviewed_files: [], findings: [{ ...finding, file: "outside" }] }, "session", opts), /owned file/);
  checkpoint({ part: 1, reviewed_files: ["b.js"], findings: [], complete: true }, "session", opts);
  assert.equal(readCheckpoint(out, 1).complete, true);
  assert.equal(readCheckpoint(out, 1).findings.length, 1, "saved findings need not be sent again");
});

test("evidence is bounded and cannot escape the repository", () => {
  const root = tmp("review-evidence-");
  fs.writeFileSync(path.join(root, "a.js"), Array.from({ length: 500 }, (_, i) => `line${i}`).join("\n"));
  const refs = [{ file: "../outside", line: 1 }, { file: path.join(root, "a.js"), line: 1 }, { file: "a.js", line: 900 }, { file: "a.js", line: 250 }];
  const ev = evidenceOf(refs, root);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].start_line, 240);
  assert.ok(ev[0].text.length <= 12000);
  assert.doesNotMatch(ev[0].text, /line499/);
});

test("ambiguous quoted code is not anchored; distinct problems on one line are not merged", () => {
  const f = { ...finding, line: 99 };
  anchor([f], diff.replace("+return value.name;", "+return value.name;\n+return value.name;"));
  assert.equal(f.line, 99);
  assert.equal(f.location_status, "unverified");
  assert.equal(same({ ...finding, line: 1 }, { ...finding, line: 1, issue: "Secret token is exposed in logs", scenario: "credentials leak" }), false);
  const afterBlank = { ...finding };
  anchor([afterBlank], diff.replace("+return value.name;", "+\n+return value.name;"));
  assert.equal(afterBlank.line, 2);
  assert.equal(afterBlank.location_status, "anchored");
});

test("partial, failed and completed review coverage stay distinct even with an empty findings list", () => {
  assert.equal(reviewStatus([{ complete: true, findings: [] }]), "complete");
  assert.equal(reviewStatus([{ complete: false, findings: [] }]), "partial");
  assert.equal(reviewStatus([{ complete: false, findings: null }]), "failed");
  assert.equal(reviewStatus([]), "complete");
});

test("the host preserves partial coverage and never records an empty partial review as clean", () => {
  const root = tmp("review-host-"), dir = path.join(root, "runs", "project", "partial");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify({ review: true, commits: 0, agent_exit: 0, setup_exit: 0, test_exit: -1 }));
  fs.writeFileSync(path.join(dir, "findings.json"), "[]");
  fs.writeFileSync(path.join(dir, "fanout.json"), JSON.stringify({ status: "partial", parts: [{ files: ["a.js"], complete: false }] }));
  fs.writeFileSync(path.join(dir, "events.jsonl"), JSON.stringify({ type: "step_finish" }) + "\n");
  const ledger = path.join(root, "ledger.jsonl");
  execFileSync(process.execPath, [path.resolve("lib/ledger.mjs"), "finish", root, dir], { env: { ...process.env, BOXIE_LEDGER: ledger }, stdio: "pipe" });
  const s = JSON.parse(fs.readFileSync(path.join(dir, "summary.json")));
  assert.equal(s.review_coverage.status, "partial");
  assert.equal(s.verdict, "error");
  const events = fs.readFileSync(ledger, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(events.find((e) => e.type === "review").verdict, "incomplete");
});

test("one repeated root cause retains every fix location, without merging unsupported distant claims", () => {
  const a = { ...finding, line: 10, evidence: [{ file: "definition.js", line: 20, text: "source" }] };
  const b = { ...a, line: 100 };
  const [m] = merge([{ findings: [a, b] }]);
  assert.deepEqual(m.locations.map((r) => r.line), [10, 100]);
  assert.equal(same(a, { ...b, evidence: [] }), false);
  assert.equal(same(a, { ...b, issue: "An unrelated overflow" }), false);
});

const response = (scores) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(scores) } }] }) });
test("validation sees captured callers and withholds plausible findings by default", async () => {
  const f = { ...finding, evidence: [{ file: "caller.js", line: 1, text: "1: call(null)" }] };
  assert.match(filterPrompt([f], diff), /call\(null\)/);
  const result = await filter([f], diff, { fetchImpl: async () => response([{ id: 1, score: 4, analysis: "missing contract" }]) });
  assert.equal(result.kept.length, 0);
  assert.equal(result.dropped[0].verification, "plausible");
  const failed = await filter([f], diff, { fetchImpl: async () => { throw new Error("offline"); } });
  assert.equal(failed.kept[0].verification, "unverified");
  assert.equal(parseScores('[{"id":1,"score":11}]'), null);
  assert.equal(parseScores('[{"id":1,"score":null}]'), null);
  assert.equal(parseScores('[{"id":1,"score":1},{"id":1,"score":8}]'), null);
});

test("bounded validation batches check each candidate once with at most three requests in flight", async () => {
  let active = 0, peak = 0, calls = 0, seen = [];
  const fetchImpl = async (_url, options) => {
    active++; peak = Math.max(peak, active); calls++;
    const packet = JSON.parse(JSON.parse(options.body).messages[1].content.split("\n\n")[1]);
    seen.push(...packet.map((f) => f.issue));
    assert.ok(packet.length <= 8);
    await new Promise((resolve) => setTimeout(resolve, 5)); active--;
    return response(packet.map((f) => ({ id: f.id, score: 8, analysis: "supported" })));
  };
  const items = Array.from({ length: 33 }, (_, i) => ({ ...finding, issue: `issue${i}` }));
  const result = await filter(items, diff, { fetchImpl });
  assert.equal(calls, 5); assert.equal(peak, 3);
  assert.equal(new Set(seen).size, 33);
  assert.deepEqual(result.kept.map((f) => f.issue), items.map((f) => f.issue));
});

test("a slow validation batch cannot give queued batches another full time budget", async () => {
  let calls = 0;
  const fetchImpl = async (_url, { signal }) => {
    calls++;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 1000);
      signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    });
  };
  const result = await filter(Array.from({ length: 33 }, () => finding), diff, { fetchImpl, timeoutMs: 10 });
  assert.equal(calls, 3, "queued batches do not start network calls after the shared deadline");
  assert.equal(result.kept.length, 33);
  assert.ok(result.kept.every((f) => f.verification === "unverified"));
  assert.match(result.error, /filter:/);
});
