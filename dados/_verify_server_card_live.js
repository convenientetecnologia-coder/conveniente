"use strict";

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const indexJs = fs.readFileSync(path.join(root, "index.js"), "utf8");
const clusterJs = fs.readFileSync(path.join(root, "scripts", "clusterMaster.js"), "utf8");
const allowJs = fs.readFileSync(path.join(root, "scripts", "logsAllowlist.js"), "utf8");
const ctIndex = fs.readFileSync(path.join("C:", "sitechatbot", "index.js"), "utf8");
const ctHtml = fs.readFileSync(path.join("C:", "sitechatbot", "public", "index.html"), "utf8");

let failed = 0;
function check(name, ok, extra) {
  if (ok) console.log("OK  " + name);
  else {
    failed += 1;
    console.log("FAIL " + name + (extra ? " :: " + extra : ""));
  }
}

check(
  "bridge_reads_journal_not_http_api_status",
  indexJs.includes("__readFreshStatusJson") &&
    indexJs.includes("__readFreshStatusJson(60000)") &&
    !indexJs.includes("http://127.0.0.1:${PORT}/api/status") &&
    !/__readLocalStatusForEventBridge[\s\S]{0,800}sendWorkerCommand\('get-status'/.test(indexJs)
);
check(
  "bridge_full_status_not_on_every_count_delta",
  indexJs.includes("includeFullStatus") &&
    indexJs.includes("__serverEventLastFullStatusAt") &&
    /includeFullStatus \? \{ status \}/.test(indexJs)
);
check(
  "bridge_watchdog_releases_hung_tick",
  indexJs.includes("bridge_tick_watchdog_release") &&
    indexJs.includes("SERVER_EVENT_TICK_MAX_MS")
);
check(
  "bridge_count_change_forces_delta",
  indexJs.includes("countsChanged") &&
    indexJs.includes("shouldSendDelta = forceStatusEvent || countsChanged")
);
check(
  "quick_carries_source_ts",
  indexJs.includes("sourceTs: Number(status && status.ts)") &&
    indexJs.includes("source: 'api_status'")
);
check(
  "cluster_aggregates_live_topology_only",
  clusterJs.includes("for (let i = 0; i < children.length; i++) considerIdx.push(i)") &&
    clusterJs.includes("uniqIdx") &&
    clusterJs.includes("liveChild") &&
    !/readdirSync\(dadosDir\)/.test(clusterJs)
);
check(
  "cluster_ignores_stale_orphan_journals",
  clusterJs.includes("shouldApplyNodeStatusJournal") &&
    clusterJs.includes("stale_ignored(") &&
    /if \(fb\.ageMs > MAX_FILE_AGE_MS\) \{\s*if \(liveChild\)/.test(clusterJs)
);
check(
  "allowlist_has_server_event_bridge",
  allowJs.includes("server_event_bridge:")
);
check(
  "ct_presence_not_counts_on_command_bus",
  ctIndex.includes("ACK de atendimento nao pode fingir") &&
    ctIndex.includes("lastCountsAt") &&
    ctIndex.includes("resolveHostCountsTs") &&
    ctIndex.includes("resolveHostPresenceTs")
);
check(
  "ct_ui_marks_stale_live_as_atrasado",
  ctHtml.includes("atrasado") && ctHtml.includes("countsAgeSec")
);

if (failed) {
  console.log("FAILED " + failed);
  process.exit(1);
}
console.log("ALL_OK");
