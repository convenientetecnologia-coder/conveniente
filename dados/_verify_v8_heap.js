"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.join(__dirname, "..");
const guardPath = path.join(root, "scripts", "v8HeapGuard.js");
const guard = require(guardPath);

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

const indexJs = read("index.js");
const workerJs = read("scripts/worker.js");
const cluster = read("scripts/clusterMaster.js");
const host = read("scripts/convenienteNodeHost.ps1");
const iniciar = read("scripts/iniciarSistema.ps1");
const workerClient = read("scripts/workerClient.js");
const bootstrap = read("scripts/bootstrapService.js");
const virtus = read("scripts/virtusDelta.js");
const robe = read("scripts/robe.js");

check("guard_module", fs.existsSync(guardPath) && guard.FLAG === "--max-old-space-size=8192" && guard.WANT_MB === 8192 && guard.MIN_HEAP_GB === 7);
check("guard_stamps", /V8_HEAP_TUNED_OK/.test(read("scripts/v8HeapGuard.js")) && /ERRO_FATAL_INFRA/.test(read("scripts/v8HeapGuard.js")) && /multi_engine\.log/.test(read("scripts/v8HeapGuard.js")));
check("index_guard_first", indexJs.indexOf("require('./scripts/v8HeapGuard.js').assertEnterpriseHeap()") < indexJs.indexOf("require('express')"));
check("worker_guard_first", workerJs.indexOf("require('./v8HeapGuard.js').assertEnterpriseHeap()") < workerJs.indexOf("require('path')"));
check("host_cli_8192", /--max-old-space-size=8192/.test(host) && /cmd\.exe \/c/.test(host));
check("host_flag_before_index", /`"\$node`" --max-old-space-size=8192 `"\$idx`"/.test(host));
check("cluster_spawn_args", /v8HeapGuard\.spawnArgs\(\[entry\]\)/.test(cluster));
check("worker_client_execargv", /execArgv:\s*require\('\.\/v8HeapGuard\.js'\)\.execArgv\(\)/.test(workerClient));
check("iniciar_points_host", /max-old-space-size=8192/.test(iniciar) && /Start-ConvenienteNodeHost/.test(iniciar));
check("bootstrap_cli", (bootstrap.match(/--max-old-space-size=8192/g) || []).length >= 3);
check("no_robe_touch", !/assertEnterpriseHeap/.test(robe) && !/max-old-space-size/.test(robe));
check("no_virtus_touch", !/assertEnterpriseHeap/.test(virtus) && !/max-old-space-size/.test(virtus));
check("spawn_args_shape", JSON.stringify(guard.spawnArgs(["cellEntry.js"])) === JSON.stringify(["--max-old-space-size=8192", "cellEntry.js"]));
check("execargv_shape", JSON.stringify(guard.execArgv()) === JSON.stringify(["--max-old-space-size=8192"]));

const node = process.execPath;
const deny = spawnSync(node, ["-e", "require('C:/conveniente/scripts/v8HeapGuard.js').assertEnterpriseHeap(); console.log('LEAK')"], { encoding: "utf8" });
check(
  "guard_rejects_factory_heap",
  deny.status === 1 && /ERRO_FATAL_INFRA/.test(String(deny.stderr || deny.stdout || "")) && !/LEAK/.test(String(deny.stdout || "")),
  "status=" + deny.status + " out=" + String(deny.stdout || "").slice(0, 120) + " err=" + String(deny.stderr || "").slice(0, 180)
);

const allow = spawnSync(node, ["--max-old-space-size=8192", "-e", "require('C:/conveniente/scripts/v8HeapGuard.js').assertEnterpriseHeap(); console.log('HEAP_OK '+require('C:/conveniente/scripts/v8HeapGuard.js').heapLimitGB().toFixed(3))"], { encoding: "utf8" });
const heapOkLine = String(allow.stdout || "");
const gb = Number((heapOkLine.match(/HEAP_OK ([0-9.]+)/) || [])[1] || 0);
check(
  "guard_accepts_8192",
  allow.status === 0 && /HEAP_OK/.test(heapOkLine) && gb >= 7,
  "status=" + allow.status + " out=" + heapOkLine.slice(0, 160) + " err=" + String(allow.stderr || "").slice(0, 120)
);

if (failed) {
  console.log("FAILED " + failed);
  process.exit(1);
}
console.log("ALL_OK");
