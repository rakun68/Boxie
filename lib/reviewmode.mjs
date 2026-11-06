// Review mode: who reviews a change. `split` (the default): two reviewers, one axis each, review-spec
// and review-std. `both`: one reviewer covering both axes, review-both. A project sets REVIEW_MODE in
// its projects/<name>.env; a command overrides it with --review-mode, or names the roles with --roles.
// REVIEW_ROLES, when a project sets it, is the same list as --roles.
//
// Precedence: --roles, then --review-mode, then REVIEW_ROLES, then REVIEW_MODE.
//
// A standalone review (delegate.sh review) has two depths of its own, both open-code-review: `normal`, one
// run, and `deep`, REVIEW_DEEP_RUNS runs side by side merged by problem (lib/consolidate.mjs). AACR full3
// and full4 (19 PRs, 2026-11-05): two runs P 0.424 R 0.235, three 0.477 / 0.259, one about 0.39 / 0.21.
//
//   node lib/reviewmode.mjs roles <mode or ""> <REVIEW_ROLES or ""> <REVIEW_MODE or ""> [<REVIEW_DEEP_RUNS>]
//     prints the reviewer roles, comma-separated; exit 2 on an unknown mode
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MODES = { split: ["review-spec", "review-std"], both: ["review-both"], normal: ["review-both-ocr"],
  deep: ["review-both-ocr", "review-both-ocr2", "review-both-ocr3"] };
// deep: the first n open-code-review runs (2 or 3; boxie.conf has three roles).
const deepRuns = (n) => Math.min(3, Math.max(2, Number(n) || 2));

const list = (v) => (Array.isArray(v) ? v : String(v ?? "").split(/[\s,]+/)).map((x) => x.trim()).filter(Boolean);

// roles: an explicit list (array or "a,b"); mode: an explicit mode; listed/defaultMode: the settings.
export function reviewRoles({ roles, mode, listed, defaultMode, deep } = {}) {
  const of = (m) => (m === "deep" ? MODES.deep.slice(0, deepRuns(deep)) : [...MODES[m]]);
  if (list(roles).length) return list(roles);
  if (mode) {
    if (!MODES[mode]) throw new Error(`unknown review mode ${mode} (split, both, normal or deep)`);
    return of(mode);
  }
  if (list(listed).length) return list(listed);
  const m = defaultMode || "split";
  if (!MODES[m]) throw new Error(`unknown REVIEW_MODE ${m} (split, both, normal or deep)`);
  return of(m);
}

// The axis a reviewer role covers: spec, std, or both.
// A role may carry an effort, review-std@max (lib/effort.mjs): the axis is the role's.
export const axisOf = (role) => { const r = String(role ?? "").split("@")[0]; return /^review-both/.test(r) ? "both" : r === "review-std" ? "std" : "spec"; };
// Every role without its own @effort gets this one.
export const withEffort = (roles, effort) => (effort ? roles.map((r) => (r.includes("@") ? r : `${r}@${effort}`)) : roles);
// The role that covers an axis, when no run says which role it was.
export const roleOfAxis = (axis) => (axis === "both" ? "review-both" : axis === "std" ? "review-std" : "review-spec");
// The prompt file (lib/ticket/) a reviewer role reads.
export const promptOf = (role) => ({ spec: "review-spec.md", std: "review-standards.md", both: "review-both.md" })[axisOf(role)];

const main = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (main && process.argv[2] === "roles") {
  try { console.log(reviewRoles({ mode: process.argv[3], listed: process.argv[4], defaultMode: process.argv[5], deep: process.argv[6] }).join(",")); }
  catch (e) { console.error(`boxie: ${e.message}`); process.exit(2); }
}
