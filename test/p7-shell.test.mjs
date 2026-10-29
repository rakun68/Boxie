// The delegate.sh fixes from Lykos P7 (2026-10-25): the memory check before a launch, and clean / stop
// that leave other sessions' live containers alone. The functions run in bash against a fake engine.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmp } from "./tmp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fns = (...names) => {
  const src = fs.readFileSync(path.join(ROOT, "delegate.sh"), "utf8");
  return names.map((n) => { const m = src.match(new RegExp(`^${n}\\(\\) \\{[\\s\\S]*?^\\}`, "m")); assert.ok(m, n); return m[0]; }).join("\n");
};
const bash = (script) => execFileSync("bash", ["-c", script], { encoding: "utf8" }).trim();
const G = 2 ** 30;
const unix = (p) => p.split(path.sep).join("/");

test("mem_bytes reads docker-style sizes; anything else is 0", () => {
  assert.equal(bash(`${fns("mem_bytes")}; echo $(mem_bytes 8g) $(mem_bytes 512M) $(mem_bytes 1024) $(mem_bytes 7.5g)`), `${8 * G} ${512 << 20} 1024 0`);
});

// dk info: the engine's memory; dk ps/inspect: running containers and their caps.
const memRig = (running, slots = {}) => {
  const d = tmp("ab-mem-");
  for (const [i, [owner, mem]] of Object.entries(slots)) { fs.mkdirSync(path.join(d, i)); fs.writeFileSync(path.join(d, i, "owner"), `${owner}\n`); fs.writeFileSync(path.join(d, i, "mem"), `${mem}\n`); }
  const lines = running.map(([n, m]) => `/${n} ${m}`).join("\n");
  return `${fns("mem_room")}
ENGINE=podman NS=agent-box LABEL=agent-box=1 MEM_TOTAL="" MEM_USED=0 MEM_LIMIT=0
dk() { case "$1" in info) echo ${16 * G} ;; ps) ${running.length ? "echo ids" : "true"} ;; inspect) printf '${lines}\n' ;; esac; }
D='${unix(d)}'`;
};

test("mem_room: caps of running containers plus the new one must fit in memory x MEMORY_OVERCOMMIT", () => {
  const two = memRig([["agent-box-lykos-a", 8 * G], ["agent-box-rakunloots-b", 8 * G]]);
  assert.equal(bash(`${two}; mem_room "$D" ${8 * G} && echo fits || echo waits`), "fits", "24 GiB of 24");
  assert.equal(bash(`${two}; mem_room "$D" ${9 * G} && echo fits || echo waits; echo $MEM_USED $MEM_LIMIT`), `waits\n${16 * G} ${24 * G}`);
  assert.equal(bash(`${two}; MEMORY_OVERCOMMIT=0 mem_room "$D" ${99 * G} && echo fits`), "fits");
  assert.equal(bash(`${memRig([])}; mem_room "$D" ${99 * G} && echo fits`), "fits", "one container is never refused");
});

test("mem_room: a taken slot whose container is not up yet counts; one whose container runs counts once", () => {
  const rig = memRig([["agent-box-lykos-t1", 8 * G]], { 1: ["111 t1 lykos", 8 * G], 2: ["222 t2 lykos", 8 * G] });
  assert.equal(bash(`${rig}; mem_room "$D" ${9 * G} && echo fits || echo waits; echo $MEM_USED`), `waits\n${16 * G}`);
});

// A fake engine with containers <name>|<project>|<running>; rm logs what it removed.
const cleanRig = (containers) => {
  const box = tmp("ab-clean-");
  const rows = containers.map(([n, p, r]) => `${n}|${n}|${p}|${r}`).join("\n");
  return { box, pre: `${fns("cmd_clean", "clean_run_dir", "run_over", "cname_of", "cmd_stop")}
BOX='${unix(box)}' NS=agent-box LABEL=agent-box=1 NS_LABEL=agent-box.ns=default PROJECT=""
die() { echo "die: $*"; exit 1; }
load_project() { PROJECT="$1"; }
dk() { case "$1" in
  ps) printf '${containers.map(([n]) => n).join(" ")}\n' ;;
  inspect) if [ "$2" = -f ] && [[ "$3" == *Running* ]]; then
             if [[ "$3" == *Id* ]]; then printf '${rows}\n'; else for r in $(printf '${rows}\n'); do [ "\${r%%|*}" = "$4" ] && echo "\${r##*|}"; done; fi
           else printf '${rows}\n' | grep -q "^$2|"; fi ;;
  rm) shift; [ "$1" = -f ] && shift; echo "rm $*" ;;
esac; }` };
};
const runDir = (box, project, run, files = {}) => {
  const d = path.join(box, "runs", project, run); fs.mkdirSync(d, { recursive: true });
  for (const [f, t] of Object.entries(files)) fs.writeFileSync(path.join(d, f), t);
};

test("clean keeps a live run's container and a parked one; removes stopped and orphaned ones", () => {
  const { box, pre } = cleanRig([
    ["agent-box-lykos-live", "lykos", "true"], ["agent-box-rakunloots-parked", "rakunloots", "true"],
    ["agent-box-lykos-orphan", "lykos", "true"], ["agent-box-lykos-done", "lykos", "false"], ["agent-box-lykos-gone", "lykos", "true"]]);
  runDir(box, "lykos", "live");
  runDir(box, "rakunloots", "parked", { parked: "agent-box-rakunloots-parked img 2\n", ended: "1\n" });
  runDir(box, "lykos", "orphan", { "launcher.pid": "999999\n" });
  runDir(box, "lykos", "done", { ended: "1\n" });
  // launcher.pid: a live bash process, the test's own shell.
  const out = bash(`${pre}; echo $$ >"$BOX/runs/lykos/live/launcher.pid"; cmd_clean`);
  assert.match(out, /^rm agent-box-lykos-orphan agent-box-lykos-done agent-box-lykos-gone$/m);
  assert.match(out, /kept 2 running .*agent-box-lykos-live agent-box-rakunloots-parked/);
  assert.match(bash(`${pre}; cmd_clean --all`), /^rm agent-box-lykos-live .*agent-box-lykos-gone$/m);
  assert.ok(!fs.existsSync(path.join(box, "runs", "rakunloots", "parked", "parked")), "--all drops parked markers");
});

test("stop removes the named run's container, and a loop's rounds and base suite by its name", () => {
  const { box, pre } = cleanRig([["agent-box-lykos-L-basesuite", "lykos", "true"], ["agent-box-lykos-L-fix1", "lykos", "true"], ["agent-box-lykos-other", "lykos", "true"]]);
  for (const r of ["L-basesuite", "L-fix1", "other", "Lx"]) runDir(box, "lykos", r);
  const out = bash(`${pre}; cmd_stop lykos L`);
  assert.equal(out, "agent-box: stopped L-basesuite\nagent-box: stopped L-fix1");
  assert.doesNotMatch(out, /other|Lx/);
  assert.match(bash(`${pre}; cmd_stop lykos nope`), /no container of lykos matches nope/);
});
