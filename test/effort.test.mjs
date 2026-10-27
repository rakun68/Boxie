import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve, splitRole } from "../lib/effort.mjs";

const ids = ["deepseek/deepseek-flash", "deepseek/deepseek-flash-low", "deepseek/deepseek-flash-high", "deepseek/deepseek-flash-max",
  "gemini-3.8-flash-tiered", "antigravity/claude-opus-4-6-thinking-high", "codex/gpt-6-sol", "codex/gpt-6-sol-high", "codex/gpt-6-sol-max"];

test("splitRole", () => {
  assert.deepEqual(splitRole("review-std@max"), { role: "review-std", effort: "max" });
  assert.deepEqual(splitRole("implement"), { role: "implement", effort: "" });
});

test("no effort keeps the model", () => assert.deepEqual(resolve("x/y", "", ids), { model: "x/y", effort: "" }));

test("effort in the id: swap or add the suffix", () => {
  assert.deepEqual(resolve("deepseek/deepseek-flash-max", "low", ids), { model: "deepseek/deepseek-flash-low", effort: "" });
  assert.deepEqual(resolve("deepseek/deepseek-flash", "high", ids), { model: "deepseek/deepseek-flash-high", effort: "" });
  assert.deepEqual(resolve("codex/gpt-6-sol", "max", ids), { model: "codex/gpt-6-sol-max", effort: "" });
});

test("a missing variant is an error naming the ones that exist", () =>
  assert.throws(() => resolve("deepseek/deepseek-flash-max", "xhigh", ids), /has low, high, max/));

test("antigravity claude without a variant refuses", () =>
  assert.throws(() => resolve("antigravity/claude-opus-4-6-thinking-high", "low", ids), /fixed by the model id/));

test("antigravity claude with no suffix refuses", () =>
  assert.throws(() => resolve("antigravity/claude-sonnet-5", "low", ids), /fixed by the model id/));

test("other models get reasoning_effort", () =>
  assert.deepEqual(resolve("gemini-3.8-flash-tiered", "low", ids), { model: "gemini-3.8-flash-tiered", effort: "low" }));

test("unknown level and no list", () => {
  assert.throws(() => resolve("x", "huge", ids), /unknown effort/);
  assert.equal(resolve("x", "high", []).effort, "high");
});
