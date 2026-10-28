// Maps a requested reasoning effort onto what OmniRoute actually honours for a model.
//
//   node lib/effort.mjs <model> <effort>     prints "<model> <effort>" (effort may be empty), or exits 2
//
// Three cases, checked against OmniRoute's model list:
//   - the effort lives in the id (deepseek/deepseek-flash-high, codex/gpt-6-sol-max): swap the suffix
//     or add one, and send no reasoning_effort
//   - antigravity/claude-* without such a variant: the effort is fixed by the id, OmniRoute strips
//     reasoning_effort (research/opencode-customization.md §5), so an override is an error
//   - anything else (an id with no effort variants): keep the id and send reasoning_effort
// The list is cached in runs/.tmp/models.json for a day. With no list, the effort goes as reasoning_effort.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const LEVELS = ["none", "low", "medium", "high", "xhigh", "max", "ultra"];
const SUFFIX = new RegExp(`-(${LEVELS.join("|")})$`);

// "review-std@max" → { role: "review-std", effort: "max" }
export function splitRole(spec) {
  const i = (spec || "").indexOf("@");
  return i < 0 ? { role: spec || "", effort: "" } : { role: spec.slice(0, i), effort: spec.slice(i + 1) };
}

export function resolve(model, effort, ids) {
  if (!effort) return { model, effort: "" };
  if (!LEVELS.includes(effort)) throw new Error(`unknown effort ${effort} (one of ${LEVELS.join(", ")})`);
  if (!ids?.length) return { model, effort, warning: "no model list from OmniRoute: effort sent as reasoning_effort, unchecked" };
  // OmniRoute lists antigravity Claude effort variants its live catalog refuses (claude-opus-4-6-thinking-low, 2026-10-27).
  if (/^(antigravity|ag)\/claude-/.test(model)) {
    if (model.endsWith(`-${effort}`)) return { model, effort: "" };
    throw new Error(`${model}: effort is fixed by the model id, OmniRoute drops reasoning_effort`);
  }
  const have = new Set(ids);
  const stem = model.replace(SUFFIX, "");
  const variants = LEVELS.filter((l) => have.has(`${stem}-${l}`));
  if (have.has(`${stem}-${effort}`)) return { model: `${stem}-${effort}`, effort: "" };
  if (effort === "none" && have.has(stem) && SUFFIX.test(model)) return { model: stem, effort: "" };
  if (variants.length) throw new Error(`${stem} has no ${effort} variant (has ${variants.join(", ")})`);
  return { model, effort };
}

const TTL = 24 * 3600 * 1000;
export async function modelIds(box, base = process.env.OMNIROUTE_HOST_URL || "http://localhost:20128/v1", key = process.env.OMNIROUTE_API_KEY) {
  const cache = path.join(box, "runs", ".tmp", "models.json");
  try {
    if (Date.now() - fs.statSync(cache).mtimeMs < TTL) return JSON.parse(fs.readFileSync(cache, "utf8"));
  } catch {}
  try {
    const res = await fetch(`${base}/models`, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];
    const ids = (await res.json()).data.map((m) => m.id);
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    fs.writeFileSync(cache, JSON.stringify(ids));
    return ids;
  } catch { return []; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [model, effort] = process.argv.slice(2);
  if (!model) { console.error("usage: effort.mjs <model> <effort>"); process.exit(2); }
  const box = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  try {
    const r = resolve(model, effort || "", effort ? await modelIds(box) : []);
    if (r.warning) console.error(`effort: ${r.warning}`);
    console.log(`${r.model} ${r.effort}`.trimEnd());
  } catch (e) { console.error(`effort: ${e.message}`); process.exitCode = 2; } // exit() after fetch aborts node on Windows (lib/ask.mjs)
}
