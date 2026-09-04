"use strict";

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const workerSrc = fs.readFileSync(path.join(root, "scripts", "worker.js"), "utf8");
const faxinaSrc = fs.readFileSync(path.join(root, "scripts", "chromeHeapFaxina.js"), "utf8");
const hygieneSrc = fs.readFileSync(path.join(root, "scripts", "robeTabHygiene.js"), "utf8");

let fail = 0;
function check(name, cond, extra) {
  if (cond) console.log("OK", name);
  else {
    fail += 1;
    console.log("FAIL", name, extra == null ? "" : extra);
  }
}

check("annihilate_logs_error_field", /event:\s*'chrome_sick_annihilate'[\s\S]{0,220}error:\s*errTxt/.test(workerSrc));
check("annihilate_logs_via_field", /event:\s*'chrome_sick_annihilate'[\s\S]{0,180}via:\s*viaTxt/.test(workerSrc));
check("create_annihilate_passes_error", /annihilateChromeSick\(nome,\s*'robe_open_create'[\s\S]{0,120}error:\s*\(res && res\.error\)/.test(workerSrc));
check("create_throw_passes_via", /annihilateChromeSick\(nome,\s*'robe_open_create_throw'[\s\S]{0,80}via:\s*src/.test(workerSrc));
check("faxina_audit_event", /event:\s*'faxina_cdp'/.test(workerSrc) && /function faxinaAposCicloPesado/.test(workerSrc));
check("faxina_audit_skips_cooldown", /if \(r && r\.skipped\) return r;/.test(workerSrc));
check("faxina_still_console_ok", workerSrc.includes("logFaxinaOk"));
check("tab_prune_audit", /event:\s*'tab_prune'/.test(workerSrc) && /function closeExtraPages/.test(workerSrc));
check("ws_shrink_audit", /event:\s*'ws_shrink'/.test(workerSrc) && /function auditWsShrink/.test(workerSrc));
check("ws_shrink_skips_gates", /if \(!out \|\| out\.skipped === true\) return;/.test(workerSrc));
check("cure_attempt_logs_error", /event:\s*'chrome_cure_attempt'[\s\S]{0,600}error:\s*\(result && result\.error\)/.test(workerSrc));
check("crash_isolate_passes_error", /annihilateChromeSick\(nome,\s*'page_crash_isolate',\s*\{\s*error:\s*msg\s*\}/.test(workerSrc));
check("pre_start_passes_cure_error", /annihilateChromeSick\(nome,\s*'robe_pre_start'[\s\S]{0,180}error:\s*\(cure && cure\.error\)/.test(workerSrc));
check("nurse_timeout_passes_error", /annihilateChromeSick\(nome,\s*'nurse\.pages_timeout',\s*\{\s*error:/.test(workerSrc));
check("gc_still_ephemeral", faxinaSrc.includes("createCDPSession") && faxinaSrc.includes("HeapProfiler.collectGarbage"));
check("hygiene_still_detaches", hygieneSrc.includes("detachEphemeralCdp") && hygieneSrc.includes("detachCdpWhenSettled"));
check("auto_enqueue_exists", workerSrc.includes("function robeEnqueueAuto") && workerSrc.includes("robeQueuedCycle"));
check("play_is_separate_handler", workerSrc.includes("async ['robe-play']") && workerSrc.includes("startRobeDynamic"));
check("play_does_not_gain_annihilate", !/async \['robe-play'\][\s\S]{0,12000}annihilateChromeSick\(nome,\s*'robe_open_create'/.test(workerSrc));
check("arm_default_on", /ROBE_EVENT_ARM == null \? '1'/.test(workerSrc));
check("global_tick_default_off", /DELTA_ALLOW_ROBE_GLOBAL_TICK \|\| '0'/.test(workerSrc));
check("allow_robe_default_on", /DELTA_ALLOW_ROBE \|\| '1'/.test(workerSrc));

if (fail) {
  console.error("FAIL_COUNT", fail);
  process.exit(1);
}
console.log("ALL_OK_CDP_AUDIT_CONTRACT");
process.exit(0);
