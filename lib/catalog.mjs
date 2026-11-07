// The models the config names (ROLE_*, *_MODEL*) against OmniRoute's live catalog, for `doctor`.
// A model can leave the catalog while the config still names it: cx/gpt-6.1-sol-high did on
// 2026-11-07, and the contract critic and the advise role failed with HTTP 400 until someone looked.

// key -> the models it names: every token with a slash ("deepseek/deepseek-flash high" names one model,
// a CONTRACT_MODEL list names several). "${X:-default}" counts as its default. ocr: and omniroute/
// prefixes are dropped; opencode/* models are OpenCode's own, not OmniRoute's.
export function configModels(text) {
  const out = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^((?:ROLE_\w+)|(?:\w*MODEL\w*))="?([^"#]*)"?/);
    if (!m) continue;
    const v = m[2].replace(/^\$\{\w+:-(.*)\}$/, "$1").trim();
    const models = v.split(/[\s,]+/).filter((t) => t.includes("/")).map((t) => t.replace(/^ocr:/, "").replace(/^omniroute\//, ""))
      .filter((t) => !t.startsWith("opencode/"));
    if (models.length) out.set(m[1], models); else out.delete(m[1]);
  }
  return out;
}

// [{key, model}] for each named model the catalog does not list.
export function missingModels(named, catalog) {
  const have = new Set(catalog);
  const out = [];
  for (const [key, models] of named) for (const model of models) if (!have.has(model)) out.push({ key, model });
  return out;
}
