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
    workerSrc.includes("humanControl: !!(ctrl && ctrl.humanControl)") &&
    workerSrc.includes("active: !!ctrl") &&
    workerSrc.includes("humanHold: hold") &&
    workerSrc.includes("status.robeQueue = robeQueue.queueList()") &&
    workerSrc.includes("emFila = !!robeQueue.inQueue(nome)") &&
    workerSrc.includes("function __hudOwnsNome") &&
    workerSrc.includes("hasOwnProperty.call(meta, 'pauseReason')") &&
    workerSrc.includes("hasOwnProperty.call(meta, 'cooldownSec')") &&
    workerSrc.includes("paused_limit") &&
    /if \(ready\) \{\s*let overlaid = false;\s*try \{ __overlayLiveHudFields\(ready\); overlaid = true; \}/.test(workerSrc) &&
    /overlaid && Array\.isArray\(ready\.perfis\) && ready\.perfis\.length/.test(workerSrc) &&
    workerSrc.includes("overlaidOut") &&
    /overlaidOut && Array\.isArray\(out\.perfis\) && out\.perfis\.length/.test(workerSrc) &&
    /await snapshotStatusAndWrite\(\{ force: true \}\)/.test(workerSrc),
  "get-status clona jornal, recusa perfis vazio e pinta HUD da RAM (humano/hold/robe/fila)"
);
check(
  "d1_cluster_queue_by_node",
  clusterSrc.includes("const queueByNode = new Map()") &&
    clusterSrc.includes("const robesByNode = new Map()") &&
    clusterSrc.includes("queueByNode.set(i,") &&
    clusterSrc.includes("robesByNode.set(i, nodeRobes)") &&
    clusterSrc.includes("const claimedByRpc = new Set()") &&
    clusterSrc.includes("if (!isRpc && claimedByRpc.has(nome)) continue") &&
    clusterSrc.includes("const paintedNames = new Set()") &&
    clusterSrc.includes("if (!nome || paintedNames.has(nome)) continue") &&
    clusterSrc.includes("if (!painted && prevAgg &&") &&
    clusterSrc.includes("fileStore.readJsonSafe(fileStore.statusPath, null)") &&
    clusterSrc.includes("const fillUnpaintedFrom =") &&
    clusterSrc.includes("hasOwnProperty.call(dst, 'humanHold')") &&
    clusterSrc.includes("out.perfis = out.perfis.map") &&
    clusterSrc.includes("outHasHud") &&
    clusterSrc.includes("prevHasHud") &&
    clusterSrc.includes("const journalNameInNode =") &&
    clusterSrc.includes("if (!journalNameInNode(i, nome)) continue") &&
    !clusterSrc.includes("if (!isRpc && !journalNameInNode(i, nome)) continue") &&
    clusterSrc.includes("const q = queueByNode.get(i)") &&
    !/combinedQueue\.push\(\.\.\.payload\.robeQueue\)/.test(clusterSrc) &&
    !/combinedRobes = Object\.assign\(combinedRobes, payload\.robes\)/.test(clusterSrc),
  "RPC substitui robes/fila daquele node; fallback de jornal não pisa conta já pintada ao vivo"
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
    clusterSrc.includes("journal_stale_fallback") &&
    clusterSrc.includes("rpc_fail_keep_prev") &&
    clusterSrc.includes("shouldApplyNodeStatusJournal({ liveChild: true, ageMs })") &&
    clusterSrc.includes("payload.perfis.length") &&
    clusterSrc.includes("fbJson.perfis.length") &&
    clusterSrc.includes(".catch(() => ({ i, v: null }))"),
  "RPC stale 3s; jornal ≤5s fallback; jornal de minutos não pisa o HUD anterior"
);
check(
  "d1_cluster_hud_refresh_live",
  /CLUSTER_STATUS_HUD_REFRESH_MS \|\| '5000'/.test(clusterSrc) &&
    /liveChild && Number\(fb\.ageMs\) >= HUD_REFRESH_AGE_MS/.test(clusterSrc) &&
    clusterSrc.includes("journal_deferred_rpc") &&
    clusterSrc.includes("staleFallback.set(i, fb.json)") &&
    /applyPayload\(fb\.json, `journal\(\$\{ageSec\}s\)`, i, fb\.ageMs\);/.test(clusterSrc),
  "jornal fresco pinta na hora; RPC só se o arquivo passou do limiar 5s"
);

check(
  "d1_api_stale_warn_5s",
  /overlayAgeMs >= 0 && overlayAgeMs <= 5000/.test(apiStatusSrc) &&
    apiStatusSrc.includes("status_journal_stale"),
  "warning stale em 5s"
);
check(
  "d1_api_journal_first_no_rpc_wait",
  /if \(!overlayINST\) \{/.test(apiStatusSrc) &&
    /timeoutMs: 8000, fresh: true/.test(apiStatusSrc) &&
    apiStatusSrc.includes("readJsonSafe(fileStore.statusPath, null)") &&
    !/timeoutMs: 3000, fresh: true/.test(apiStatusSrc) &&
    !/setTimeout\(\(\) => resolve\(null\), 3000\)/.test(apiStatusSrc) &&
    apiStatusSrc.includes("Jornal HUD no disco: responde agora") &&
    apiStatusSrc.includes("status_handler_error") &&
    apiStatusSrc.includes("warningINST = 'status_failed'") &&
    apiStatusSrc.includes("hudLive") &&
    apiStatusSrc.includes("snapHud") &&
    apiStatusSrc.includes("if (!o || !Object.prototype.hasOwnProperty.call(o, 'humanHold')) continue") &&
    apiStatusSrc.includes("prevStock > 0 && !(nextStock > 0)") &&
    apiStatusSrc.includes("setTimeout(() => resolve(null), 7500)") &&
    apiStatusSrc.includes("__scheduleStatusJournalRefresh(workerClient)"),
  "GET pinta status.json na hora; RPC só se não há jornal HUD"
);
check(
  "d1_html_poll_1s_inflight",
  /setInterval\(reloadPerfis, 1000\)/.test(htmlSrc) &&
    !/setInterval\(reloadPerfis, 5000\)/.test(htmlSrc) &&
    htmlSrc.includes("__reloadInflight") &&
    htmlSrc.includes("await safeGetStatus()") &&
    htmlSrc.includes("stFreshUsable") &&
    htmlSrc.includes("status_failed") &&
    htmlSrc.includes("status temporarily unavailable") &&
    htmlSrc.includes("lastByNome") &&
    htmlSrc.includes("stHasHud") &&
    htmlSrc.includes("overlayHasHud") &&
    htmlSrc.includes("HUD_KEEP_KEY") &&
    htmlSrc.includes("function hudListSig") &&
    (htmlSrc.match(/window\.electronAPI\.getStatus\(/g) || []).length === 0 &&
    !htmlSrc.includes("stHasHud || !__lastStatusPaint") &&
    htmlSrc.includes("paintTopSummary(lastOverlay") &&
    !htmlSrc.includes("const catalogNow =") &&
    /finally \{\s*__reloadInflight = false;/.test(htmlSrc),
  "poll HUD 1s; F5 keep-last; um fetch abortável; lista não recria se HUD igual"
);

check(
  "d1_cluster_stock_keep",
  clusterSrc.includes("if (prevSid > 0 && !(nextSid > 0)) dst.stockAccountId = prevSid") &&
    /if \(statusAggInflight\) \{\s*return statusAggInflight;/.test(clusterSrc),
  "aggregate não apaga stockAccountId e coalese RPC em voo"
);

check(
  "d2_identity_full_status",
  indexSrc.includes("function __serverEventIdentitySig") &&
    indexSrc.includes("identityChanged") &&
    /sid: Number\(p && \(p\.stockAccountId \|\| p\.stock_account_id\)/.test(indexSrc) &&
    /needConfigPush \|\| identityChanged/.test(indexSrc) &&
    indexSrc.includes("hasHud") &&
    indexSrc.includes("statusHasHud") &&
    /hasOwnProperty.call\(p, 'humanHold'\)/.test(indexSrc),
  "CT recebe status cheio na hora se human/hold/stock mudar"
);
check(
  "d2_full_status_30s",
  /SERVER_EVENT_FULL_STATUS_MS \|\| 30000/.test(indexSrc) &&
    indexSrc.includes("includeFullStatus") &&
    indexSrc.includes("[DASHBOARD_REALTIME_OK]"),
  "cadência 30s de status cheio permanece como fallback"
);
check(
  "d2_bridge_remount_1s",
  /aggAge >= 0 && aggAge <= 1000/.test(indexSrc) &&
    /sendWorkerCommand\('get-status', \{\}, \{ timeoutMs: 4000, fresh: true \}\)/.test(indexSrc) &&
    indexSrc.includes("Promise.race([") &&
    indexSrc.includes("setTimeout(() => resolve(null), 4000)") &&
    !indexSrc.includes("http://127.0.0.1:${PORT}/api/status"),
  "ponte remonta se status.json >1s; nunca HTTP GET /api/status"
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
