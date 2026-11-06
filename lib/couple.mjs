// Coupling between task files: which tasks belong in one worker, which can run in parallel. One agent with
// the whole context beats several on tightly coupled work, and parallel agents pay off only when their
// pieces share little (research/implement-2026-11-07.md: Co-Coder arXiv 2606.00953, SAIGE arXiv
// 2609.19759, Claude Code agent-team guidance). Deterministic, no model: a task's files are its
// frontmatter `files:` and `sealed:`; two tasks are coupled when they share a file, or when a file of one
// imports a file of the other (relative imports in JS/TS/Python, the same package in Java/Kotlin).
//
//   node lib/couple.mjs <repo> <task.md>... [--json]
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

const front = (text) => {
  const m = text.replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---/);
  try { return m ? YAML.parse(m[1]) ?? {} : {}; } catch { return {}; }
};
const list = (v) => (Array.isArray(v) ? v : v ? [v] : []).map(String);
const norm = (p) => p.replace(/\\/g, "/").replace(/^\.\//, "");

// The repo files a source file imports, resolved against the files that exist.
export function importsOf(repo, file, read = (f) => fs.readFileSync(path.join(repo, f), "utf8")) {
  let text; try { text = read(file); } catch { return []; }
  const dir = path.posix.dirname(file), out = new Set();
  const exists = (f) => { try { return fs.statSync(path.join(repo, f)).isFile(); } catch { return false; } };
  for (const m of text.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)["'](\.{1,2}\/[^"']+)["']/g)) {
    const base = path.posix.normalize(path.posix.join(dir, m[1]));
    const stem = base.replace(/\.(js|mjs|cjs)$/, "");
    for (const c of [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.js`, `${stem}.mjs`, `${base}/index.ts`, `${base}/index.js`]) if (exists(c)) { out.add(c); break; }
  }
  for (const m of text.matchAll(/^from\s+(\.+)([\w.]*)\s+import/gm)) {
    const up = m[1].length - 1, parts = m[2] ? m[2].split(".") : [];
    const base = path.posix.join(dir, ...Array(up).fill(".."), ...parts);
    for (const c of [`${base}.py`, `${base}/__init__.py`]) if (exists(c)) { out.add(path.posix.normalize(c)); break; }
  }
  return [...out];
}

const pkgOf = (repo, file, read) => {
  if (!/\.(java|kt)$/.test(file)) return null;
  try { return read(file).match(/^\s*package\s+([\w.]+)/m)?.[1] ?? null; } catch { return null; }
};

// Pairs of coupled tasks with the reason, and groups (connected components): each group is one worker,
// or its tasks in sequence; separate groups can run in parallel.
export function couple(repo, tasks, read = (f) => fs.readFileSync(path.join(repo, f), "utf8")) {
  const t = tasks.map(({ name, text }) => {
    const fm = front(text);
    const files = [...new Set([...list(fm.files), ...list(fm.sealed)].map(norm))];
    return { name, files, imports: new Set(files.flatMap((f) => importsOf(repo, f, read))),
      pkgs: new Set(files.map((f) => pkgOf(repo, f, read)).filter(Boolean)) };
  });
  const pairs = [];
  for (let i = 0; i < t.length; i++) for (let j = i + 1; j < t.length; j++) {
    const a = t[i], b = t[j], why = [];
    const shared = a.files.filter((f) => b.files.includes(f));
    if (shared.length) why.push(`both change ${shared.join(", ")}`);
    const ab = b.files.filter((f) => a.imports.has(f)), ba = a.files.filter((f) => b.imports.has(f));
    if (ab.length) why.push(`${a.name} imports ${ab.join(", ")}`);
    if (ba.length) why.push(`${b.name} imports ${ba.join(", ")}`);
    const pk = [...a.pkgs].filter((p) => b.pkgs.has(p));
    if (pk.length) why.push(`same package ${pk.join(", ")}`);
    if (why.length) pairs.push({ a: a.name, b: b.name, why });
  }
  const parent = new Map(t.map((x) => [x.name, x.name]));
  const find = (x) => (parent.get(x) === x ? x : find(parent.get(x)));
  for (const p of pairs) parent.set(find(p.a), find(p.b));
  const groups = new Map();
  for (const x of t) { const r = find(x.name); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(x.name); }
  const unknown = t.filter((x) => !x.files.length).map((x) => x.name);
  return { pairs, groups: [...groups.values()], unknown };
}

export function describe({ pairs, groups, unknown }) {
  const out = [];
  const multi = groups.filter((g) => g.length > 1), single = groups.filter((g) => g.length === 1);
  for (const g of multi) {
    out.push(`one worker (or in sequence): ${g.join(", ")}`);
    for (const p of pairs.filter((p) => g.includes(p.a))) out.push(`  ${p.a} <> ${p.b}: ${p.why.join("; ")}`);
  }
  if (single.length) out.push(`independent, parallel: ${single.map((g) => g[0]).join(", ")}`);
  if (unknown.length) out.push(`no files: in the frontmatter, coupling unknown: ${unknown.join(", ")}`);
  return out.join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"))) {
  const args = process.argv.slice(2), json = args.includes("--json");
  const [repo, ...files] = args.filter((a) => a !== "--json");
  if (!repo || !files.length) { console.error("usage: couple <repo> <task.md>... [--json]"); process.exit(2); }
  const tasks = files.map((f) => ({ name: path.basename(f).replace(/\.md$/, "") === "task" ? path.basename(path.dirname(f)) : path.basename(f).replace(/\.md$/, ""), text: fs.readFileSync(f, "utf8") }));
  const r = couple(repo, tasks);
  console.log(json ? JSON.stringify(r, null, 2) : describe(r));
}
