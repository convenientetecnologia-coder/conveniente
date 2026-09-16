"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
const apiStatus = fs.readFileSync(path.join(ROOT, "scripts", "api_status.js"), "utf8");
const apiPerfis = fs.readFileSync(path.join(ROOT, "scripts", "api_perfis.js"), "utf8");
const cluster = fs.readFileSync(path.join(ROOT, "scripts", "clusterMaster.js"), "utf8");
const indexJs = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
const fileStore = require(path.join(ROOT, "scripts", "fileStore.js"));

assert.match(html, /paintTopSummary\(lastOverlay/);
assert.doesNotMatch(html, /const catalogNow =/);
assert.match(html, /await Promise\.all\(\[statusP, netP\]\)/);
assert.match(html, /fetchJsonTimeout\('\/api\/cells', 4000\)/);
assert.match(html, /updateSysMetrics\(\);/);
assert.match(html, /setInterval\(reloadPerfis, 1000\)/);
assert.doesNotMatch(html, /setInterval\(reloadPerfis, 5000\)/);

assert.match(apiStatus, /function __scheduleStatusJournalRefresh/);
assert.match(apiStatus, /overlayINST = snap;/);
assert.match(apiStatus, /warningINST === 'status_journal_stale'/);
const statusGet = apiStatus.split("app.get('/api/status'")[1] || "";
assert.ok(
  statusGet.indexOf("overlayINST = snap;") >= 0 &&
    statusGet.indexOf("overlayINST = snap;") < statusGet.indexOf("__scheduleStatusJournalRefresh(workerClient)"),
  "jornal stale pinta antes do refresh em fundo"
);

assert.match(apiPerfis, /clearBootStartClosedOnOpen\(desired, op\)/);
const flagged = { _bootStartClosed: true };
fileStore.clearBootStartClosedOnOpen(flagged, "ui_open_all");
assert.strictEqual(flagged._bootStartClosed, false);

assert.match(cluster, /for \(let i = 0; i < children\.length; i\+\+\) considerIdx\.push\(i\)/);
assert.doesNotMatch(cluster, /readdirSync\(dadosDir\)/);
assert.match(cluster, /else if \(liveChild\) \{\s*missingIdx\.push\(i\);/);
assert.match(cluster, /CLUSTER_STATUS_FILE_MAX_AGE_MS \|\| '5000'/);
assert.match(cluster, /CLUSTER_STATUS_HUD_REFRESH_MS \|\| '0'/);
assert.match(cluster, /journal_stale_fallback/);
assert.ok(cluster.includes("missingIdx.push(i)"), "stale vivo ou jornal ausente dispara RPC");
assert.match(cluster, /if \(statusAggInflight\) \{\s*return statusAggInflight;/);
assert.doesNotMatch(apiStatus, /overlayAgeMs >= 0 && overlayAgeMs <= 250/);
assert.match(apiStatus, /timeoutMs: 3000, fresh: true/);
assert.match(apiStatus, /setTimeout\(\(\) => resolve\(null\), 3000\)/);
assert.match(apiStatus, /prevStock > 0 && !\(nextStock > 0\)/);

assert.match(indexJs, /sendWorkerCommand\('get-status', \{\}, \{ timeoutMs: 4000, fresh: true \}\)/);
assert.match(indexJs, /aggAge >= 0 && aggAge <= 1000/);
assert.doesNotMatch(indexJs, /http:\/\/127\.0\.0\.1:\$\{PORT\}\/api\/status/);
assert.match(indexJs, /includeFullStatus/);
assert.match(indexJs, /__serverEventLastFullStatusAt/);
assert.match(indexJs, /controller\.abort\(\), 15000\)/);

console.log("ALL_OK");
