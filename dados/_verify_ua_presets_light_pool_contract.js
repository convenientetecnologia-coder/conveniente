"use strict";

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const presets = require(path.join(root, "dados", "ua_presets.json"));
const policy = require(path.join(root, "dados", "ua_presets_policy.json"));
const align = require(path.join(root, "scripts", "uaPresetAlign.js"));

const workerSrc = fs.readFileSync(path.join(root, "scripts", "worker.js"), "utf8");
const clusterSrc = fs.readFileSync(path.join(root, "scripts", "clusterMaster.js"), "utf8");
const dashSrc = fs.readFileSync(path.join(root, "scripts", "dashboard.js"), "utf8");
const apiSrc = fs.readFileSync(path.join(root, "scripts", "api_perfis.js"), "utf8");
const fileStoreSrc = fs.readFileSync(path.join(root, "scripts", "fileStore.js"), "utf8");

const RETIRED = [
  "win10-chrome-127-2560x1440-029",
  "win10-chrome-127-2560x1440-030",
  "win11-chrome-128-2560x1440-028",
  "win10-chrome-132-3840x2160-020",
  "win10-chrome-137-2560x1440-010",
  "win10-chrome-138-2560x1440-009",
  "win11-chrome-138-2560x1440-008"
];
const ADDED = [
  "win10-chrome-127-1366x768-037",
  "win10-chrome-127-1440x900-038",
  "win11-chrome-128-1536x864-039",
  "win10-chrome-132-1920x1080-040",
  "win10-chrome-137-1600x900-041",
  "win10-chrome-138-1680x1050-042",
  "win11-chrome-138-1920x1080-043"
];

let fail = 0;
function check(name, cond, extra) {
  if (cond) console.log("OK", name);
  else {
    fail += 1;
    console.log("FAIL", name, extra == null ? "" : extra);
  }
}

const byId = new Map();
for (const p of presets) byId.set(String(p.id), p);

check("pool_size_36", Array.isArray(presets) && presets.length === 36, presets && presets.length);
check("ids_unique", new Set(presets.map((p) => p.id)).size === 36);

for (const id of RETIRED) {
  check("retired_absent_" + id, !byId.has(id));
  check("retired_mapped_" + id, !!(policy.retiredByPresetId && policy.retiredByPresetId[id] && policy.retiredByPresetId[id].replacedBy));
}
for (const id of ADDED) {
  check("added_present_" + id, byId.has(id));
  check("added_tier_" + id, !!(policy.tiersByPresetId && policy.tiersByPresetId[id]));
}

const heavy = presets.filter((p) => align.presetLooksHeavy(p));
check("zero_heavy_in_pool", heavy.length === 0, heavy.map((p) => p.id));

const maxW = Math.max(...presets.map((p) => Number(p.viewport && p.viewport.width) || 0));
const maxDpr = Math.max(...presets.map((p) => Number(p.dpr) || 0));
check("max_width_1920", maxW <= 1920, maxW);
check("max_dpr_medium", maxDpr <= 1.25, maxDpr);
check("medium_1920_125_kept", presets.some((p) => Number(p.viewport && p.viewport.width) === 1920 && Number(p.dpr) === 1.25));

for (const oldId of RETIRED) {
  const row = policy.retiredByPresetId[oldId];
  const neu = byId.get(row.replacedBy);
  check("sibling_ua_" + oldId, !!(neu && row.uaString && neu.uaString === row.uaString), neu && neu.uaString);
  check("sibling_vp_" + oldId, !!(neu && neu.viewport && neu.viewport.width === row.toViewport.width && neu.viewport.height === row.toViewport.height && Number(neu.dpr) === Number(row.toViewport.dpr)));
  const idMajorMatch = String(neu && neu.id || "").match(/chrome-(\d+)/i);
  const majorId = Number(idMajorMatch && idMajorMatch[1] || 0);
  const uaMajorMatch = String(neu && neu.uaString || "").match(/Chrome\/(\d+)/);
  const majorUa = Number(uaMajorMatch && uaMajorMatch[1] || 0);
  check("sibling_major_" + oldId, majorId > 0 && majorId === majorUa, [majorId, majorUa]);
}

check("policy_version_4", Number(policy.version) === 4);
check("policy_retired_7", Object.keys(policy.retiredByPresetId || {}).length === 7);

const lightById = new Map([["win11-chrome-139-1920x1080-001", { id: "win11-chrome-139-1920x1080-001" }]]);
check("need_missing_id", align.needsRealign({ uaPresetId: "win10-chrome-132-3840x2160-020", fp: { viewport: { width: 1366, height: 768 }, dpr: 1 } }, lightById).yes === true);
check("need_heavy_fp", align.needsRealign({ uaPresetId: "win11-chrome-139-1920x1080-001", fp: { viewport: { width: 2560, height: 1440 }, dpr: 1.5 } }, lightById).yes === true);
check("keep_medium", align.needsRealign({ uaPresetId: "win11-chrome-139-1920x1080-001", fp: { viewport: { width: 1920, height: 1200 }, dpr: 1.25 } }, lightById).yes === false);
check("keep_light", align.needsRealign({ uaPresetId: "win11-chrome-139-1920x1080-001", fp: { viewport: { width: 1366, height: 768 }, dpr: 1 } }, lightById).yes === false);
check("heavy_4k", align.fpLooksHeavy({ viewport: { width: 3840, height: 2160 }, dpr: 2 }) === true);
check("not_heavy_1920_125", align.fpLooksHeavy({ viewport: { width: 1920, height: 1200 }, dpr: 1.25 }) === false);

check("worker_require", workerSrc.includes("require('./uaPresetAlign.js')"));
check("worker_activate_hook", workerSrc.includes("ua_preset_realign_on_activate") && workerSrc.includes("source: 'activateOnce'"));
check("worker_blocks_fat_open", workerSrc.includes("ua_preset_realign_failed"));
check("worker_handler", workerSrc.includes("async ['ua-presets-realign']"));
check("cluster_broadcast", clusterSrc.includes("type === 'ua-presets-realign'"));
check("api_route", apiSrc.includes("/api/ua-presets/realign"));
check("dash_command", dashSrc.includes("ua_presets_realign") && dashSrc.includes("execUaPresetsRealign"));
check("fileStore_exports_policy", fileStoreSrc.includes("presetsPolicyPath"));
check("align_keeps_ua", fs.readFileSync(path.join(root, "scripts", "uaPresetAlign.js"), "utf8").includes("Não mexe em uaString/uaCh"));
check("no_invented_chrome_140", !presets.some((p) => /Chrome\/14[0-9]/.test(String(p.uaString || ""))));

if (fail) {
  console.error("FAIL_COUNT", fail);
  process.exit(1);
}
console.log("ALL_OK_UA_PRESETS_LIGHT_POOL_CONTRACT");
process.exit(0);
