"use strict";

/**
 * Encolhedor nativo do Chrome browser process (rootPid).
 *
 * Alvo: EmptyWorkingSet(OpenProcess(rootPid)).
 * Não é HeapProfiler. Não é DiskClean/StandbyList. Não é binding FFI.
 * Não é PID de aba (Puppeteer v24 não expõe page.process()).
 *
 * Chamada: spawn async de powershell.exe. NUNCA filho síncrono no worker
 * (congelaria o laço de eventos do shard e o ouvido Delta).
 *
 * Não mata Chrome, não fecha aba, não dispara kill de árvore, não fecha o browser.
 */

const { spawn } = require("child_process");

const BOOT_SETTLE_MS = Math.max(
  0,
  Number(process.env.EMPTY_WORKING_SET_BOOT_SETTLE_MS || 30_000) || 30_000
);
const TIMEOUT_MS = Math.max(
  3000,
  Math.min(30_000, Number(process.env.EMPTY_WORKING_SET_TIMEOUT_MS || 12_000) || 12_000)
);
const LANE_ACQUIRE_MS = Math.max(
  1000,
  Math.min(30_000, Number(process.env.EMPTY_WORKING_SET_LANE_ACQUIRE_MS || 8000) || 8000)
);

const PROCESS_QUERY_INFORMATION = 0x0400;
const PROCESS_SET_QUOTA = 0x0100;
const OPEN_PROCESS_ACCESS = PROCESS_QUERY_INFORMATION | PROCESS_SET_QUOTA; // 0x500

function envDisabled() {
  return String(process.env.EMPTY_WORKING_SET_DISABLED || "").trim() === "1";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function parseRootPid(v) {
  if (typeof v === "number") {
    if (!Number.isInteger(v) || v <= 0 || v > 0x7fffffff) return 0;
    return v;
  }
  const s = String(v == null ? "" : v).trim();
  if (!/^[1-9]\d{0,9}$/.test(s)) return 0;
  const n = Number(s);
  if (!Number.isInteger(n) || n <= 0 || n > 0x7fffffff) return 0;
  return n;
}

function processAlive(pid) {
  const n = parseRootPid(pid);
  if (!n) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    const code = String((e && e.code) || "");
    if (code === "EPERM" || code === "EACCES" || code === "ACCESS_DENIED") return true;
    return false;
  }
}

function resolveRootPid(browser, fallback) {
  try {
    const proc = browser && typeof browser.process === "function" ? browser.process() : null;
    const n = parseRootPid(proc && proc.pid);
    if (n) return n;
  } catch {}
  return parseRootPid(fallback);
}

function isBootInterlockReleased(page) {
  try {
    const st = page && page.__deltaBootInterlock;
    if (!st) return true;
    if (st.released === true && st.active !== true) return true;
    return false;
  } catch {
    return false;
  }
}

function pageBlocksShrink(page) {
  if (!page) return false;
  try {
    if (page.__virtusDeltaReplyInFlight) return true;
  } catch {}
  try {
    if (page.__oxyCrashed) return true;
  } catch {}
  return false;
}

function browserConnected(browser) {
  if (!browser) return false;
  try {
    if (typeof browser.isConnected === "function") return browser.isConnected() === true;
  } catch {
    return false;
  }
  return true;
}

function accountLabel(nome) {
  const s = String(nome || "").trim();
  return s || "?";
}

function logShrinkBoot(nome) {
  try {
    console.log(
      `[OXY-LOG] [SHRINK-BOOT] Conta ${accountLabel(nome)} estabilizada. RAM de inicialização encolhida no rootPid.`
    );
  } catch {}
}

function logShrinkRobe(nome) {
  try {
    console.log(
      `[OXY-LOG] [SHRINK-ROBE] Aba 1 descartada. Pó de postagem limpo no rootPid.`
    );
  } catch {}
}

function buildPsCommand(pid) {
  const n = parseRootPid(pid);
  if (!n) return "";
  return [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -TypeDefinition @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "public static class ConvenienteEmptyWS {",
    "  [DllImport(\"psapi.dll\", SetLastError=true)]",
    "  public static extern bool EmptyWorkingSet(IntPtr hProcess);",
    "  [DllImport(\"kernel32.dll\", SetLastError=true)]",
    "  public static extern IntPtr OpenProcess(uint a, bool inherit, int pid);",
    "  [DllImport(\"kernel32.dll\", SetLastError=true)]",
    "  public static extern bool CloseHandle(IntPtr h);",
    "}",
    "'@",
    `$h = [ConvenienteEmptyWS]::OpenProcess([uint32]${OPEN_PROCESS_ACCESS}, $false, ${n})`,
    "if ($h -eq [IntPtr]::Zero) { exit 2 }",
    "try {",
    "  if (-not [ConvenienteEmptyWS]::EmptyWorkingSet($h)) { exit 3 }",
    "} finally {",
    "  [void][ConvenienteEmptyWS]::CloseHandle($h)",
    "}",
    "exit 0"
  ].join("\n");
}

function encodePsCommand(script) {
  return Buffer.from(String(script || ""), "utf16le").toString("base64");
}

function emptyWorkingSetPid(pid, opts) {
  const n = parseRootPid(pid);
  const timeoutMs = Math.max(1000, Number((opts && opts.timeoutMs) || TIMEOUT_MS) || TIMEOUT_MS);
  const spawnFn = (opts && opts.spawnFn) || spawn;

  if (!n) {
    return Promise.resolve({ ok: false, skipped: true, reason: "bad_pid", pid: 0, elapsedMs: 0 });
  }
  if (envDisabled()) {
    return Promise.resolve({ ok: false, skipped: true, reason: "disabled", pid: n, elapsedMs: 0 });
  }
  if (!(opts && opts.spawnFn) && process.platform !== "win32") {
    return Promise.resolve({ ok: false, skipped: true, reason: "not_win32", pid: n, elapsedMs: 0 });
  }
  if (!(opts && opts.spawnFn) && !processAlive(n)) {
    return Promise.resolve({ ok: false, skipped: true, reason: "pid_dead", pid: n, elapsedMs: 0 });
  }

  const script = buildPsCommand(n);
  const encoded = encodePsCommand(script);
  const args = [
    "-NoProfile",
    "-NonInteractive",
    "-WindowStyle",
    "Hidden",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    encoded
  ];
  const t0 = Date.now();

  return new Promise((resolve) => {
    let settled = false;
    let proc = null;
    let timer = null;
    const done = (out) => {
      if (settled) return;
      settled = true;
      try { if (timer) clearTimeout(timer); } catch {}
      resolve(Object.assign({ pid: n, elapsedMs: Date.now() - t0 }, out));
    };
    try {
      proc = spawnFn("powershell.exe", args, {
        windowsHide: true,
        stdio: "ignore"
      });
    } catch (e) {
      return done({
        ok: false,
        error: String((e && e.message) || e || "spawn_fail").slice(0, 180)
      });
    }
    if (!proc || typeof proc.on !== "function") {
      return done({ ok: false, error: "spawn_invalid" });
    }
    try {
      proc.on("error", (e) => {
        done({
          ok: false,
          error: String((e && e.message) || e || "spawn_error").slice(0, 180)
        });
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
      return done({
        ok: false,
        error: String((e && e.message) || e || "spawn_listen_fail").slice(0, 180)
      });
    }
    timer = setTimeout(() => {
      try { if (proc && typeof proc.kill === "function") proc.kill(); } catch {}
      done({ ok: false, error: "exe_timeout", killed: true, timeoutMs });
    }, timeoutMs);
  });
}

function bootPredicatesMet({ bootStableOk, earReadyOk, page, alreadyShrunkPid, pid } = {}) {
  if (bootStableOk !== true) return { ok: false, reason: "boot_not_stable" };
  if (earReadyOk !== true) return { ok: false, reason: "ear_not_ready" };
  if (!isBootInterlockReleased(page)) return { ok: false, reason: "interlock_held" };
  const n = parseRootPid(pid);
  if (!n) return { ok: false, reason: "bad_pid" };
  const prev = parseRootPid(alreadyShrunkPid);
  if (prev && prev === n) return { ok: false, reason: "already_shrunk_pid" };
  return { ok: true, pid: n };
}

function punchAbortReason({ page, browser, pid, isEarReady, requireEar, skipAliveCheck } = {}) {
  const n = parseRootPid(pid);
  if (!n) return "bad_pid";
  if (!skipAliveCheck && process.platform === "win32" && !processAlive(n)) return "pid_dead";
  if (!isBootInterlockReleased(page)) return "interlock_held";
  if (pageBlocksShrink(page)) return "page_busy";
  if (requireEar) {
    try {
      if (page && typeof page.isClosed === "function" && page.isClosed()) return "page_closed";
    } catch {
      return "page_closed";
    }
  }
  if (browser && !browserConnected(browser)) return "browser_dead";
  if (requireEar) {
    if (typeof isEarReady !== "function") return "ear_fn_missing";
    try {
      if (isEarReady() !== true) return "ear_not_ready";
    } catch {
      return "ear_throw";
    }
  }
  return null;
}

async function withHoldLane(holdLane, fn) {
  if (typeof holdLane !== "function") return await fn();
  try {
    return await holdLane(fn);
  } catch (e) {
    const msg = String((e && e.message) || e || "");
    if (/connect_lane_acquire_timeout/i.test(msg)) {
      return await fn();
    }
    return { ok: false, skipped: true, reason: "hold_lane" };
  }
}

async function shrinkBootGate(opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const nome = String(o.nome || "");
  const settleMs = o.settleMs == null ? BOOT_SETTLE_MS : Math.max(0, Number(o.settleMs) || 0);
  const pid = resolveRootPid(o.browser, o.rootPid);
  const pred = bootPredicatesMet({
    bootStableOk: o.bootStableOk,
    earReadyOk: o.earReadyOk,
    page: o.page,
    alreadyShrunkPid: o.alreadyShrunkPid,
    pid
  });
  if (!pred.ok) {
    return { ok: false, skipped: true, reason: pred.reason, pid };
  }
  if (envDisabled()) {
    return { ok: false, skipped: true, reason: "disabled", pid };
  }

  return await withHoldLane(o.holdLane, async () => {
    if (settleMs > 0) {
      const sleepFn = typeof o.sleepFn === "function" ? o.sleepFn : sleep;
      const step = 500;
      let left = settleMs;
      while (left > 0) {
        if (typeof o.shouldAbortSettle === "function") {
          try {
            if (o.shouldAbortSettle() === true) {
              return { ok: false, skipped: true, reason: "abort_settle", pid };
            }
          } catch {}
        }
        const chunk = Math.min(step, left);
        await sleepFn(chunk);
        left -= chunk;
      }
    }
    if (typeof o.shouldAbortSettle === "function") {
      try {
        if (o.shouldAbortSettle() === true) {
          return { ok: false, skipped: true, reason: "abort_settle", pid };
        }
      } catch {}
    }
    const abort = punchAbortReason({
      page: o.page,
      browser: o.browser,
      pid,
      isEarReady: o.isEarReady,
      requireEar: true,
      skipAliveCheck: typeof o.spawnFn === "function"
    });
    if (abort) {
      return { ok: false, skipped: true, reason: abort, pid };
    }
    const livePid = resolveRootPid(o.browser, pid);
    if (livePid !== pid) {
      return { ok: false, skipped: true, reason: "pid_changed", pid };
    }
    const out = await emptyWorkingSetPid(pid, {
      spawnFn: o.spawnFn,
      timeoutMs: o.timeoutMs
    });
    if (out && out.ok === true) {
      logShrinkBoot(nome);
      return Object.assign({ ok: true, skipped: false, reason: "ok", gate: "boot" }, out);
    }
    return Object.assign({ ok: false, skipped: false, reason: (out && (out.reason || out.error)) || "punch_fail", gate: "boot" }, out || {});
  });
}

async function shrinkRobeGate(opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const nome = String(o.nome || "");
  const pid = resolveRootPid(o.browser, o.rootPid);
  if (!parseRootPid(pid)) {
    return { ok: false, skipped: true, reason: "bad_pid", pid: 0 };
  }
  if (envDisabled()) {
    return { ok: false, skipped: true, reason: "disabled", pid };
  }
  if (o.browser && !browserConnected(o.browser)) {
    return { ok: false, skipped: true, reason: "browser_dead", pid };
  }
  if (pageBlocksShrink(o.page)) {
    return { ok: false, skipped: true, reason: "page_busy", pid };
  }
  if (process.platform === "win32" && !(o && o.spawnFn) && !processAlive(pid)) {
    return { ok: false, skipped: true, reason: "pid_dead", pid };
  }
  const out = await emptyWorkingSetPid(pid, {
    spawnFn: o.spawnFn,
    timeoutMs: o.timeoutMs
  });
  if (out && out.ok === true) {
    logShrinkRobe(nome);
    return Object.assign({ ok: true, skipped: false, reason: "ok", gate: "robe" }, out);
  }
  return Object.assign({ ok: false, skipped: false, reason: (out && (out.reason || out.error)) || "punch_fail", gate: "robe" }, out || {});
}

module.exports = {
  BOOT_SETTLE_MS,
  TIMEOUT_MS,
  LANE_ACQUIRE_MS,
  OPEN_PROCESS_ACCESS,
  envDisabled,
  parseRootPid,
  processAlive,
  resolveRootPid,
  isBootInterlockReleased,
  pageBlocksShrink,
  bootPredicatesMet,
  buildPsCommand,
  encodePsCommand,
  emptyWorkingSetPid,
  shrinkBootGate,
  shrinkRobeGate,
  logShrinkBoot,
  logShrinkRobe
};
