// A council member's answer from its run's events.jsonl.
//
//   node lib/council.mjs answer <run-dir> <out-file> [min-chars]
//
// Exit 0: the answer (at least min-chars) is in out-file. 3: only a short answer, written anyway.
// 1: no text at all.
//
// The worker's last message is its final.md. A member that wrote its report and then closed with an
// offer ("Would you like me to draft revisions...?") left only the offer: 180 and 282 bytes on two Lykos
// P18 councils (2026-10-28), logged as answered while the report sat earlier in the transcript.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function memberAnswer(events, min = 1000) {
  const texts = [];
  for (const l of events.split("\n")) {
    try { const e = JSON.parse(l); if (e.type === "text" && e.part?.text?.trim()) texts.push(e.part.text.trim()); } catch {}
  }
  if (!texts.length) return { text: "", short: true };
  const last = texts.at(-1);
  if (last.length >= min) return { text: last, short: false };
  const longest = texts.reduce((a, b) => (b.length > a.length ? b : a));
  const text = longest === last ? last : `${longest}\n\n${last}`;
  return { text, short: longest.length < min };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, dir, out, min] = process.argv.slice(2);
  if (cmd !== "answer" || !dir || !out) { console.error("usage: council.mjs answer <run-dir> <out-file> [min-chars]"); process.exit(2); }
  let events = "";
  try { events = fs.readFileSync(path.join(dir, "events.jsonl"), "utf8"); } catch {}
  const { text, short } = memberAnswer(events, Number(min) || 1000);
  if (!text) process.exit(1);
  fs.writeFileSync(out, `${text}\n`);
  process.exitCode = short ? 3 : 0;
}
