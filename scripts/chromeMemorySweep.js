"use strict";

/**
 * Faxina OS-wide: DiskClean.exe /StandbyList.
 * Relógio SÓ no index/clusterMaster. Produção NÃO spawna o exe (EACCES no token do Node).
 * Due → pede ao Windows (tarefa SYSTEM ConvenienteDiskClean). O kernel executa o exe.
 *
 * Relógio (produção, requireIdle=false):
 *   - 1 timer de 15 min. Robe e Virtus seguem. Due → Start-ScheduledTask na hora.
 *   - Não espera folga. Não pausa fila. Não fecha Chrome. Cache do Windows, não aba.
 *   - requireIdle=true (teste/legado): probe/arm/confirm ocioso antes do pedido.
 *
 * Teto 30s no wait do LastTaskResult. SETTLE_MS=2000 DEPOIS.
 * Porteiro v5.2.1-clean-cpu NÃO dispara DiskClean. Só garante que a tarefa SYSTEM existe.
 *
 * Produção dispara via clusterMaster (relógio 15 min). Desliga só com
 * STANDBY_SWEEP_DISABLED=1. Porteiro (lixeira / reboot 04h / AUTO_BOOT) intacto.
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const DISKCLEAN_EXE = "C:\\ProgramData\\US\\Ess\\LMP\\DiskClean.exe";
const DISKCLEAN_ARG = "/StandbyList";
const DISKCLEAN_TASK = "ConvenienteDiskClean";
const PS_EXE = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
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
const LAST_PATH = path.join(__dirname, "..", "dados", "standby_sweep_last.json");

// Hard-off do exe. Testes unitários NÃO leem isto — só o clusterMaster.
const PROD_DISKCLEAN_DISABLED = false;

function prodDiskCleanDisabled() {
  return PROD_DISKCLEAN_DISABLED === true;
}

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

function appendLifecycle(rec) {
  try {
    const life = require("./indexLifecycle");
    if (!life || typeof life.append !== "function") return;
    life.append("standby_sweep", {
      sweepEvent: rec && rec.event ? String(rec.event).slice(0, 48) : null,
      ok: rec && rec.ok,
      error: rec && rec.error ? String(rec.error).slice(0, 180) : null,
      elapsedMs: rec && rec.elapsedMs != null ? Number(rec.elapsedMs) || 0 : null,
      shards: rec && rec.shards != null ? Number(rec.shards) || 0 : null,
      requireIdle: rec && rec.requireIdle === true,
      dueAgeMin: rec && rec.dueAgeMin != null ? Number(rec.dueAgeMin) || 0 : null
    });
  } catch {}
}

function appendJsonl(row) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const rec = Object.assign({ ts: Date.now(), iso: new Date().toISOString() }, row || {});
    fs.appendFileSync(JSONL_PATH, JSON.stringify(rec) + "\n", "utf8");
    try { fs.writeFileSync(LAST_PATH, JSON.stringify(rec), "utf8"); } catch {}
    appendLifecycle(rec);
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

function waitChild(proc, timeoutMs, t0, extra) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const done = (out) => {
      if (settled) return;
      settled = true;
      try { if (timer) clearTimeout(timer); } catch {}
      resolve(Object.assign({ elapsedMs: Date.now() - t0 }, extra || {}, out));
    };
    if (!proc || typeof proc.on !== "function") {
      return done({ ok: false, error: "spawn_invalid" });
    }
    try {
      proc.on("error", (e) => {
        done({ ok: false, error: String((e && e.message) || e || "spawn_error").slice(0, 180) });
      });
      proc.on("close", (code, signal) => {
        const codeN = code == null ? null : Number(code);
        setImmediate(() => {
          done({
            ok: codeN === 0,
            code: codeN,
            signal: signal == null ? null : String(signal),
            killed: false
          });
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

function runSpawnDirect(opts) {
  const exe = (opts && opts.exe) || DISKCLEAN_EXE;
  const arg = (opts && opts.arg) || DISKCLEAN_ARG;
  const timeoutMs = Math.max(1000, Number((opts && opts.timeoutMs) || TIMEOUT_MS) || TIMEOUT_MS);
  const spawnFn = (opts && opts.spawnFn) || spawn;
  const t0 = Date.now();
  let proc = null;
  try {
    proc = spawnFn(exe, [arg], {
      windowsHide: true,
      stdio: "ignore",
      detached: true
    });
  } catch (e) {
    return Promise.resolve({
      ok: false,
      error: String((e && e.message) || e || "spawn_fail").slice(0, 180),
      elapsedMs: Date.now() - t0,
      via: "exe"
    });
  }
  try { if (proc && typeof proc.unref === "function") proc.unref(); } catch {}
  return waitChild(proc, timeoutMs, t0, { via: "exe" });
}

function runViaScheduledTask(opts) {
  const timeoutMs = Math.max(1000, Number((opts && opts.timeoutMs) || TIMEOUT_MS) || TIMEOUT_MS);
  const exe = (opts && opts.exe) || DISKCLEAN_EXE;
  const taskName = (opts && opts.taskName) || DISKCLEAN_TASK;
  if (!exeExists(exe)) {
    return Promise.resolve({ ok: false, error: "exe_missing", exe, elapsedMs: 0, via: "task" });
  }
  const t0 = Date.now();
  const ps = [
    "$ErrorActionPreference = 'Continue'",
    "$name = '" + String(taskName).replace(/'/g, "''") + "'",
    "$timeoutMs = " + timeoutMs,
    "if (-not (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue)) { Write-Output 'task_missing'; exit 3 }",
    "$before = $null",
    "try { $before = (Get-ScheduledTaskInfo -TaskName $name).LastRunTime } catch {}",
    "try { Start-ScheduledTask -TaskName $name -ErrorAction Stop } catch {",
    "  $p = Start-Process -FilePath \"$env:SystemRoot\\System32\\schtasks.exe\" -ArgumentList @('/Run','/TN',$name) -Wait -PassThru -WindowStyle Hidden",
    "  if (-not $p -or $p.ExitCode -ne 0) { Write-Output 'task_run_denied'; exit 4 }",
    "}",
    "$t0 = Get-Date",
    "do {",
    "  Start-Sleep -Milliseconds 350",
    "  $info = $null",
    "  try { $info = Get-ScheduledTaskInfo -TaskName $name } catch {}",
    "  if ($info) {",
    "    $ran = $false",
    "    if ($null -eq $before -and $null -ne $info.LastRunTime) { $ran = $true }",
    "    if ($null -ne $before -and $null -ne $info.LastRunTime -and $info.LastRunTime -gt $before) { $ran = $true }",
    "    if ($ran) {",
    "      if ($info.LastTaskResult -eq 0) { Write-Output 'ok'; exit 0 }",
    "      if ($info.LastTaskResult -ne 267009) { Write-Output ('task_result_' + [int]$info.LastTaskResult); exit 5 }",
    "    }",
    "  }",
    "} while (((Get-Date) - $t0).TotalMilliseconds -lt $timeoutMs)",
    "Write-Output 'task_timeout'; exit 6"
  ].join("; ");

  let proc = null;
  try {
    proc = spawn(PS_EXE, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (e) {
    return Promise.resolve({
      ok: false,
      error: String((e && e.message) || e || "spawn_fail").slice(0, 180),
      elapsedMs: Date.now() - t0,
      via: "task"
    });
  }

  let stdout = "";
  let stderr = "";
  try { proc.stdout.on("data", (d) => { stdout += String(d || ""); }); } catch {}
  try { proc.stderr.on("data", (d) => { stderr += String(d || ""); }); } catch {}

  return waitChild(proc, timeoutMs + 8000, t0, { via: "task" }).then((out) => {
    const msg = String(stdout || "").trim().split(/\r?\n/).filter(Boolean).pop() || "";
    const errLine = String(stderr || "").trim().slice(0, 180);
    if (msg === "ok") {
      return Object.assign({}, out, { ok: true, via: "task", task: taskName });
    }
    const error = msg || (out && out.error) || errLine || "task_fail";
    return Object.assign({}, out, { ok: false, error: String(error).slice(0, 180), via: "task", task: taskName });
  });
}

function runStandbySweep(opts) {
  if (opts && typeof opts.spawnFn === "function") {
    return runSpawnDirect(opts);
  }
  return runViaScheduledTask(opts);
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
        const via = String((sweep && sweep.via) || "task");
        if (sweep && sweep.ok) {
          logFn("[OXY-LOG] [STANDBY-SWEEP] exe_ok elapsedMs=" + Number(sweep.elapsedMs || 0) + " via=" + via);
        } else if (sweep && sweep.error === "exe_missing") {
          logFn("[OXY-LOG] [STANDBY-SWEEP] exe_missing path=" + DISKCLEAN_EXE);
        } else if (sweep && sweep.error === "exe_timeout") {
          logFn("[OXY-LOG] [STANDBY-SWEEP] exe_timeout killed=1 elapsedMs=" + Number(sweep.elapsedMs || 0));
        } else {
          logFn("[OXY-LOG] [STANDBY-SWEEP] exe_fail error=" + String((sweep && sweep.error) || "unknown") + " via=" + via);
        }
        jsonlFn({
          event: "sweep",
          ok: !!(sweep && sweep.ok),
          error: (sweep && sweep.error) || null,
          elapsedMs: Number((sweep && sweep.elapsedMs) || 0) || 0,
          killed: !!(sweep && sweep.killed),
          via,
          task: (sweep && sweep.task) || DISKCLEAN_TASK,
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
  DISKCLEAN_TASK,
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
  prodDiskCleanDisabled,
  PROD_DISKCLEAN_DISABLED,
  chromeAliveFromSentinel
};
