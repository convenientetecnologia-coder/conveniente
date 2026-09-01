"use strict";

/**
 * Faxina OS-wide: DiskClean.exe /StandbyList.
 * Roda SÓ no processo index/clusterMaster. Um spawn por host. Zero CPU/RAM. Zero CDP.
 *
 * Relógio (produção, requireIdle=false):
 *   - 1 timer de 15 min. Robe e Virtus seguem. Due → DiskClean /StandbyList na hora.
 *   - Não espera folga. Não pausa fila. Não fecha Chrome. Cache do Windows, não aba.
 *   - requireIdle=true (teste/legado): probe/arm/confirm ocioso antes do exe.
 *
 * Exe (dono > auditor 12s fixos):
 *   - Espera o processo terminar de verdade (2s, 10s, 15s: tanto faz).
 *   - Teto de segurança 30s + kill se travar. SETTLE_MS=2000 DEPOIS do exe.
 *
 * NÃO lê métricas de sistema (CPU, RAM livre, load). Gatilho = relógio + ociosidade.
 *
 * Porteiro v5.2.0-nomem NÃO dispara DiskClean. Este módulo é o dono único no host.
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const DISKCLEAN_EXE = "C:\\ProgramData\\US\\Ess\\LMP\\DiskClean.exe";
const DISKCLEAN_ARG = "/StandbyList";
const SETTLE_MS = Math.max(0, Number(process.env.STANDBY_SWEEP_SETTLE_MS || 2000) || 2000);
const TIMEOUT_MS = Math.max(
  5000,
  Math.min(120000, Number(process.env.STANDBY_SWEEP_TIMEOUT_MS || 30000) || 30000)
);
const MIN_INTERVAL_MS = Math.max(
  60_000,
  Number(process.env.STANDBY_SWEEP_MIN_MS || (15 * 60 * 1000)) || (15 * 60 * 1000)
);
const LOG_DIR = path.join(__dirname, "..", "dados", "logs");
const JSONL_PATH = path.join(LOG_DIR, "standby_sweep.jsonl");

function envDisabled() {
  return String(process.env.STANDBY_SWEEP_DISABLED || "").trim() === "1";
}

function chromeAliveFromSentinel(filePath) {
  const p = filePath || path.join(__dirname, "..", "dados", "process_sentinel_state.json");
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    const n = Number(j && j.counts && j.counts.chrome && j.counts.chrome.count);
    if (!Number.isFinite(n)) return true;
    return n > 0;
  } catch {
    return true;
  }
}

function oxyLog(line) {
  try { console.log(String(line)); } catch {}
}

function appendJsonl(row) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const rec = Object.assign({ ts: Date.now(), iso: new Date().toISOString() }, row || {});
    fs.appendFileSync(JSONL_PATH, JSON.stringify(rec) + "\n", "utf8");
  } catch {}
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function settle(ms) {
  return sleep(ms == null ? SETTLE_MS : ms);
}

function exeExists(exePath) {
  try { return fs.existsSync(exePath || DISKCLEAN_EXE); } catch { return false; }
}

function runStandbySweep(opts) {
  const exe = (opts && opts.exe) || DISKCLEAN_EXE;
  const arg = (opts && opts.arg) || DISKCLEAN_ARG;
  const timeoutMs = Math.max(1000, Number((opts && opts.timeoutMs) || TIMEOUT_MS) || TIMEOUT_MS);
  const spawnFn = (opts && opts.spawnFn) || spawn;

  if (!(opts && opts.spawnFn) && !exeExists(exe)) {
    return Promise.resolve({ ok: false, error: "exe_missing", exe, elapsedMs: 0 });
  }

  const t0 = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    let proc = null;
    let timer = null;
    const done = (out) => {
      if (settled) return;
      settled = true;
      try { if (timer) clearTimeout(timer); } catch {}
      resolve(Object.assign({ elapsedMs: Date.now() - t0 }, out));
    };
    try {
      proc = spawnFn(exe, [arg], {
        windowsHide: true,
        stdio: "ignore",
        detached: true
      });
    } catch (e) {
      return done({ ok: false, error: String((e && e.message) || e || "spawn_fail").slice(0, 180) });
    }
    if (!proc || typeof proc.on !== "function") {
      return done({ ok: false, error: "spawn_invalid" });
    }
    try { if (typeof proc.unref === "function") proc.unref(); } catch {}
    try {
      proc.on("error", (e) => {
        done({ ok: false, error: String((e && e.message) || e || "spawn_error").slice(0, 180) });
      });
      proc.on("close", (code, signal) => {
        const codeN = code == null ? null : Number(code);
        done({
          ok: codeN === 0,
          code: codeN,
          signal: signal == null ? null : String(signal),
          killed: false
        });
      });
    } catch (e) {
      return done({ ok: false, error: String((e && e.message) || e || "spawn_listen_fail").slice(0, 180) });
    }
    timer = setTimeout(() => {
      try { if (proc && typeof proc.kill === "function") proc.kill(); } catch {}
      done({ ok: false, error: "exe_timeout", killed: true, timeoutMs });
    }, timeoutMs);
  });
}

function collectBusy(results) {
  const reasons = [];
  let allIdle = true;
  const list = Array.isArray(results) ? results : [];
  for (let i = 0; i < list.length; i++) {
    const r = list[i] || {};
    if (!r || r.ok === false) {
      allIdle = false;
      reasons.push("shard_" + i + ":" + String((r && r.error) || "probe_fail"));
      continue;
    }
    if (r.busy === true) {
      allIdle = false;
      const rs = Array.isArray(r.reasons) && r.reasons.length ? r.reasons.join(",") : "busy";
      reasons.push("shard_" + i + ":" + rs);
    }
  }
  return { allIdle, reasons, shards: list.length };
}

function armFailed(results) {
  const list = Array.isArray(results) ? results : [];
  if (!list.length) return true;
  return list.some((r) => !r || r.ok === false);
}

function busyNeedsStitch(reasons) {
  const s = (Array.isArray(reasons) ? reasons : []).join(" ");
  return /\brobe_exec\b|\bdelta_inflight\b|\bdelta_queue_running\b|\bdelta_queue\b|\bsend_lock\b|\bgate_inflight\b|\bcity_collect_bg\b|\bvirtus_starting\b/.test(s);
}

function attachHostCoordinator(opts) {
  const sendToAll = opts && opts.sendToAll;
  const shardCount = opts && opts.shardCount;
  const nowFn = (opts && opts.now) || (() => Date.now());
  const runSweep = (opts && opts.runSweep) || runStandbySweep;
  const settleFn = (opts && opts.settle) || settle;
  const minInterval = Math.max(1, Number((opts && opts.minIntervalMs) || MIN_INTERVAL_MS) || MIN_INTERVAL_MS);
  const disabled = envDisabled() || !!(opts && opts.disabled);
  const requireIdle = opts && opts.requireIdle === true;
  const logFn = (opts && opts.log) || oxyLog;
  const jsonlFn = (opts && opts.jsonl) || appendJsonl;
  const chromeAliveFn = opts && opts.chromeAlive;

  let lastOkAt = nowFn();
  let dueTimer = null;
  let busyRetryTimer = null;
  let hintDebounce = null;
  let inFlight = false;
  let waitingIdle = false;
  let hostArmed = false;
  let busyRetryMs = 15_000;
  let failStreak = 0;
  let stopped = false;

  function clearTimers() {
    try { if (dueTimer) clearTimeout(dueTimer); } catch {}
    try { if (busyRetryTimer) clearTimeout(busyRetryTimer); } catch {}
    try { if (hintDebounce) clearTimeout(hintDebounce); } catch {}
    dueTimer = null;
    busyRetryTimer = null;
    hintDebounce = null;
  }

  function ageMin() {
    return Math.max(0, Math.round((nowFn() - lastOkAt) / 60000));
  }

  function dueAgeMs() {
    return Math.max(0, nowFn() - lastOkAt);
  }

  function unrefTimer(t) {
    try { if (t && typeof t.unref === "function") t.unref(); } catch {}
    return t;
  }

  function scheduleDue() {
    if (stopped || disabled) return;
    try { if (dueTimer) clearTimeout(dueTimer); } catch {}
    const wait = Math.max(250, lastOkAt + minInterval - nowFn());
    dueTimer = unrefTimer(setTimeout(() => {
      dueTimer = null;
      tryAttempt("due_timer");
    }, wait));
  }

  function scheduleBusyRetry() {
    if (stopped || disabled) return;
    waitingIdle = true;
    try { if (busyRetryTimer) clearTimeout(busyRetryTimer); } catch {}
    const wait = busyRetryMs;
    busyRetryMs = Math.min(60_000, Math.max(15_000, Math.floor(busyRetryMs * 1.5)));
    busyRetryTimer = unrefTimer(setTimeout(() => {
      busyRetryTimer = null;
      tryAttempt("busy_retry");
    }, wait));
  }

  async function broadcast(type, payload, timeoutMs) {
    if (typeof sendToAll !== "function") return [];
    return sendToAll(type, payload || {}, timeoutMs || 8000);
  }

  async function releaseAll(extra) {
    try {
      await broadcast("standby-sweep-release", extra || {}, 8000);
    } catch {}
  }

  async function ensureArmed(shards) {
    const results = await broadcast("standby-sweep-arm", { reason: "arm" }, 8000);
    if (armFailed(results)) return false;
    if (!hostArmed) {
      hostArmed = true;
      logFn("[OXY-LOG] [ESTEIRA-TRAVADA] Pausando fila para faxina preventiva. shards=" + shards + " dueAgeMin=" + ageMin());
      jsonlFn({ event: "arm", dueAgeMin: ageMin(), shards });
    }
    return true;
  }

  async function releaseHost(reason, extra) {
    await releaseAll(Object.assign({ reason: reason || "release" }, extra || {}));
    hostArmed = false;
    waitingIdle = false;
  }

  async function tryAttempt(reason) {
    if (stopped || disabled || inFlight) return { skipped: true, reason: "inflight_or_stopped" };
    if (dueAgeMs() < minInterval) {
      waitingIdle = false;
      scheduleDue();
      return { skipped: true, reason: "not_due" };
    }
    inFlight = true;
    const shards = typeof shardCount === "function" ? Number(shardCount()) || 0 : 0;
    try {
      if (shards < 1) {
        jsonlFn({ event: "skip_no_shards", reason });
        lastOkAt = nowFn();
        scheduleDue();
        return { skipped: true, reason: "no_shards" };
      }

      async function executeSweep() {
        logFn("[OXY-LOG] [STANDBY-SWEEP] spawn exe=" + DISKCLEAN_ARG + " timeoutMs=" + TIMEOUT_MS);
        const sweep = await runSweep();
        if (sweep && sweep.ok) {
          logFn("[OXY-LOG] [STANDBY-SWEEP] exe_ok elapsedMs=" + Number(sweep.elapsedMs || 0));
        } else if (sweep && sweep.error === "exe_missing") {
          logFn("[OXY-LOG] [STANDBY-SWEEP] exe_missing path=" + DISKCLEAN_EXE);
        } else if (sweep && sweep.error === "exe_timeout") {
          logFn("[OXY-LOG] [STANDBY-SWEEP] exe_timeout killed=1 elapsedMs=" + Number(sweep.elapsedMs || 0));
        } else {
          logFn("[OXY-LOG] [STANDBY-SWEEP] exe_fail error=" + String((sweep && sweep.error) || "unknown"));
        }
        jsonlFn({
          event: "sweep",
          ok: !!(sweep && sweep.ok),
          error: (sweep && sweep.error) || null,
          elapsedMs: Number((sweep && sweep.elapsedMs) || 0) || 0,
          killed: !!(sweep && sweep.killed),
          dueAgeMin: ageMin(),
          shards,
          requireIdle
        });
        if (!(sweep && sweep.error === "exe_missing")) {
          await settleFn(SETTLE_MS);
        }
        return sweep;
      }

      function rearmClock() {
        failStreak = 0;
        lastOkAt = nowFn();
        waitingIdle = false;
        busyRetryMs = 15_000;
        try { if (busyRetryTimer) clearTimeout(busyRetryTimer); } catch {}
        busyRetryTimer = null;
        scheduleDue();
      }

      if (!requireIdle) {
        const sweep = await executeSweep();
        const sweepOk = !!(sweep && sweep.ok);
        jsonlFn({ event: "clock_done", ok: sweepOk, settleMs: SETTLE_MS, shards });
        if (sweepOk || (sweep && sweep.error === "exe_missing")) {
          rearmClock();
          return { ok: sweepOk, sweep };
        }
        failStreak += 1;
        if (failStreak >= 2) {
          logFn("[OXY-LOG] [STANDBY-SWEEP] exe_fail_give_up nextDueMin=15");
          jsonlFn({ event: "exe_fail_give_up", error: (sweep && sweep.error) || "fail", shards });
          rearmClock();
          return { ok: false, sweep, retried: true };
        }
        busyRetryMs = 30_000;
        logFn("[OXY-LOG] [STANDBY-SWEEP] exe_fail_retry waitMs=30000");
        jsonlFn({ event: "exe_fail_retry", error: (sweep && sweep.error) || "fail", shards });
        scheduleBusyRetry();
        return { ok: false, sweep, retry: true };
      }

      if (typeof chromeAliveFn === "function") {
        let chromeAlive = true;
        try { chromeAlive = chromeAliveFn() === true; } catch { chromeAlive = true; }
        if (chromeAlive) {
          jsonlFn({ event: "skip_chrome_alive", reason, dueAgeMin: ageMin(), shards });
          logFn("[OXY-LOG] [STANDBY-SWEEP] skip_chrome_alive dueAgeMin=" + ageMin() + " shards=" + shards);
          lastOkAt = nowFn();
          waitingIdle = false;
          scheduleDue();
          return { skipped: true, reason: "chrome_alive", armed: false };
        }
      }

      const probe = collectBusy(await broadcast("standby-sweep-probe", { reason: "probe" }, 8000));
      if (!probe.allIdle) {
        jsonlFn({ event: "waiting_idle", reason, dueAgeMin: ageMin(), reasons: probe.reasons, shards: probe.shards, armed: false });
        logFn("[OXY-LOG] [STANDBY-SWEEP] waiting_idle no_arm dueAgeMin=" + ageMin() + " reasons=" + probe.reasons.join("|"));
        waitingIdle = true;
        scheduleBusyRetry();
        return { skipped: true, reason: "waiting_idle", reasons: probe.reasons, armed: false };
      }

      if (!await ensureArmed(shards)) {
        jsonlFn({ event: "abort_arm", reason, dueAgeMin: ageMin(), reasons: probe.reasons });
        logFn("[OXY-LOG] [STANDBY-SWEEP] abort_arm dueAgeMin=" + ageMin());
        await releaseHost("abort_arm");
        scheduleBusyRetry();
        return { skipped: true, reason: "abort_arm" };
      }

      const confirm = collectBusy(await broadcast("standby-sweep-probe", { reason: "confirm" }, 8000));
      if (!confirm.allIdle) {
        jsonlFn({ event: "skip_race", reason, dueAgeMin: ageMin(), reasons: confirm.reasons });
        logFn("[OXY-LOG] [STANDBY-SWEEP] skip_race reasons=" + confirm.reasons.join("|"));
        await releaseHost("skip_race");
        waitingIdle = true;
        scheduleBusyRetry();
        return { skipped: true, reason: "skip_race", reasons: confirm.reasons };
      }

      waitingIdle = false;
      busyRetryMs = 15_000;
      try { if (busyRetryTimer) clearTimeout(busyRetryTimer); } catch {}
      busyRetryTimer = null;

      const sweep = await executeSweep();
      const sweepOk = !!(sweep && sweep.ok);
      await releaseHost("release", { sweepOk });
      if (sweepOk) {
        logFn("[OXY-LOG] [ESTEIRA-LIBERADA] RAM limpa com sucesso. Retomando fluxo. settleMs=" + SETTLE_MS);
      } else {
        logFn("[OXY-LOG] [ESTEIRA-LIBERADA] Retomando fluxo. settleMs=" + SETTLE_MS);
      }
      jsonlFn({ event: "release", ok: sweepOk, settleMs: SETTLE_MS, shards });

      if (sweepOk || (sweep && sweep.error === "exe_missing")) {
        rearmClock();
        return { ok: sweepOk, sweep };
      }

      failStreak += 1;
      if (failStreak >= 2) {
        logFn("[OXY-LOG] [STANDBY-SWEEP] exe_fail_give_up nextDueMin=15");
        jsonlFn({ event: "exe_fail_give_up", error: (sweep && sweep.error) || "fail", shards });
        rearmClock();
        return { ok: false, sweep, retried: true };
      }

      busyRetryMs = 30_000;
      logFn("[OXY-LOG] [STANDBY-SWEEP] exe_fail_retry waitMs=30000");
      jsonlFn({ event: "exe_fail_retry", error: (sweep && sweep.error) || "fail", shards });
      scheduleBusyRetry();
      return { ok: false, sweep, retry: true };
    } catch (e) {
      try { await releaseHost("exception"); } catch {}
      jsonlFn({ event: "exception", error: String((e && e.message) || e || "fail").slice(0, 180) });
      scheduleBusyRetry();
      return { ok: false, error: String((e && e.message) || e) };
    } finally {
      inFlight = false;
    }
  }

  function idleHint() {
    if (stopped || disabled || inFlight || !waitingIdle) return;
    try { if (hintDebounce) clearTimeout(hintDebounce); } catch {}
    hintDebounce = unrefTimer(setTimeout(() => {
      hintDebounce = null;
      tryAttempt("idle_hint");
    }, 300));
  }

  if (!disabled) scheduleDue();

  return {
    stop() {
      stopped = true;
      waitingIdle = false;
      inFlight = false;
      hostArmed = false;
      clearTimers();
    },
    idleHint,
    scheduleDue,
    tryAttempt,
    _test: {
      get lastOkAt() { return lastOkAt; },
      set lastOkAt(v) { lastOkAt = v; },
      get waitingIdle() { return waitingIdle; },
      set waitingIdle(v) { waitingIdle = !!v; },
      get inFlight() { return inFlight; },
      get hostArmed() { return hostArmed; },
      get minInterval() { return minInterval; },
      dueWaitMs() { return Math.max(250, lastOkAt + minInterval - nowFn()); }
    }
  };
}

module.exports = {
  DISKCLEAN_EXE,
  DISKCLEAN_ARG,
  SETTLE_MS,
  TIMEOUT_MS,
  MIN_INTERVAL_MS,
  JSONL_PATH,
  exeExists,
  runStandbySweep,
  settle,
  appendJsonl,
  oxyLog,
  collectBusy,
  busyNeedsStitch,
  attachHostCoordinator,
  envDisabled,
  chromeAliveFromSentinel
};
