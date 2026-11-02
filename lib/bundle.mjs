// Review bundles: which changed files a review covers, and how they split into parts that reviewers
// take in parallel (image/fanout.mjs). Deterministic, like open-code-review's file selection and
// bundling (research/ocr-design.md): code decides what gets reviewed, so no file is skipped because a
// single reviewer ran out of steps. AACR-Bench (2026-11-02): one reviewer per diff took 91-148 steps.
//
//   node lib/bundle.mjs <repo> <base> <head> [--max N] [--paths "a b"]   -> JSON {skipped, bundles}
//
// A bundle is files reviewed together: locale siblings (one key added to every language file), a
// source file and its test, then small bundles packed together up to BUNDLE_LINES changed lines.
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

export function bundles(changes, { maxBundles = 8, bundleLines = 400 } = {}) {
  const keep = changes.filter((c) => !skipped(c.file));
  const groups = new Map();
  for (const c of keep) {
    const k = localeKey(c.file) ?? `stem:${stemOf(c.file)}:${c.file.split("/")[0]}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  // Largest first, then small groups packed into the bundle with the fewest lines, until maxBundles.
  const sorted = [...groups.values()].map((cs) => ({ files: cs.map((c) => c.file), lines: cs.reduce((n, c) => n + c.lines, 0) }))
    .sort((a, b) => b.lines - a.lines || a.files[0].localeCompare(b.files[0]));
  const out = [];
  for (const g of sorted) {
    const small = out.filter((b) => b.lines + g.lines <= bundleLines).sort((a, b) => a.lines - b.lines)[0];
    if (small && (out.length >= maxBundles || g.lines < bundleLines / 4)) { small.files.push(...g.files); small.lines += g.lines; }
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

const main = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
if (main) {
  const [repo, base, head, ...rest] = process.argv.slice(2);
  if (!repo || !base || !head) { console.error("usage: node lib/bundle.mjs <repo> <base> <head> [--max N] [--lines N] [--paths \"a b\"]"); process.exit(2); }
  const opt = (k) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : undefined; };
  const paths = (opt("--paths") ?? "").split(" ").filter(Boolean);
  console.log(JSON.stringify(bundles(changesOf(repo, base, head, paths), { maxBundles: Number(opt("--max") ?? 8), bundleLines: Number(opt("--lines") ?? 400) })));
}
