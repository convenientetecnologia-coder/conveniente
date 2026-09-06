"use strict";

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
let failed = 0;
function check(name, ok, extra) {
  if (ok) console.log("OK  " + name);
  else {
    failed += 1;
    console.log("FAIL " + name + (extra ? " :: " + extra : ""));
  }
}
function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

const ps1 = read("scripts/crashHammer.ps1");
const js = read("scripts/crashHammer.js");
const cluster = read("scripts/clusterMaster.js");
const life = read("scripts/indexLifecycle.js");
const worker = read("scripts/worker.js");
const dash = read("scripts/dashboard.js");
const kit = read("porteiro/kit/manutencao.ps1");
const tune = read("scripts/winTuningMaster.ps1");
const iniciar = read("scripts/iniciarSistema.ps1");
const contrato = read("porteiro/CONTRATO.txt");
const gitignore = read(".gitignore");
const loopBody = (kit.split("function Do-Loop")[1] || "").split("function ")[0];

check("ps1_exists", fs.existsSync(path.join(root, "scripts", "crashHammer.ps1")));
check("js_exists", fs.existsSync(path.join(root, "scripts", "crashHammer.js")));
check("ps1_no_cpu", !/Get-CpuAvg/.test(ps1) && !/Win32_Processor/.test(ps1));
check("ps1_commit", /commitPct/.test(ps1) && /Win32_OperatingSystem/.test(ps1));
check("ps1_event_1000", /Id = 1000/.test(ps1) && /Fault Module|module/.test(ps1));
check("ps1_event_1001", /Id = 1001/.test(ps1));
check("ps1_exhaust", /Id = 2004/.test(ps1) && /resource_exhaustion/.test(ps1));
check("ps1_no_kill", !/taskkill/i.test(ps1) && !/Stop-Process/.test(ps1));
check("ps1_writes_jsonl", /crash_hammer\.jsonl/.test(ps1) && /crash_hammer_last\.json/.test(ps1));
check("ps1_verdict", /house/.test(ps1) && /furniture/.test(ps1) && /utensil/.test(ps1));
check("js_debounce_2s", /DEBOUNCE_MS = 2000/.test(js));
check("js_no_delay_respawn", /execFile\(/.test(js) && !/execFileSync\(PS, args/.test(js));
check("cluster_hooks_drop", /scheduleWorkerDrop/.test(cluster) && /proc\.on\('exit'/.test(cluster));
check("life_hooks_index", /scheduleIndex\("index_unexpected_dead"\)/.test(life));
check("worker_commit_snap", /commitPct/.test(worker) && /readOsMemCached/.test(worker));
check("dash_allowlist", /crash_hammer:/.test(dash) && /crash_hammer_last:/.test(dash));
check("kit_version_intact", /v5\.2\.1-clean-cpu/.test(kit) && !/function Get-CpuAvg/.test(kit) && !/Win32_Processor/.test(kit));
check("kit_loop_no_taskkill", !/taskkill/i.test(loopBody));
check("kit_hammer_outside", /Invoke-CrashHammer/.test(kit) && /Ensure-NodeCrashDumps/.test(kit));
check("tune_localdumps", /function Set-NodeLocalDumps/.test(tune) && /node_localdumps/.test(tune));
check("iniciar_excludes_ps1", /crashHammer\\.ps1/.test(iniciar));
check("contrato_martelo", /MARTELO DA QUEDA/.test(contrato));
check("gitignore_dumps", /dados\/crash_dumps\//.test(gitignore));

if (failed) {
  console.log("FAILED " + failed);
  process.exit(1);
}
console.log("ALL_OK");
