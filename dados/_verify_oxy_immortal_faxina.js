"use strict";

const { EventEmitter } = require("events");
const faxina = require("../scripts/chromeHeapFaxina.js");
const life = require("../scripts/indexLifecycle.js");

let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log("OK", name);
  } else {
    fail += 1;
    console.log("FAIL", name, extra || "");
  }
}

function srcHasPrimaryClientDetach(src) {
  return /_client\s*\(\s*\)\s*\.detach\s*\(/.test(src)
    || /page\._client\s*\(\s*\)[\s\S]{0,80}\.detach\s*\(/.test(src);
}

function glassCreateDetachPaired(src) {
  const creates = (src.match(/createCDPSession\s*\(/g) || []).length;
  const detaches = (src.match(/\.detach\s*\(\s*\)/g) || []).length;
  return creates === 5 && detaches === 5;
}

faxina._resetForTests();

// 1) Puppeteer 24: _client é método
{
  const sent = [];
  const page = {
    _client() {
      return { send: async (m) => { sent.push(m); } };
    },
    isClosed() { return false; }
  };
  const r = faxina.resolveCdpClient(page);
  check("cdp_via_client_fn", !!(r && r.via === "page._client()"));
}

  // 2) GC prefere sessão efêmera (não jama o _client primário)
(async () => {
  faxina._resetForTests();
  const sent = [];
  let detached = 0;
  let primaryUsed = 0;
  const page = {
    _client() {
      primaryUsed += 1;
      return { send: async () => { throw new Error("primary_should_not_run"); } };
    },
    async createCDPSession() {
      return {
        send: async (m) => { sent.push(m); return { ok: true }; },
        detach: async () => { detached += 1; }
      };
    },
    isClosed() { return false; }
  };
  const out = await faxina.collectPageGarbage(page, { nome: "conta_teste", reason: "unit" });
  check("gc_ok", !!(out && out.ok === true), out);
  check("gc_via_ephemeral", !!(out && out.via === "createCDPSession"), out);
  check("gc_method", sent[0] === "HeapProfiler.collectGarbage", sent);
  check("gc_detached", detached === 1, detached);
  check("gc_skips_primary_client", primaryUsed === 0, primaryUsed);
})().then(async () => {
  // 3) sequencial: segunda espera a primeira
  faxina._resetForTests();
  let current = 0;
  let maxOverlap = 0;
  const mk = (nome) => ({
    nome,
    page: {
      _client() {
        return {
          send: async () => {
            current += 1;
            maxOverlap = Math.max(maxOverlap, current);
            await new Promise((r) => setTimeout(r, 40));
            current -= 1;
          }
        };
      },
      isClosed() { return false; }
    }
  });
  const a = mk("a");
  const b = mk("b");
  await Promise.all([
    faxina.collectPageGarbage(a.page, { nome: a.nome, reason: "seq" }),
    faxina.collectPageGarbage(b.page, { nome: b.nome, reason: "seq" })
  ]);
  check("gc_serial_no_overlap", maxOverlap === 1, { maxOverlap });

  // 4) cooldown não dispara segundo GC na mesma conta
  faxina._resetForTests();
  let n = 0;
  const page = {
    _client() { return { send: async () => { n += 1; } }; },
    isClosed() { return false; }
  };
  const first = await faxina.collectPageGarbage(page, { nome: "cool", reason: "c1" });
  const second = await faxina.collectPageGarbage(page, { nome: "cool", reason: "c2" });
  check("cooldown_first_ok", !!(first && first.ok));
  check("cooldown_second_skip", !!(second && second.skipped && second.reason === "cooldown"), second);
  check("cooldown_send_once", n === 1, n);

  // 5) skip se reply em voo — não engessa o Delta
  faxina._resetForTests();
  const busy = {
    __virtusDeltaReplyInFlight: true,
    _client() { return { send: async () => { throw new Error("should_not_gc"); } }; },
    isClosed() { return false; }
  };
  const busyOut = await faxina.collectPageGarbage(busy, { nome: "busy", reason: "reply" });
  check("skip_reply_inflight", !!(busyOut && busyOut.skipped), busyOut);

  // 6) sanitize NUNCA wipeia sem nome de evento
  const ee = new EventEmitter();
  ee.on("keep", () => {});
  ee.on("wipe", () => {});
  ee.on("wipe", () => {});
  faxina.sanitizeListenCycle(ee, ["wipe", "", null]);
  check("sanitize_keeps_other", ee.listenerCount("keep") === 1);
  check("sanitize_wipes_named", ee.listenerCount("wipe") === 0);

  // 7) MaxListeners sobe, não zera (0 = Infinity)
  const ee2 = new EventEmitter();
  faxina.elevateMaxListeners(ee2, 32);
  check("max_listeners_32", ee2.getMaxListeners() === 32);
  ee2.setMaxListeners(0);
  faxina.elevateMaxListeners(ee2, 32);
  check("max_listeners_respects_unlimited", ee2.getMaxListeners() === 0);

  // 8) SIGHUP/SIGBREAK NÃO chamam process.exit
  const origExit = process.exit;
  let exitCode = null;
  process.exit = (code) => { exitCode = code; };
  try {
    const r1 = life.handleConsoleSessionSignal("SIGHUP");
    const r2 = life.handleConsoleSessionSignal("SIGBREAK");
    check("sighup_keep_alive", !!(r1 && r1.keptAlive === true && r1.exited === false));
    check("sigbreak_keep_alive", !!(r2 && r2.keptAlive === true && r2.exited === false));
    check("no_process_exit", exitCode === null, exitCode);
    check("is_session_sighup", life.isConsoleSessionSignal("SIGHUP") === true);
    check("is_session_sigint_false", life.isConsoleSessionSignal("SIGINT") === false);
  } finally {
    process.exit = origExit;
  }

  // 9) error sink impede EventEmitter sem listener (não mata processo)
  const pageEe = new EventEmitter();
  pageEe.isClosed = () => false;
  faxina.attachErrorSink(pageEe);
  pageEe.emit("error", new Error("tab_crash_sim"));
  check("error_sink_marks_crash", pageEe.__oxyCrashed === true);
  check("error_sink_idempotent", faxina.attachErrorSink(pageEe) === false);

  // 10) timeout destacha sessão efêmera — não deixa handle órfão
  faxina._resetForTests();
  {
    let detached = 0;
    const hangPage = {
      async createCDPSession() {
        return {
          send: () => new Promise(() => {}),
          detach: async () => { detached += 1; }
        };
      },
      isClosed() { return false; }
    };
    const t0 = Date.now();
    const hangOut = await faxina.collectPageGarbage(hangPage, { nome: "hang", reason: "timeout" });
    check("gc_timeout_ok_false", !!(hangOut && hangOut.ok === false && /timeout/.test(String(hangOut.error || ""))), hangOut);
    check("gc_timeout_detached", detached === 1, detached);
    check("gc_timeout_bounded", (Date.now() - t0) < 9000, Date.now() - t0);
  }

  // 11) fallback _client() quando não há createCDPSession (mock / page velha)
  faxina._resetForTests();
  {
    const sent = [];
    const legacy = {
      _client() { return { send: async (m) => { sent.push(m); } }; },
      isClosed() { return false; }
    };
    const legacyOut = await faxina.collectPageGarbage(legacy, { nome: "legacy", reason: "fallback" });
    check("gc_fallback_client", !!(legacyOut && legacyOut.ok && sent[0] === "HeapProfiler.collectGarbage"), legacyOut);
  }

  // 12) matriz de recuperação de crash — Puppeteer NÃO marca isClosed no Inspector.targetCrashed
  {
    const p = faxina.shouldRecoverCrashedPage;
    check("crash_main_open", p({ isMain: true, alreadyClosed: false, browserConnected: true }) === "annihilate");
    check("crash_main_closed_browser_up", p({ isMain: true, alreadyClosed: true, browserConnected: true }) === "annihilate");
    check("crash_main_browser_dead", p({ isMain: true, alreadyClosed: true, browserConnected: false }) === "none");
    check("crash_extra_open", p({ isMain: false, alreadyClosed: false, browserConnected: true }) === "close_tab");
    check("crash_extra_closed", p({ isMain: false, alreadyClosed: true, browserConnected: true }) === "none");
    check("crash_msg_true", faxina.isPuppeteerPageCrash(new Error("Page crashed!")) === true);
    check("crash_msg_false", faxina.isPuppeteerPageCrash(new Error("net::ERR_ABORTED")) === false);
  }

  // 13) createCDPSession que chega DEPOIS do timeout ainda é destachado
  faxina._resetForTests();
  {
    let detached = 0;
    let finishOpen = null;
    const latePage = {
      createCDPSession() {
        return new Promise((resolve) => {
          finishOpen = () => resolve({
            send: async () => {},
            detach: async () => { detached += 1; }
          });
        });
      },
      isClosed() { return false; }
    };
    const lateOut = await faxina.collectPageGarbage(latePage, { nome: "lateopen", reason: "t" });
    check("late_open_timeout", !!(lateOut && /timeout/.test(String(lateOut.error || ""))), lateOut);
    check("late_open_not_yet", detached === 0, detached);
    if (typeof finishOpen === "function") finishOpen();
    await new Promise((r) => setTimeout(r, 40));
    check("late_open_detached", detached === 1, detached);
  }

  // 14) Promise.race vencedor NÃO deixa unhandledRejection do timer perdedor
  {
    let leftover = 0;
    const onUR = () => { leftover += 1; };
    process.on("unhandledRejection", onUR);
    try {
      faxina._resetForTests();
      const clean = {
        async createCDPSession() {
          return { send: async () => {}, detach: async () => {} };
        },
        isClosed() { return false; }
      };
      await faxina.collectPageGarbage(clean, { nome: "norace", reason: "x" });
      await new Promise((r) => setTimeout(r, 80));
      check("no_race_unhandled", leftover === 0, leftover);
    } finally {
      process.removeListener("unhandledRejection", onUR);
    }
  }

  // 15) listener real de SIGHUP via install() não chama process.exit
  {
    const origExit = process.exit;
    let exitCode = null;
    process.exit = (code) => { exitCode = code; };
    try {
      life.install({ role: "test" });
      process.emit("SIGHUP");
      process.emit("SIGBREAK");
      check("install_sighup_no_exit", exitCode === null, exitCode);
    } finally {
      process.exit = origExit;
    }
  }

  // 13) contrato de fonte — regressão estrutural
  {
    const fs = require("fs");
    const path = require("path");
    const root = path.join(__dirname, "..");
    const lifeSrc = fs.readFileSync(path.join(root, "scripts", "indexLifecycle.js"), "utf8");
    const faxinaSrc = fs.readFileSync(path.join(root, "scripts", "chromeHeapFaxina.js"), "utf8");
    const workerSrc = fs.readFileSync(path.join(root, "scripts", "worker.js"), "utf8");
    const deltaSrc = fs.readFileSync(path.join(root, "scripts", "virtusDelta.js"), "utf8");
    const indexSrc = fs.readFileSync(path.join(root, "index.js"), "utf8");
    const browserSrc = fs.readFileSync(path.join(root, "scripts", "browser.js"), "utf8");
    const robeSrc = fs.readFileSync(path.join(root, "scripts", "robeTabHygiene.js"), "utf8");
    const pulseSrc = fs.readFileSync(path.join(root, "scripts", "winHandlePulse.js"), "utf8");
    const glassSrc = fs.readFileSync(path.join(root, "scripts", "glassViewer.js"), "utf8");
    check("src_life_no_process_exit", !/process\.exit\s*\(/.test(lifeSrc));
    check("src_life_shield_log", lifeSrc.includes("[OXY-LOG] [SIGHUP-SHIELD]"));
    check("src_faxina_cmd", faxinaSrc.includes("HeapProfiler.collectGarbage"));
    check("src_faxina_ephemeral", faxinaSrc.includes("createCDPSession"));
    check("src_faxina_no_bare_wipe", !/removeAllListeners\s*\(\s*\)/.test(faxinaSrc));
    check("src_worker_no_bare_wipe", !/removeAllListeners\s*\(\s*\)/.test(workerSrc));
    check("src_worker_faxina_robe", workerSrc.includes("robe_cycle") && workerSrc.includes("robe_play"));
    check("src_delta_faxina_hooks", deltaSrc.includes("delta_reply") && deltaSrc.includes("delta_greeting") && deltaSrc.includes("delta_force_collect"));
    check("src_delta_greeting_always_faxina", deltaSrc.includes('faxinaAposCicloPesado("delta_greeting")') && !deltaSrc.includes('out && out.city_status) || "") === "collecting"'));
    check("src_index_sigint_intact", /process\.on\(\s*'SIGINT'/.test(indexSrc) && /process\.exit\(0\)/.test(indexSrc));
    check("src_isolate_uses_policy", workerSrc.includes("shouldRecoverCrashedPage"));
    check("src_isolate_filters_crash_msg", workerSrc.includes("isPuppeteerPageCrash"));
    check("src_deadline_cleared", faxinaSrc.includes("makeDeadlineTimer") && faxinaSrc.includes("openT.clear"));
    check("src_kick_not_await_robe", workerSrc.includes("kickFaxinaAndMaybeResumeVirtus") && !/await faxinaAposCicloPesado\(nome, ctrl && ctrl\.mainPage, 'robe_cycle'\)/.test(workerSrc));
    check("src_hold_before_emexecucao", workerSrc.includes("armOxyFaxinaHold") && workerSrc.includes("ignoreTrabalhando"));
    check("src_hold_is_flag_not_just_ttl", workerSrc.includes("oxyFaxinaHold = true") && workerSrc.includes("OXY_FAXINA_HOLD_WATCHDOG_MS"));
    check("src_start_work_respects_hold", workerSrc.includes("start_work skip (robe/faxina hold)"));
    check("src_ensure_hold_wired", workerSrc.includes("isFaxinaHold: isOxyFaxinaHold"));
    check("src_unified_boot_respects_hold", workerSrc.includes("skipped_robe_or_faxina_hold"));
    check("src_kick_no_double_virtus", workerSrc.includes("if (!live.virtus)") && workerSrc.includes("kickFaxinaAndMaybeResumeVirtus"));
    check("src_kick_abandons_dead_ctrl", /function kickFaxinaAndMaybeResumeVirtus[\s\S]{0,1800}controllers\.get\(nome\)/.test(workerSrc));
    check("src_ephemeral_helper", faxinaSrc.includes("withEphemeralCdpSession") && faxinaSrc.includes("async function detachCdpSession"));
    check("src_helper_never_uses_client", /async function withEphemeralCdpSession[\s\S]{0,500}_client\s*\(/.test(faxinaSrc) === false);
    check("src_browser_no_raw_cdp_session", !browserSrc.includes("createCDPSession"));
    check("src_browser_uses_ephemeral", (browserSrc.match(/withEphemeralCdpSession/g) || []).length >= 4);
    check("src_browser_ua_ch_no_silent_skip", browserSrc.includes("patchPage_ua_ch_no_cdp"));
    check("src_robe_detach_helper", robeSrc.includes("detachEphemeralCdp") && robeSrc.includes("detachCdpWhenSettled"));
    check("src_robe_extra_targets_finally", /function closeExtraPageTargets[\s\S]{0,4500}finally \{\s*await detachEphemeralCdp\(session\)/.test(robeSrc));
    check("src_robe_junk_finally", /function closeJunkCdpTargets[\s\S]{0,3500}finally \{\s*await detachEphemeralCdp\(session\)/.test(robeSrc));
    check("src_robe_stoploading_finally", /stopLoading[\s\S]{0,900}finally \{\s*await detachEphemeralCdp\(stopClient\)/.test(robeSrc));
    check("src_worker_tag_standby", workerSrc.includes("2026-08-31_ws_shrink_nativo_v1"));
    check("src_trace_finally_detach", /function collectChromePidsViaTracing[\s\S]{0,5000}finally \{\s*try \{ await chromeHeapFaxina\.detachCdpSession\(session\)/.test(workerSrc));
    check("src_ear_fail_orphan_detach", workerSrc.includes("detachCdpSession(cdp)"));
    check("src_ear_detach_sites", (workerSrc.match(/__deltaDetachCdpSession/g) || []).length === 6);
    check("src_delta_module_has_no_cdp_session", !deltaSrc.includes("createCDPSession") && !deltaSrc.includes("deltaCdpSession"));
    check("src_life_installs_pulse", lifeSrc.includes("winHandlePulse.js"));
    check("src_pulse_log", pulseSrc.includes("[OXY-LOG] [HANDLES]") && pulseSrc.includes("handle_pulse"));
    check("src_pulse_no_powershell", !/powershell\.exe/i.test(pulseSrc) && pulseSrc.includes("WMIC"));
    check("src_pulse_no_kill_chrome", !/taskkill|browser\.close/i.test(pulseSrc));
    check("src_no_primary_client_detach", !srcHasPrimaryClientDetach(workerSrc) && !srcHasPrimaryClientDetach(browserSrc) && !srcHasPrimaryClientDetach(robeSrc) && !srcHasPrimaryClientDetach(faxinaSrc));
    check("src_glass_all_sessions_detach", glassCreateDetachPaired(glassSrc));
    check("src_sweep_module", fs.existsSync(path.join(root, "scripts", "chromeMemorySweep.js")));
    check("src_sweep_standbylist", fs.readFileSync(path.join(root, "scripts", "chromeMemorySweep.js"), "utf8").includes("/StandbyList"));
    check("src_sweep_no_os_metrics", !/require\(\s*['\"]os['\"]\s*\)/.test(fs.readFileSync(path.join(root, "scripts", "chromeMemorySweep.js"), "utf8")));
    check("src_sweep_handlers", workerSrc.includes("standby-sweep-probe") && workerSrc.includes("standby-sweep-arm") && workerSrc.includes("standby-sweep-release"));
    check("src_sweep_master", fs.readFileSync(path.join(root, "scripts", "clusterMaster.js"), "utf8").includes("attachHostCoordinator"));
    check("src_ws_shrink_module", fs.existsSync(path.join(root, "scripts", "chromeWorkingSetShrink.js")));
    check("src_ws_shrink_logs", workerSrc.includes("shrinkRootPidAfterMessagesBoot") && workerSrc.includes("shrinkRootPidAfterRobe"));
    check("src_ws_shrink_delta_and", deltaSrc.includes("bootStableOk === true && earReadyOk === true"));
  }

  // 17) sessão EXTRA: detach no sucesso e no throw; pulso de handles não mata Chrome
  {
    let detached = 0;
    let primary = 0;
    const page = {
      _client() {
        primary += 1;
        return { send: async () => {}, detach: async () => { throw new Error("must_not_detach_primary"); } };
      },
      target() {
        return {
          async createCDPSession() {
            return {
              send: async () => {},
              detach: async () => { detached += 1; }
            };
          }
        };
      }
    };
    const ok = await faxina.withEphemeralCdpSession(page, async (s) => {
      check("ephemeral_got_session", !!(s && typeof s.send === "function"));
      return "ok";
    });
    check("ephemeral_ok_value", ok === "ok");
    check("ephemeral_ok_detached", detached === 1, detached);
    check("ephemeral_skips_primary", primary === 0, primary);

    let boomDetached = 0;
    const boomTarget = {
      async createCDPSession() {
        return { detach: async () => { boomDetached += 1; } };
      }
    };
    let threw = false;
    try {
      await faxina.withEphemeralCdpSession(boomTarget, async () => { throw new Error("boom"); });
    } catch (e) {
      threw = String(e && e.message) === "boom";
    }
    check("ephemeral_throw_reraises", threw);
    check("ephemeral_throw_detached", boomDetached === 1, boomDetached);
    const none = await faxina.withEphemeralCdpSession(null, async () => "x");
    check("ephemeral_null_target", none == null);

    const pulse = require("../scripts/winHandlePulse.js");
    const uv = pulse.uvHandleCount();
    check("handle_pulse_uv_number", uv == null || (Number.isFinite(uv) && uv >= 0), uv);
  }

  // 16) nurse/ensureWorking não atropela Robe nem a janela faxina→virtus
  {
    const { classifyEnsureWorking } = require("../scripts/ensureWorking.js");
    const base = {
      wantActive: true,
      wantVirtus: "on",
      browserConnected: true,
      trabalhando: true,
      virtusOnline: false,
      flags: {}
    };
    check("ensure_robe_busy_skip", classifyEnsureWorking({ ...base, robeBusy: true }).reason === "robe_busy");
    check("ensure_faxina_hold_skip", classifyEnsureWorking({ ...base, faxinaHold: true }).reason === "faxina_hold");
    check("ensure_still_reconciles", classifyEnsureWorking(base).reason === "trabalhando_without_virtus");
  }

  {
    const { execFileSync } = require("child_process");
    const path = require("path");
    execFileSync(process.execPath, [path.join(__dirname, "_verify_standby_sweep.js")], { stdio: "inherit" });
    check("standby_sweep_unit", true);
    execFileSync(process.execPath, [path.join(__dirname, "_verify_porteiro_nomem.js")], { stdio: "inherit" });
    check("porteiro_nomem_unit", true);
    execFileSync(process.execPath, [path.join(__dirname, "_verify_ws_shrink.js")], { stdio: "inherit" });
    check("ws_shrink_unit", true);
  }

  if (fail) {
    console.error("FAIL_COUNT", fail);
    process.exit(1);
  }
  console.log("ALL_OK");
  process.exit(0);
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
