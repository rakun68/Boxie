// Review bundles: which changed files a review covers, and how they split into parts that reviewers
// take in parallel (image/fanout.mjs). Deterministic, like open-code-review's file selection and
// bundling (research/ocr-design.md): code decides what gets reviewed, so no file is skipped because a
// single reviewer ran out of steps. AACR-Bench (2026-11-02): one reviewer per diff took 91-148 steps.
//
//   node lib/bundle.mjs <repo> <base> <head> [--max N] [--lines N] [--paths "a b"] [--full [--ocr BIN]]
//     -> JSON {skipped, bundles}; --full adds each bundle's diff, rules and the other files
//
// A bundle is files reviewed together: locale siblings (one key added to every language file), a
// source file and its test, then small groups packed together (same directory first).
import path from "node:path";
import { execFileSync } from "node:child_process";

// Files no reviewer reads: lockfiles, generated or vendored code, binaries, snapshots, minified bundles.
const SKIP = [
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|go\.sum|poetry\.lock|uv\.lock|Pipfile\.lock|composer\.lock|Gemfile\.lock|gradle\.lockfile)$/,
  /(^|\/)(node_modules|vendor|third_party|dist|build|out|target|\.next|coverage)\//,
  /\.(min\.(js|css)|map|snap|lock|png|jpe?g|gif|webp|ico|svg|pdf|zip|gz|tgz|jar|woff2?|ttf|eot|mp[34]|wav|so|dll|exe|bin|class|pyc)$/i,
  /(^|\/)__snapshots__\//,
  /\.(pb|pb\.go|generated\.\w+|g\.dart|freezed\.dart)$/,
];
export const skipped = (f) => SKIP.some((re) => re.test(f));

// Locale files: messages_en.properties, en-us.json, locales/ja/x.json. Grouped by directory and suffix.
const LOCALE = /(^|[/_.-])([a-z]{2}([_-][a-zA-Z]{2,4})?)(\.[a-z]+)$/;
const localeKey = (f) => {
  const dir = path.posix.dirname(f), base = path.posix.basename(f);
  if (/(^|\/)(i18n|l10n|locales?|lang|translations?|messages)(\/|$)/i.test(dir) && /\.(json|ya?ml|po|properties|xml|strings|arb|ts|js)$/.test(base))
    return `loc:${dir.replace(/\/[a-z]{2}([_-][a-zA-Z]{2,4})?$/i, "")}:${path.posix.extname(base)}`;
  const m = base.match(LOCALE);
  return m && /properties|json|ya?ml|po|strings/.test(m[4]) ? `loc:${dir}:${base.slice(0, m.index)}${m[4]}` : null;
};
// A test and the file it tests: foo.test.ts / foo.spec.ts / test_foo.py / foo_test.go / FooTest.java -> foo.
const stemOf = (f) => path.posix.basename(f).replace(/\.(test|spec)(?=\.)/, "").replace(/(Test|Tests)?\.[^.]+$/, "")
  .replace(/_test$/, "").replace(/^test_/, "").toLowerCase();

// The directory a file belongs to, test folders folded into their parent: src/a/__tests__/x.test.ts and
// src/a/x.ts share src/a.
const homeDir = (f) => path.posix.dirname(f).split("/").filter((s) => !/^(__tests__|tests?|specs?|__mocks__)$/i.test(s)).join("/");

// Bundles of at most maxFiles files and about bundleLines changed lines (open-code-review's groups held
// 1-7 files on the AACR sample), at most maxBundles of them. A group (locale siblings, a file and its
// test) is never split; past maxBundles, groups join the least loaded bundle.
export function bundles(changes, { maxBundles = 8, bundleLines = 150, maxFiles = 6 } = {}) {
  const keep = changes.filter((c) => !skipped(c.file));
  const groups = new Map();
  for (const c of keep) {
    const k = localeKey(c.file) ?? `stem:${homeDir(c.file)}:${stemOf(c.file)}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  // Largest first; a group joins the emptiest bundle it fits in (same directory first), else opens one.
  const sorted = [...groups.values()].map((cs) => ({ files: cs.map((c) => c.file), lines: cs.reduce((n, c) => n + c.lines, 0) }))
    .sort((a, b) => b.lines - a.lines || a.files[0].localeCompare(b.files[0]));
  const out = [];
  for (const g of sorted) {
    const fits = out.filter((b) => b.lines + g.lines <= bundleLines && b.files.length + g.files.length <= maxFiles);
    const near = fits.filter((b) => b.files.some((f) => homeDir(f) === homeDir(g.files[0])));
    const into = (near.length ? near : fits).sort((a, b) => a.lines - b.lines)[0];
    if (into) { into.files.push(...g.files); into.lines += g.lines; }
    else if (out.length < maxBundles) out.push({ files: [...g.files], lines: g.lines });
    else { const least = out.reduce((a, b) => (a.lines <= b.lines ? a : b)); least.files.push(...g.files); least.lines += g.lines; }
  }
  return { skipped: changes.filter((c) => skipped(c.file)).map((c) => c.file), bundles: out };
}

// Changed files with their changed line counts (binary files count 0).
export function changesOf(repo, base, head, paths = []) {
  const out = execFileSync("git", ["-C", repo, "diff", "--numstat", "--no-renames", base, head, "--", ...paths], { encoding: "utf8", maxBuffer: 64 << 20 });
  return out.split("\n").filter(Boolean).map((l) => {
    const [a, d, ...f] = l.split("\t");
    return { file: f.join("\t"), lines: (Number(a) || 0) + (Number(d) || 0) };
  });
}

// The review checklist for each file from open-code-review's per-language rule docs (`ocr delegate rule`,
// no model call; Apache-2.0, research/ocr-design.md §4), as {file: markdown}. {} without the binary.
export function rulesFor(files, bin) {
  if (!bin || !files.length) return {};
  try {
    const out = JSON.parse(execFileSync(bin, ["delegate", "rule", "--format", "json", ...files], { encoding: "utf8", maxBuffer: 16 << 20, timeout: 60000, stdio: ["ignore", "pipe", "ignore"] }));
    const by = {};
    for (const g of out.groups ?? []) for (const f of g.files ?? []) by[f] = g.rule ?? "";
    return by;
  } catch { return {}; }
}

// Bundles ready for image/fanout.mjs: each with its own diff (cut at DIFF_MAX chars), the other changed
// files by name, and the rules for its files, each distinct text once.
const DIFF_MAX = 60000;
export function fullBundles(repo, base, head, { paths = [], maxBundles = 8, bundleLines = 400, ocrBin = null } = {}) {
  const changes = changesOf(repo, base, head, paths);
  const { skipped: sk, bundles: bs } = bundles(changes, { maxBundles, bundleLines });
  const all = bs.flatMap((b) => b.files);
  const rules = rulesFor(all, ocrBin);
  return { skipped: sk, bundles: bs.map((b) => {
    let diff = execFileSync("git", ["-C", repo, "diff", "--no-color", "--no-ext-diff", base, head, "--", ...b.files], { encoding: "utf8", maxBuffer: 64 << 20 });
    if (diff.length > DIFF_MAX) diff = `${diff.slice(0, DIFF_MAX)}\n... (cut at ${DIFF_MAX} characters: read the rest with \`git diff ${base.slice(0, 12)} HEAD -- <file>\`)\n`;
    const texts = [...new Set(b.files.map((f) => rules[f]).filter(Boolean))];
    return { files: b.files, lines: b.lines, diff, rules: texts.join("\n\n"), others: all.filter((f) => !b.files.includes(f)) };
  }) };
}

const main = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
if (main) {
  const [repo, base, head, ...rest] = process.argv.slice(2);
  if (!repo || !base || !head) { console.error("usage: node lib/bundle.mjs <repo> <base> <head> [--max N] [--lines N] [--paths \"a b\"]"); process.exit(2); }
  const opt = (k) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : undefined; };
  const paths = (opt("--paths") ?? "").split(" ").filter(Boolean);
  const o = { paths, maxBundles: Number(opt("--max") ?? 8), bundleLines: Number(opt("--lines") ?? 150), maxFiles: Number(opt("--files") ?? 6) };
  // --full [--ocr BIN]: the bundles fanout.mjs reads (its bundles.json is the "bundles" array).
  if (rest.includes("--full")) console.log(JSON.stringify(fullBundles(repo, base, head, { ...o, ocrBin: opt("--ocr") || null })));
  else console.log(JSON.stringify(bundles(changesOf(repo, base, head, paths), o)));
}
