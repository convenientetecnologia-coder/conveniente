"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.join(__dirname, "..");
const kit = fs.readFileSync(path.join(root, "porteiro", "kit", "manutencao.ps1"), "utf8");
const life = fs.readFileSync(path.join(root, "scripts", "indexLifecycle.js"), "utf8");
const fotos = fs.readFileSync(path.join(root, "scripts", "fotos.js"), "utf8");
const index = fs.readFileSync(path.join(root, "index.js"), "utf8");
const robes = fs.readFileSync(path.join(root, "scripts", "api_robes.js"), "utf8");

let failed = 0;
function check(name, ok, extra) {
  if (ok) console.log("OK  " + name);
  else {
    failed += 1;
    console.log("FAIL " + name + (extra ? " :: " + extra : ""));
  }
}

const loopBody = kit.split("function Do-Loop")[1] || "";
const ownerBody = (kit.split("function Test-IndexHeartbeatOwner")[1] || "").split("function Stop-StalledIndex")[0];
const heartFn = (life.split("function writeHeartbeat")[1] || "").split("function noteUnexpectedDead")[0];

check("loop_no_taskkill", !/taskkill/i.test(loopBody));
check("loop_calls_guard", /Invoke-IndexStallGuard/.test(loopBody));
check("guard_before_loop", kit.indexOf("function Invoke-IndexStallGuard") > 0 && kit.indexOf("function Invoke-IndexStallGuard") < kit.indexOf("function Do-Loop"));
check("guard_confirms_twice", /\$strikes -lt 2/.test(kit));
check("guard_age_150", /\$IndexStallAgeSec = 150/.test(kit));
check("guard_boot_240", /\$IndexStallBootGraceSec = 240/.test(kit));
check("guard_cooldown_900", /\$IndexStallCooldownSec = 900/.test(kit));
check("guard_max_3", /\$IndexStallMaxKills = 3/.test(kit));
check("guard_window_6h", /\$IndexStallWindowSec = 21600/.test(kit));
check("guard_absurd_12h", /\$IndexStallAbsurdAgeSec = 43200/.test(kit));
check("guard_requires_index_main", /indexMain/.test(ownerBody));
check("guard_requires_bootts", /bootTs/.test(ownerBody));
check("guard_node_name", /ProcessName -ne 'node'/.test(ownerBody));
check("guard_boot_skew", /\$IndexStallBootSkewMs/.test(ownerBody));
check("guard_no_wmi", !/Get-CimInstance/.test(kit) && !/Get-WmiObject/.test(kit) && !/Win32_/.test(kit));
check("guard_listen_same_pid", /\$listen -eq \$IndexPid/.test(kit));
check("guard_listen_not_tree", /taskkill\.exe \/F \/PID \$listen 2>/.test(kit) && !/taskkill\.exe \/F \/PID \$listen \/T/.test(kit));
check("state_still_port", /\$up = \[bool\]\$port/.test(kit));
check("version_unchanged", /\$Version\s*=\s*'v5\.2\.1-clean-cpu'/.test(kit));
check("life_worker_skips", /if \(role !== "index"\) return;/.test(heartFn));
check("life_index_main", /indexMain: true/.test(heartFn) && /bootTs/.test(heartFn));
check("life_5s", /setInterval\(\(\) => \{ writeHeartbeat\(\); \}, 5000\)/.test(life));
check("life_light_before_heavy", heartFn.indexOf("writeJsonAtomic(HEART_PATH, body)") < heartFn.indexOf("readFleetSnap()"));
check("life_install_index_only", /if \(role === "index"\) \{\s*if \(!bootTs\) bootTs = Date\.now\(\);\s*writeHeartbeat\(\);/.test(life));
check("fotos_cache_120s", /FOTOS_INV_CACHE_MS = 120000/.test(fotos));
check("bridge_no_overlap_15s", /SERVER_EVENT_AWAIT_RELEASE_MS = 150000/.test(index) && /return \{ ok: false, skipped: true, error: 'bridge_in_flight' \}/.test(index));
check("bridge_gen_finally", /__bridgeGen === __serverEventBridgeGen/.test(index));
check("postings_visible_offset", /if \(queueTotal >= offset && slice\.length < limit\) slice\.push\(label\)/.test(robes));
check("postings_skip_empty", /if \(!label\) continue;/.test(robes.split("postings_state")[1] || ""));
const pageSrc = (robes.split("const slice = [];")[1] || "").split("const consumedTotal")[0];
const pageFn = new Function("queueRaw", "offset", "limit", "formatItem", "const slice = [];" + pageSrc + "return { slice, queueTotal };");
const sample = ["A", "", "B", "C", "D"];
const fmt = (x) => String(x || "").trim();
const page1 = pageFn(sample, 0, 2, fmt);
const page2 = pageFn(sample, 2, 2, fmt);
check("postings_page1", page1.queueTotal === 4 && page1.slice.join(",") === "A,B");
check("postings_page2", page2.queueTotal === 4 && page2.slice.join(",") === "C,D");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "idxhb-"));
const lifePath = path.join(root, "scripts", "indexLifecycle.js");
const indexChild = `
const life = require(${JSON.stringify(lifePath)});
life.install({ role: "index" });
const hb = life.readHeartbeat();
if (!hb || hb.indexMain !== true || hb.role !== "index" || !(Number(hb.bootTs) > 0) || Number(hb.pid) !== process.pid) {
  console.log("BAD " + JSON.stringify(hb));
  process.exit(2);
}
if (!(Number(hb.ts) > 0) || Math.abs(Date.now() - Number(hb.ts)) > 5000) {
  console.log("STALE " + JSON.stringify(hb));
  process.exit(4);
}
console.log("INDEX_OK");
process.exit(0);
`;
const r1 = spawnSync(process.execPath, ["-e", indexChild], {
  env: Object.assign({}, process.env, { CONVENIENTE_DADOS_DIR: tmp }),
  encoding: "utf8",
  timeout: 20000
});
check("heartbeat_index_writes", r1.status === 0 && String(r1.stdout || "").includes("INDEX_OK"), String(r1.stdout || "") + String(r1.stderr || "") + " code=" + r1.status);

const seeded = path.join(tmp, "index_heartbeat.json");
const before = fs.existsSync(seeded) ? fs.readFileSync(seeded, "utf8") : "";
const workerChild = `
const fs = require("fs");
const life = require(${JSON.stringify(lifePath)});
const before = fs.readFileSync(life.HEART_PATH, "utf8");
life.install({ role: "worker" });
const after = fs.readFileSync(life.HEART_PATH, "utf8");
if (before !== after) {
  console.log("CLOBBER");
  process.exit(3);
}
const hb = JSON.parse(after);
if (hb.role !== "index" || hb.indexMain !== true) {
  console.log("ROLE " + after);
  process.exit(5);
}
console.log("WORKER_OK");
process.exit(0);
`;
const r2 = spawnSync(process.execPath, ["-e", workerChild], {
  env: Object.assign({}, process.env, { CONVENIENTE_DADOS_DIR: tmp }),
  encoding: "utf8",
  timeout: 20000
});
check("heartbeat_worker_does_not_clobber", r2.status === 0 && String(r2.stdout || "").includes("WORKER_OK"), String(r2.stdout || "") + String(r2.stderr || "") + " code=" + r2.status);
check("heartbeat_file_kept", before && fs.readFileSync(seeded, "utf8") === before);

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}

if (failed) {
  console.log("FAILED " + failed);
  process.exit(1);
}
console.log("ALL_OK");
