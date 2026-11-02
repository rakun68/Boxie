// One deduplicator for the single review pipeline and optional offline engine comparisons.
const RANK = { critical: 0, high: 1, medium: 2, low: 3 };
const STOP = new Set("the a an of to in is are be and or for on with this that it its by as at from not no when if".split(" "));
const words = (s) => new Set(String(s ?? "").toLowerCase().replace(/[^a-z0-9_ ]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)));
const overlap = (a, b) => {
  const x = words(a), y = words(b);
  let n = 0; for (const w of x) if (y.has(w)) n++;
  return n ? n / (x.size + y.size - n) : 0;
};
const normalized = (s) => String(s).toLowerCase().replace(/[^a-z0-9_]+/g, " ").trim();
export function same(a, b) {
  if (a.file !== b.file || !a.issue || !b.issue) return false;
  if (a.category && b.category && a.category !== b.category) return false;
  if (!Number.isInteger(a.line) || !Number.isInteger(b.line) || a.line < 1 || b.line < 1) return false;
  if (a.line - 3 > (b.end_line ?? b.line) || b.line - 3 > (a.end_line ?? a.line)) {
    // A repeated call-site failure can be one root cause. Require the same diagnosis and a shared
    // definition outside the reported file; nearby lines or generic wording alone are insufficient.
    return normalized(a.issue) === normalized(b.issue) && (a.evidence ?? []).some((r) => r.file !== a.file
      && (b.evidence ?? []).some((s) => s.file === r.file && s.line === r.line));
  }
  // Sharing a quoted line is not sufficient: it can contain two independent defects.
  return overlap(a.issue, b.issue) >= 0.5 || overlap(`${a.issue} ${a.scenario ?? ""}`, `${b.issue} ${b.scenario ?? ""}`) >= 0.45;
}
export function merge(lists) {
  const out = [];
  for (const { by, findings } of lists) for (const f of findings ?? []) {
    if (!f || typeof f !== "object" || Array.isArray(f)) continue;
    const twin = out.find((g) => same(g, f));
    if (!twin) { out.push({ ...f, by: [...new Set([...(f.by ?? []), by].filter(Boolean))] }); continue; }
    const provenance = [...new Set([...twin.by, ...(f.by ?? []), by].filter(Boolean))];
    const evidence = [...(twin.evidence ?? []), ...(f.evidence ?? [])];
    const locations = [...(twin.locations ?? [{ file: twin.file, line: twin.line, end_line: twin.end_line }]),
      ...(f.locations ?? [{ file: f.file, line: f.line, end_line: f.end_line }])];
    if ((RANK[f.severity] ?? 9) < (RANK[twin.severity] ?? 9)) Object.assign(twin, f);
    twin.by = provenance;
    twin.evidence = evidence.filter((r, i) => evidence.findIndex((s) => s.file === r.file && s.line === r.line) === i).slice(0, 4);
    twin.locations = locations.filter((r, i) => locations.findIndex((s) => s.file === r.file && s.line === r.line) === i);
  }
  return out.sort((a, b) => (RANK[a.severity] ?? 9) - (RANK[b.severity] ?? 9) || b.by.length - a.by.length);
}
