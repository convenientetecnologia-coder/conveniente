"use strict";

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const api = fs.readFileSync(path.join(root, "scripts", "api_status.js"), "utf8");
const inlineScripts = [...html.matchAll(/<script(?:[^>]*)>([\s\S]*?)<\/script>/gi)]
  .map((m) => String(m[1] || ""))
  .filter((code) => code.trim().length > 0);

let failed = 0;
function check(name, ok, extra) {
  if (ok) {
    console.log("OK  " + name);
  } else {
    failed += 1;
    console.log("FAIL " + name + (extra ? " :: " + extra : ""));
  }
}

check("html_fetch_timeout", /function fetchJsonTimeout/.test(html) && /fetchJsonTimeout\('\/api\/status', 8000\)/.test(html) && /fetchJsonTimeout\('\/api\/perfis', 8000\)/.test(html));
check("html_network_rotation_timeout", (html.match(/fetchJsonTimeout\('\/api\/network-rotation\/state', 8000\)/g) || []).length >= 2);
check("html_keep_last_paint", /__lastStatusPaint/.test(html) && /__lastPerfisPaint/.test(html) && /__reloadInflight/.test(html));
check("html_inflight_finally", /finally \{\s*__reloadInflight = false;/.test(html));
check("html_no_zero_without_cache", /if \(!st && !perfisResp\) \{ __reloadInflight = false; return; \}/.test(html));
check("html_top_summary_early_paint", /function paintTopSummary/.test(html) && /paintTopSummary\(earlyPerfis, earlyRobeQueue\)/.test(html) && /console\.error\('\[reloadPerfis\] fail'/.test(html));
check("html_inline_script_parses", (() => {
  try {
    inlineScripts.forEach((code) => new Function(code));
    return inlineScripts.length > 0;
  } catch {
    return false;
  }
})());
check("html_status_only_merge", /const overlayPerfis = Array\.isArray\(st\?\.perfis\)/.test(html) && /const perfisSeed = basePerfis\.length/.test(html) && /if \(!dst\) \{\s*dst = makePerfilEntry\(/.test(html));
check("api_journal_before_rpc", /getStatusSnapshot\(\)/.test(api) && /status_journal_stale/.test(api) && /dashboard pintado em zero/.test(api));
check("api_status_rpc_short", /timeoutMs: 8000/.test(api));
check("api_stale_journal_fallback_only_after_rpc", /let staleSnapINST = null;/.test(api) && /overlayINST = await workerClient\.sendWorkerCommand\('get-status', \{\}, \{ timeoutMs: 8000 \}\);/.test(api) && /overlayINST = staleSnapINST;/.test(api));
check("api_status_seed_from_status", /baseline_seeded_from_status/.test(api) && /if \(!baseMap\.size && overlayINST/.test(api));
const apiPerfis = fs.readFileSync(path.join(root, "scripts", "api_perfis.js"), "utf8");
const postCfg = apiPerfis.split("app.post('/api/server-config'")[1] || "";
check("config_save_returns_before_sidecar", /sidecarQueued/.test(postCfg) && /setImmediate/.test(postCfg) && postCfg.indexOf("res.json") < postCfg.indexOf("tryWarmupV2();"));
check("api_perfis_status_snapshot_fallback", /getStatusSnapshot/.test(apiPerfis) && /fallback: fallback\.length > 0 \? 'status_snapshot' : 'empty'/.test(apiPerfis));
const htmlGet = html.split("async function getServerConfig")[1] || "";
check("html_config_timeout", /fetchJsonTimeout\('\/api\/server-config'/.test(htmlGet));

if (failed) {
  console.log("FAILED " + failed);
  process.exit(1);
}
console.log("ALL_OK");
