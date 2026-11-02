// Line anchoring: a finding quotes the code it is about (`existing_code`), and its line numbers come from
// where that code sits in the diff, not from the model's guess. The idea is open-code-review's comment
// resolver (internal/diff/resolver.go, Apache-2.0; research/ocr-design.md §5): slide the quoted lines,
// normalized, over each hunk's new side, then the old side; a quote found in one other file of the diff
// moves the finding there. Reimplemented here, no code copied.

// A unified diff as files -> hunks of {newStart, lines: [{side: "+"|"-"|" ", text, newNo, oldNo}]}.
export function parseDiff(text) {
  const files = new Map();
  let cur = null, hunk = null, newNo = 0, oldNo = 0;
  for (const raw of String(text ?? "").replace(/\r/g, "").split("\n")) {
    if (raw.startsWith("diff --git ")) { cur = null; hunk = null; continue; }
    if (raw.startsWith("+++ ")) {
      const p = raw.slice(4).replace(/^b\//, "");
      if (p !== "/dev/null") { cur = { path: p, hunks: [] }; files.set(p, cur); }
      continue;
    }
    if (raw.startsWith("--- ")) continue;
    const h = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (h && cur) { oldNo = Number(h[1]); newNo = Number(h[2]); hunk = { lines: [] }; cur.hunks.push(hunk); continue; }
    if (!hunk || !cur) continue;
    const side = raw[0];
    if (side === "+") hunk.lines.push({ side, text: raw.slice(1), newNo: newNo++ });
    else if (side === "-") hunk.lines.push({ side, text: raw.slice(1), oldNo: oldNo++ });
    else if (side === " " || raw === "") hunk.lines.push({ side: " ", text: raw.slice(1), newNo: newNo++, oldNo: oldNo++ });
  }
  return files;
}

const norm = (s) => s.trim().replace(/\s+/g, " ");
// A quote copied from the diff may keep its +/- markers: one is dropped when the line has the diff's
// marker-then-text shape ("+  x", "-x"), never from "++i" or "-=".
const quoteLines = (q) => String(q ?? "").replace(/\r/g, "").split("\n").map((l) => norm(l.replace(/^[+-](?![+\-=>])/, ""))).filter(Boolean);

// All windows: repeated code must not silently choose the first location.
function find(lines, want) {
  const ns = lines.map((l) => norm(l.text));
  const hits = [];
  for (let i = 0; i + want.length <= ns.length; i++) {
    if (!ns[i]) continue;
    let j = 0, k = i;
    while (j < want.length && k < ns.length) {
      if (!ns[k]) { k++; continue; }
      if (ns[k] !== want[j]) break;
      j++; k++;
    }
    if (j === want.length) hits.push([lines[i], lines[k - 1]]);
  }
  return hits;
}

// Where `quote` sits in one file's hunks: {line, end_line} on the new side, else the old side's numbers
// mapped to null (deleted code has no new line), else null.
function locations(file, quote) {
  const want = quoteLines(quote);
  if (!file || !want.length) return [];
  const hits = [];
  for (const h of file.hunks) {
    for (const m of find(h.lines.filter((l) => l.side !== "-"), want)) hits.push({ line: m[0].newNo, end_line: m[1].newNo });
  }
  if (hits.length) return hits;
  for (const h of file.hunks) {
    for (const m of find(h.lines.filter((l) => l.side !== "+"), want)) {
      // Deleted code: the nearest new-side line after it.
      const after = h.lines.slice(h.lines.indexOf(m[1]) + 1).find((l) => l.newNo);
      const before = [...h.lines.slice(0, h.lines.indexOf(m[0]))].reverse().find((l) => l.newNo);
      const n = after?.newNo ?? before?.newNo ?? null;
      if (n) hits.push({ line: n, end_line: n });
    }
  }
  return hits;
}
export function locate(file, quote) {
  const hits = locations(file, quote);
  return hits.length === 1 ? hits[0] : null;
}

// Anchors each finding that quotes code: its own file first, then the one other file that holds the
// quote. Findings without a quote, or whose quote is nowhere, keep their line. Returns the count moved.
export function anchor(findings, diffText) {
  const files = parseDiff(diffText);
  let n = 0;
  for (const f of findings) {
    if (!f || typeof f !== "object") continue;
    f.location_status = "unverified";
    if (!f.existing_code) continue;
    if (locations(files.get(f.file), f.existing_code).length > 1) continue;
    let at = locate(files.get(f.file), f.existing_code), file = f.file;
    if (!at) {
      const hits = [...files.values()].filter((x) => x.path !== f.file).flatMap((x) => locations(x, f.existing_code).map((a) => [x.path, a]));
      if (hits.length === 1) [file, at] = hits[0];
    }
    if (!at) continue;
    f.location_status = "anchored";
    if (at.line !== f.line || file !== f.file || (at.end_line ?? at.line) !== (f.end_line ?? f.line)) n++;
    f.file = file; f.line = at.line;
    if (at.end_line && at.end_line !== at.line) f.end_line = at.end_line; else delete f.end_line;
  }
  return n;
}
