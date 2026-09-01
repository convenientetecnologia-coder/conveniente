"use strict";

const { EventEmitter } = require("events");
const fs = require("fs");
const path = require("path");

const shrink = require("../scripts/chromeWorkingSetShrink.js");

let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log("OK", name);
  } else {
    fail += 1;
    console.log("FAIL", name, extra == null ? "" : extra);
  }
}

function mockSpawnOk(calls) {
  return (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const ee = new EventEmitter();
    ee.kill = () => {};
    setImmediate(() => ee.emit("close", 0, null));
    return ee;
  };
}

function decodeSpawnScript(call) {
  const args = (call && call.args) || [];
  const i = args.indexOf("-EncodedCommand");
  if (i < 0) return "";
  return Buffer.from(String(args[i + 1] || ""), "base64").toString("utf16le");
}

const root = path.join(__dirname, "..");
const shrinkSrc = fs.readFileSync(path.join(root, "scripts", "chromeWorkingSetShrink.js"), "utf8");
const workerSrc = fs.readFileSync(path.join(root, "scripts", "worker.js"), "utf8");
const deltaSrc = fs.readFileSync(path.join(root, "scripts", "virtusDelta.js"), "utf8");
const pkg = fs.readFileSync(path.join(root, "package.json"), "utf8");

check("src_module_exists", fs.existsSync(path.join(root, "scripts", "chromeWorkingSetShrink.js")));
check("src_no_koffi_mod", !/require\s*\(\s*['\"]koffi['\"]\s*\)/.test(shrinkSrc) && !/\bkoffi\s*\./.test(shrinkSrc));
check("src_no_koffi_pkg", !/koffi|ffi-napi|node-ffi|ref-napi/.test(pkg));
check("src_no_execfilesync", !/\bexecFileSync\s*\(/.test(shrinkSrc));
check("src_no_spawnsync", !/\bspawnSync\s*\(/.test(shrinkSrc));
check("src_spawn_async", shrinkSrc.includes('require("child_process")') && /spawnFn/.test(shrinkSrc));
check("src_emptyworkingset", shrinkSrc.includes("EmptyWorkingSet"));
check("src_openprocess", shrinkSrc.includes("OpenProcess"));
check("src_no_getprocessbyid", !/GetProcessById/.test(shrinkSrc));
check("src_no_taskkill", !/\btaskkill\b/i.test(shrinkSrc) && !/\bbrowser\.close\s*\(/.test(shrinkSrc) && !/\bpage\.close\s*\(/.test(shrinkSrc));
check("src_boot_settle_30s", shrink.BOOT_SETTLE_MS === 30_000, shrink.BOOT_SETTLE_MS);
check("src_timeout_12s", shrink.TIMEOUT_MS === 12_000, shrink.TIMEOUT_MS);
check("src_lane_acquire_8s", shrink.LANE_ACQUIRE_MS === 8000, shrink.LANE_ACQUIRE_MS);

check("src_worker_require", workerSrc.includes("chromeWorkingSetShrink"));
check("src_worker_tag", workerSrc.includes("2026-09-01_ws_shrink_chrome_tree_v2"));
check("src_worker_no_ews_inline", !/EmptyWorkingSet/.test(workerSrc));
check("src_worker_no_execfilesync", !/execFileSync/.test(workerSrc));
check("src_worker_no_broken_oneliner", !/\[psapi\]::EmptyWorkingSet/.test(workerSrc));
check("src_worker_boot_hook", workerSrc.includes("onMessagesBootStableShrink") && workerSrc.includes("shrinkRootPidAfterMessagesBoot"));
check("src_worker_lane_kind", workerSrc.includes("ws_shrink_boot"));
check("src_worker_dedup_pid", workerSrc.includes("wsShrinkBootPid"));
check("src_delta_and_gate", deltaSrc.includes("bootStableOk === true && earReadyOk === true") && deltaSrc.includes("onMessagesBootStableShrink"));
check("src_tree_max_64", shrink.TREE_MAX_PIDS === 64, shrink.TREE_MAX_PIDS);
check("src_tree_ppid", shrinkSrc.includes("ParentProcessId") && shrinkSrc.includes("Win32_Process"));
check("src_tree_chrome_only", shrinkSrc.includes("chrome.exe") && shrinkSrc.includes("chromium.exe"));
check("src_no_tracing", !/collectChromePidsViaTracing/.test(shrinkSrc) && !/\bTracing\b/.test(shrinkSrc));
check("src_no_stopprocess", !/Stop-Process/.test(shrinkSrc));
check("src_forbid_list", typeof shrink.forbiddenPidList === "function" && shrink.forbiddenPidList().includes(process.pid));
check("src_delta_no_cdp", !deltaSrc.includes("createCDPSession") && !deltaSrc.includes("deltaCdpSession"));
check("src_delta_captures_stable", deltaSrc.includes('waitForMessagesBootStable(page, "messages_ready_worker")') && deltaSrc.includes("bootStableOk"));
check("src_kick_not_await_faxina", workerSrc.includes("kickFaxinaAndMaybeResumeVirtus") && !/await faxinaAposCicloPesado\(nome, ctrl && ctrl\.mainPage, 'robe_cycle'\)/.test(workerSrc));

const robeShrinkBeforeKick = (workerSrc.match(/await shrinkRootPidAfterRobe\(nome, ctrl\);[\s\S]{0,160}kickFaxinaAndMaybeResumeVirtus/g) || []).length;
check("src_robe_shrink_before_kick", robeShrinkBeforeKick >= 4, robeShrinkBeforeKick);

check("parse_pid_int", shrink.parseRootPid(4242) === 4242);
check("parse_pid_str", shrink.parseRootPid("4242") === 4242);
check("parse_pid_zero", shrink.parseRootPid(0) === 0);
check("parse_pid_neg", shrink.parseRootPid(-1) === 0);
check("parse_pid_inject", shrink.parseRootPid("1234; taskkill") === 0);
check("parse_pid_float", shrink.parseRootPid(12.5) === 0);
check("parse_pid_empty", shrink.parseRootPid("") === 0);
check("src_forbidden_pid", shrinkSrc.includes("forbidden_pid"));

{
  const ps = shrink.buildPsCommand(4242);
  check("ps_has_ews", ps.includes("EmptyWorkingSet"));
  check("ps_has_openprocess", ps.includes("OpenProcess"));
  check("ps_has_root", /\$root = 4242\b/.test(ps), ps.slice(0, 280));
  check("ps_openprocess_eid", /OpenProcess\([^\n]*, \$false, \$eid\)/.test(ps), ps.slice(-220));
  check("ps_tree_walk", /ParentProcessId/.test(ps) && /HashSet\[int\]/.test(ps));
  check("ps_chrome_name_guard", /ProcessName -ne 'chrome'/.test(ps) && /ProcessName -ne 'chromium'/.test(ps));
  check("ps_chrome_wmi_filter", /Name = 'chrome\.exe'/.test(ps) && /Name = 'chromium\.exe'/.test(ps));
  check("ps_forbid", /\$forbid = @\(/.test(ps));
  check("ps_no_autovar_pid", !/foreach \(\$pid\b/.test(ps) && !/\$pid\s*=/.test(ps));
  check("ps_no_getbyid", !/GetProcessById/.test(ps));
  check("ps_no_taskkill", !/taskkill/.test(ps));
  check("ps_no_stopprocess", !/Stop-Process/.test(ps));
  check("ps_reject_bad", shrink.buildPsCommand("1;exit") === "");
}

{
  const p1 = shrink.bootPredicatesMet({
    bootStableOk: true,
    earReadyOk: false,
    page: {},
    pid: 4242
  });
  check("pred_ear_false", !!(p1 && p1.ok === false && p1.reason === "ear_not_ready"), p1);

  const p2 = shrink.bootPredicatesMet({
    bootStableOk: false,
    earReadyOk: true,
    page: {},
    pid: 4242
  });
  check("pred_stable_false", !!(p2 && p2.ok === false && p2.reason === "boot_not_stable"), p2);

  const p3 = shrink.bootPredicatesMet({
    bootStableOk: true,
    earReadyOk: true,
    page: { __deltaBootInterlock: { active: true, released: false } },
    pid: 4242
  });
  check("pred_interlock_held", !!(p3 && p3.ok === false && p3.reason === "interlock_held"), p3);

  const p4 = shrink.bootPredicatesMet({
    bootStableOk: true,
    earReadyOk: true,
    page: {},
    pid: 4242,
    alreadyShrunkPid: 4242
  });
  check("pred_dedup_pid", !!(p4 && p4.ok === false && p4.reason === "already_shrunk_pid"), p4);

  const p5 = shrink.bootPredicatesMet({
    bootStableOk: true,
    earReadyOk: true,
    page: {},
    pid: 4242
  });
  check("pred_and_ok", !!(p5 && p5.ok === true && p5.pid === 4242), p5);
}

(async () => {
  const page = { isClosed: () => false };
  const browser = {
    isConnected: () => true,
    process: () => ({ pid: 4242 })
  };

  {
    const calls = [];
    const out = await shrink.shrinkBootGate({
      nome: "conta_teste",
      page,
      browser,
      rootPid: 4242,
      bootStableOk: true,
      earReadyOk: false,
      settleMs: 0,
      isEarReady: () => true,
      spawnFn: mockSpawnOk(calls)
    });
    check("boot_skip_ear", !!(out && out.skipped === true && out.reason === "ear_not_ready"), out);
    check("boot_skip_ear_no_spawn", calls.length === 0, calls.length);
  }

  {
    const calls = [];
    const out = await shrink.shrinkBootGate({
      nome: "conta_teste",
      page,
      browser,
      rootPid: 4242,
      bootStableOk: false,
      earReadyOk: true,
      settleMs: 0,
      isEarReady: () => true,
      spawnFn: mockSpawnOk(calls)
    });
    check("boot_skip_dom", !!(out && out.skipped === true && out.reason === "boot_not_stable"), out);
    check("boot_skip_dom_no_spawn", calls.length === 0, calls.length);
  }

  {
    const calls = [];
    const logs = [];
    const orig = console.log;
    console.log = (line) => { logs.push(String(line)); };
    let out = null;
    try {
      out = await shrink.shrinkBootGate({
        nome: "conta_teste",
        page,
        browser,
        rootPid: 4242,
        bootStableOk: true,
        earReadyOk: true,
        settleMs: 0,
        isEarReady: () => true,
        spawnFn: mockSpawnOk(calls)
      });
    } finally {
      console.log = orig;
    }
    check("boot_ok", !!(out && out.ok === true && out.pid === 4242), out);
    check("boot_spawn_once", calls.length === 1, calls.length);
    check("boot_spawn_ps", calls[0] && calls[0].cmd === "powershell.exe", calls[0] && calls[0].cmd);
    check("boot_windows_hide", !!(calls[0] && calls[0].opts && calls[0].opts.windowsHide === true));
    const script = decodeSpawnScript(calls[0]);
    check("boot_encoded_ews", script.includes("EmptyWorkingSet"), script.slice(0, 120));
    check("boot_encoded_root", /\$root = 4242\b/.test(script), script.slice(0, 200));
    check("boot_encoded_tree", /ParentProcessId/.test(script) && /\$eid/.test(script));
    check("boot_log", logs.some((l) => l.includes("[OXY-LOG] [SHRINK-BOOT]") && l.includes("conta_teste")), logs);
  }

  {
    const calls = [];
    const busy = { isClosed: () => false, __virtusDeltaReplyInFlight: true };
    const out = await shrink.shrinkBootGate({
      nome: "conta_teste",
      page: busy,
      browser,
      rootPid: 4242,
      bootStableOk: true,
      earReadyOk: true,
      settleMs: 0,
      isEarReady: () => true,
      spawnFn: mockSpawnOk(calls)
    });
    check("boot_skip_inflight", !!(out && out.skipped === true && out.reason === "page_busy"), out);
    check("boot_skip_inflight_no_spawn", calls.length === 0, calls.length);
  }

  {
    const calls = [];
    let abort = false;
    const out = await shrink.shrinkBootGate({
      nome: "conta_teste",
      page,
      browser,
      rootPid: 4242,
      bootStableOk: true,
      earReadyOk: true,
      settleMs: 40,
      sleepFn: async () => { abort = true; },
      shouldAbortSettle: () => abort,
      isEarReady: () => true,
      spawnFn: mockSpawnOk(calls)
    });
    check("boot_abort_settle_robe", !!(out && out.skipped === true && out.reason === "abort_settle"), out);
    check("boot_abort_no_spawn", calls.length === 0, calls.length);
  }

  {
    const calls = [];
    const out = await shrink.shrinkBootGate({
      nome: "conta_teste",
      page,
      browser,
      rootPid: 4242,
      alreadyShrunkPid: 4242,
      bootStableOk: true,
      earReadyOk: true,
      settleMs: 0,
      isEarReady: () => true,
      spawnFn: mockSpawnOk(calls)
    });
    check("boot_skip_restart_same_pid", !!(out && out.skipped === true && out.reason === "already_shrunk_pid"), out);
    check("boot_skip_restart_no_spawn", calls.length === 0, calls.length);
  }

  {
    const calls = [];
    const logs = [];
    const orig = console.log;
    console.log = (line) => { logs.push(String(line)); };
    let out = null;
    try {
      out = await shrink.shrinkRobeGate({
        nome: "conta_teste",
        page,
        browser,
        rootPid: 4242,
        spawnFn: mockSpawnOk(calls)
      });
    } finally {
      console.log = orig;
    }
    check("robe_ok", !!(out && out.ok === true && out.gate === "robe"), out);
    check("robe_spawn_once", calls.length === 1, calls.length);
    check("robe_log", logs.some((l) => l === "[OXY-LOG] [SHRINK-ROBE] Aba 1 descartada. Pó de postagem limpo no Chrome da conta (raiz+filhos)."), logs);
  }

  {
    const calls = [];
    const out = await shrink.shrinkRobeGate({
      nome: "conta_teste",
      page: { __virtusDeltaReplyInFlight: true, isClosed: () => false },
      browser,
      rootPid: 4242,
      spawnFn: mockSpawnOk(calls)
    });
    check("robe_skip_inflight", !!(out && out.skipped === true && out.reason === "page_busy"), out);
    check("robe_skip_inflight_no_spawn", calls.length === 0, calls.length);
  }

  {
    const out = await shrink.emptyWorkingSetPid(4242, {
      timeoutMs: 800,
      spawnFn: () => {
        const ee = new EventEmitter();
        ee.kill = () => {
          ee.killed = true;
          setImmediate(() => ee.emit("close", null, "SIGTERM"));
        };
        return ee;
      }
    });
    check("timeout_kills_ps_only", !!(out && out.ok === false && out.error === "exe_timeout" && out.killed === true), out);
  }

  {
    let held = false;
    let released = false;
    const calls = [];
    const out = await shrink.shrinkBootGate({
      nome: "conta_teste",
      page,
      browser,
      rootPid: 4242,
      bootStableOk: true,
      earReadyOk: true,
      settleMs: 0,
      isEarReady: () => true,
      spawnFn: mockSpawnOk(calls),
      holdLane: async (fn) => {
        held = true;
        try { return await fn(); } finally { released = true; }
      }
    });
    check("lane_held_then_released", !!(out && out.ok && held && released), { held, released, out });
  }

  {
    const calls = [];
    const out = await shrink.emptyWorkingSetPid(process.pid, { spawnFn: mockSpawnOk(calls) });
    check("refuse_self_pid", !!(out && out.skipped === true && out.reason === "forbidden_pid") && calls.length === 0, out);
  }

  if (fail) {
    console.error("FAIL_COUNT", fail);
    process.exit(1);
  }
  console.log("ALL_OK");
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
