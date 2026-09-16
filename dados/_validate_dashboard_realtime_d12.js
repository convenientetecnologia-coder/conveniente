"use strict";
/**
 * Validação ponta a ponta Lote D1 (HUD MAE) + D2 (Config/estoque CT).
 * Determinística. Sem Chrome. Falha o processo se o contrato quebrar.
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const workerSrc = fs.readFileSync(path.join(ROOT, "scripts", "worker.js"), "utf8");
const clusterSrc = fs.readFileSync(path.join(ROOT, "scripts", "clusterMaster.js"), "utf8");
const apiStatusSrc = fs.readFileSync(path.join(ROOT, "scripts", "api_status.js"), "utf8");
const htmlSrc = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
const indexSrc = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
const cfgPushSrc = fs.readFileSync(path.join(ROOT, "scripts", "serverConfigCtPush.js"), "utf8");

const cluster = require(path.join(ROOT, "scripts", "clusterMaster.js"));
const cfgPush = require(path.join(ROOT, "scripts", "serverConfigCtPush.js"));

let failed = 0;
function pass(id, msg) {
  console.log("PASS  " + id + "  " + msg);
}
function fail(id, msg) {
  failed += 1;
  console.log("FAIL  " + id + "  " + msg);
}
function check(id, ok, msg) {
  if (ok) pass(id, msg);
  else fail(id, msg);
}

check(
  "d1_worker_min_idle",
  /STATUS_JOURNAL_MIN_MS \|\| '250'/.test(workerSrc) &&
    /STATUS_JOURNAL_IDLE_MS \|\| '1000'/.test(workerSrc) &&
    /Math\.max\(250,/.test(workerSrc),
  "worker MIN=250 IDLE=1000 com piso 250"
);
check(
  "d1_worker_idle_timer",
  /Math\.min\(4000, STATUS_JOURNAL_IDLE_MS\)/.test(workerSrc),
  "timer ocioso segue IDLE (1s), não 4s fixo"
);
check(
  "d1_worker_stamp",
  workerSrc.includes("[DASHBOARD_REALTIME_OK]"),
  "stamp DASHBOARD_REALTIME_OK no worker"
);
check(
  "d1_worker_hud_overlay",
  workerSrc.includes("function __overlayLiveHudFields") &&
    workerSrc.includes("__overlayLiveHudFields(ready)") &&
    /humanControl: !!ctrl\.humanControl/.test(workerSrc),
  "get-status clona jornal e pinta humanControl da RAM"
);
check(
  "d1_worker_force_snapshot",
  workerSrc.includes("snapshotStatusAndWrite({ force: true })") &&
    /const force = !!\(opts && opts\.force === true\)/.test(workerSrc) &&
    workerSrc.includes("ctrl.humanControl = true") &&
    /humanControl = true;\s*try \{ await snapshotStatusAndWrite\(\{ force: true \}\)/.test(workerSrc) &&
    /humanControl = false;\s*try \{ await snapshotStatusAndWrite\(\{ force: true \}\)/.test(workerSrc),
  "Invocar/Retomar forçam jornal na hora (bypass MIN)"
);

check(
  "d1_cluster_max_age_5s",
  clusterSrc.includes("CLUSTER_STATUS_FILE_MAX_AGE_MS || '5000'") &&
    typeof cluster.shouldApplyNodeStatusJournal === "function" &&
    cluster.shouldApplyNodeStatusJournal({ liveChild: true, ageMs: 4000 }) === true &&
    cluster.shouldApplyNodeStatusJournal({ liveChild: true, ageMs: 120000 }) === false &&
    cluster.shouldApplyNodeStatusJournal({ liveChild: false, ageMs: 120000 }) === false,
  "jornal ≤5s pinta; minutos não contaminam"
);
check(
  "d1_cluster_cache_250",
  /CLUSTER_STATUS_CACHE_MS \|\| '250'/.test(clusterSrc),
  "cache do agregado 250ms"
);
check(
  "d1_cluster_rpc_stale_3s",
  /CLUSTER_STATUS_RPC_STALE_MS \|\| '3000'/.test(clusterSrc) &&
    clusterSrc.includes("journal_stale_fallback"),
  "RPC stale 3s + fallback de jornal"
);
check(
  "d1_cluster_hud_refresh_250",
  /CLUSTER_STATUS_HUD_REFRESH_MS \|\| '250'/.test(clusterSrc) &&
    /liveChild && Number\(fb\.ageMs\) > HUD_REFRESH_AGE_MS/.test(clusterSrc),
  "cell viva com jornal >250ms pinta disco e pede RAM"
);

check(
  "d1_api_stale_warn_5s",
  /overlayAgeMs >= 0 && overlayAgeMs <= 5000/.test(apiStatusSrc) &&
    apiStatusSrc.includes("status_journal_stale"),
  "warning stale em 5s"
);
check(
  "d1_api_await_merge_250",
  /overlayAgeMs >= 0 && overlayAgeMs <= 250/.test(apiStatusSrc) &&
    /timeoutMs: 3000/.test(apiStatusSrc) &&
    /if \(!overlayINST\) \{/.test(apiStatusSrc) &&
    /timeoutMs: 8000/.test(apiStatusSrc),
  "GET pinta arquivo; >250ms espera get-status 3s; sem arquivo 8s"
);
check(
  "d1_html_poll_1s_inflight",
  /setInterval\(reloadPerfis, 1000\)/.test(htmlSrc) &&
    !/setInterval\(reloadPerfis, 5000\)/.test(htmlSrc) &&
    htmlSrc.includes("__reloadInflight") &&
    /finally \{\s*__reloadInflight = false;/.test(htmlSrc),
  "poll HUD 1s com trava inflight"
);

check(
  "d2_full_status_30s",
  /SERVER_EVENT_FULL_STATUS_MS \|\| 30000/.test(indexSrc) &&
    indexSrc.includes("includeFullStatus") &&
    indexSrc.includes("[DASHBOARD_REALTIME_OK]"),
  "ponte manda status cheio (stockAccountId) a cada 30s"
);
check(
  "d2_bridge_remount_5s",
  /aggAge >= 0 && aggAge <= 5000/.test(indexSrc) &&
    /sendWorkerCommand\('get-status', \{\}, \{ timeoutMs: 4000 \}\)/.test(indexSrc) &&
    !indexSrc.includes("http://127.0.0.1:${PORT}/api/status"),
  "ponte remonta se status.json >5s; nunca HTTP GET /api/status"
);
check(
  "d2_config_mirror_30s",
  /SERVER_EVENT_CONFIG_MIRROR_MS \|\| 30000/.test(cfgPushSrc) &&
    Number(cfgPush.CONFIG_MIRROR_INTERVAL_MS) === 30000 &&
    cfgPushSrc.includes("interval_30s") &&
    typeof cfgPush.shouldPushConfig === "function",
  "espelho Config remanda a cada 30s"
);

check(
  "no_robe_virtus_in_this_contract",
  !/require\('\.\/robe\.js'\)/.test(apiStatusSrc) &&
    workerSrc.includes("__overlayLiveHudFields") &&
    !apiStatusSrc.includes("virtusDelta"),
  "contrato HUD não mexe regra comercial Robe/Virtus"
);

if (failed) {
  console.log("FAILED " + failed);
  process.exit(1);
}
console.log("ALL_OK");
process.exit(0);
