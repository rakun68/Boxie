// The review filter: one model call scores every merged finding of an advise review against the diff,
// and findings under REVIEW_FILTER_MIN are dropped (kept in filtered.json). Generate-then-verify is what
// the stronger reviewers do (research/review-tools-survey.md, "Precision"): open-code-review's review
// filter removes only what the diff proves wrong, PR-Agent's reflection scores 0-10. This combines the
// two in Boxie's words: a score, with "the diff proves it wrong" as the only way to 0-2.
//
// A failed call keeps every finding: the filter may only remove, never block a review.
const SYSTEM = `You check code review comments before they reach the author. You see the diff and the comments.
The reviewers read more of the repository than you see, so a comment about code outside the diff is not
wrong for that reason alone.

Score each comment 0-10:
- 0-2: the diff proves it wrong. The code it describes is not in the diff it names, or a line of the diff
  contradicts its central claim (it says a value is unused and the diff uses it), or it is about code this
  change did not add or touch, or it only asks to "verify", "ensure" or "consider" with no concrete problem.
- 3-5: plausible but unproven: it depends on behaviour the diff does not show.
- 6-8: the diff supports it: the problem follows from the lines shown.
- 9-10: certain and it matters: a defect a maintainer would block on.
A real misspelling, inconsistent key or name, dead code or duplicated logic in the changed lines is a
valid comment: score it 6 or more. Never score below 3 a comment about concurrency, memory safety,
security or a behaviour change unless a diff line proves it wrong. Two comments about the same problem in
the same file: score the weaker one 0 and say which it duplicates.

Answer with only a JSON array, one object per comment, analysis before score:
[{"id": 1, "analysis": "<one or two sentences>", "score": 7}]`;

export function filterPrompt(findings, diff) {
  const items = findings.map((f, i) => ({ id: i + 1, file: f.file, line: f.line, severity: f.severity, issue: f.issue,
    scenario: String(f.scenario ?? "").slice(0, 600), existing_code: String(f.existing_code ?? "").slice(0, 400) }));
  return `## Diff\n\n\`\`\`\`diff\n${String(diff).slice(0, 120000)}\n\`\`\`\`\n\n## Comments\n\n${JSON.stringify(items, null, 1)}`;
}

export function parseScores(text) {
  const t = String(text ?? "");
  const m = t.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/) ?? t.match(/(\[[\s\S]*\])/);
  try {
    const v = JSON.parse(m ? m[1] : t);
    if (!Array.isArray(v)) return null;
    const out = {};
    for (const x of v) if (Number.isFinite(Number(x?.id)) && Number.isFinite(Number(x?.score))) out[Number(x.id)] = { score: Number(x.score), why: String(x.analysis ?? "") };
    return out;
  } catch { return null; }
}

// {kept, dropped, error}: each kept finding carries filter_score.
export async function filter(findings, diff, { model, base, key, min = 3, fetchImpl = fetch } = {}) {
  if (!findings.length) return { kept: findings, dropped: [], error: null };
  try {
    const r = await fetchImpl(`${base}/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: filterPrompt(findings, diff) }] }),
      signal: AbortSignal.timeout(280000) });
    const j = await r.json();
    const scores = parseScores(j.choices?.[0]?.message?.content);
    if (!r.ok || !scores) return { kept: findings, dropped: [], error: `filter: ${r.status} ${j.error?.message ?? "no readable scores"}`.slice(0, 300) };
    const kept = [], dropped = [];
    findings.forEach((f, i) => {
      const s = scores[i + 1];
      if (!s) { kept.push(f); return; }
      (s.score < min ? dropped : kept).push({ ...f, filter_score: s.score, ...(s.score < min ? { filter_why: s.why } : {}) });
    });
    return { kept, dropped, error: null };
  } catch (e) { return { kept: findings, dropped: [], error: `filter: ${e.message}`.slice(0, 300) }; }
}
